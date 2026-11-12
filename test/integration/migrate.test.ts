import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMemory, type Embedder, migrate } from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const ALL_MIGRATIONS = [
	"0000_initial",
	"0001_add_mnemocyte_meta",
	"0002_add_embedding_model",
	"0003_schema_v2",
];

// These tests commit, so they cannot run inside a rolled-back transaction.
// Each one drops the Mnemocyte tables first; the last one leaves a complete,
// tracked schema behind for the other integration files.
const sql = postgres(databaseUrl ?? "postgres://unused", { max: 4 });

async function dropMnemocyteTables(): Promise<void> {
	await sql.unsafe(
		'DROP TABLE IF EXISTS "mnemocyte_migrations", "mnemocyte_events", "mnemocyte_memories", "mnemocyte_meta" CASCADE',
	);
}

async function applyFiles(...files: string[]): Promise<void> {
	for (const file of files) {
		await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
	}
}

async function trackedVersions(): Promise<number[]> {
	const rows = await sql<{ version: number }[]>`
		SELECT version FROM mnemocyte_migrations ORDER BY version
	`;
	return rows.map((row) => row.version);
}

async function embeddingType(): Promise<string | undefined> {
	const [row] = await sql<{ type: string }[]>`
		SELECT pg_catalog.format_type(atttypid, atttypmod) AS "type"
		FROM pg_catalog.pg_attribute
		WHERE attrelid = 'mnemocyte_memories'::regclass AND attname = 'embedding'
	`;
	return row?.type;
}

/** Extensions and every column and index in `public`, to show a run changed nothing. */
async function catalogSnapshot(): Promise<{
	extensions: string[];
	relations: string[];
}> {
	const extensions = await sql<{ name: string }[]>`
		SELECT extname AS name FROM pg_catalog.pg_extension
		WHERE extname <> 'plpgsql' ORDER BY extname
	`;
	const relations = await sql<{ name: string }[]>`
		SELECT c.relname || coalesce('.' || a.attname, '') AS name
		FROM pg_catalog.pg_class c
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_catalog.pg_attribute a
			ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		WHERE n.nspname = 'public'
		ORDER BY 1
	`;
	return {
		extensions: extensions.map((row) => row.name),
		relations: relations.map((row) => row.name),
	};
}

function fakeEmbedder(dimensions: number): Embedder {
	return {
		model: "migrate-test",
		dimensions,
		async embed(texts) {
			return texts.map((text) =>
				Array.from({ length: dimensions }, (_, index) =>
					index === 0 ? text.length : index === 1 ? 1 : 0,
				),
			);
		},
	};
}

const store = postgresStore({ client: postgresJs(sql) });

describe.skipIf(!databaseUrl)("migrate on Postgres", () => {
	beforeEach(async () => {
		await sql`CREATE EXTENSION IF NOT EXISTS vector`;
		await dropMnemocyteTables();
	});

	afterAll(async () => {
		await dropMnemocyteTables();
		await migrate({ store, dimensions: 1536, createExtension: true });
		await sql.end();
	});

	test("installs a working schema at 768 dimensions", async () => {
		const result = await migrate({ store, dimensions: 768 });

		expect(result).toEqual({
			applied: ALL_MIGRATIONS,
			adopted: [],
			extensionCreated: false,
		});
		expect(await trackedVersions()).toEqual([0, 1, 2, 3]);
		expect(await embeddingType()).toBe("vector(768)");

		const client = createMemory({ store, embedder: fakeEmbedder(768) });
		await client.add({
			scope: testScope("migrate_768"),
			content: "Likes tea.",
		});
		const recalled = await client.search({
			scope: testScope("migrate_768"),
			query: "tea",
		});
		expect(recalled.map((memory) => memory.content)).toEqual(["Likes tea."]);
	});

	test("uses halfvec above 2,000 dimensions and checks them later", async () => {
		await migrate({ store, dimensions: 3072 });

		expect(await embeddingType()).toBe("halfvec(3072)");
		const [meta] = await sql<{ vectorType: string; dimensions: number }[]>`
			SELECT vector_type AS "vectorType", embedding_dimensions AS "dimensions"
			FROM mnemocyte_meta
		`;
		expect(meta).toEqual({ vectorType: "halfvec", dimensions: 3072 });

		await expect(migrate({ store, dimensions: 3072 })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
		});
		await expectMnemocyteError(migrate({ store, dimensions: 768 }), "CONFIG");
	});

	test("adopts a 0.5 schema and applies 0003 to its rows", async () => {
		await applyFiles(
			"0000_initial.sql",
			"0001_add_mnemocyte_meta.sql",
			"0002_add_embedding_model.sql",
		);
		await sql`
			INSERT INTO mnemocyte_memories (id, entity_id, content, embedding_model, embedding_dimensions)
			VALUES ('mem_old_1', 'migrate_old', 'Written by 0.5.', 'old-model', 1536)
		`;

		const result = await migrate({ store });

		expect(result).toEqual({
			adopted: ALL_MIGRATIONS.slice(0, 3),
			applied: ["0003_schema_v2"],
			extensionCreated: false,
		});
		const [row] = await sql<{ id: string; namespace: string }[]>`
			SELECT id::text AS id, namespace FROM mnemocyte_memories
		`;
		const [expected] = await sql<{ id: string }[]>`
			SELECT md5('mem_old_1')::uuid::text AS id
		`;
		expect(row).toEqual({ id: expected?.id, namespace: "default" });
		await expect(migrate({ store })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
		});
	});

	test("adopts a schema installed from fresh-install.sql without running anything", async () => {
		await applyFiles("fresh-install.sql");

		await expect(migrate({ store, dimensions: 1536 })).resolves.toEqual({
			applied: [],
			adopted: ALL_MIGRATIONS,
			extensionCreated: false,
		});
		expect(await trackedVersions()).toEqual([0, 1, 2, 3]);
	});

	test("applies each migration once when two callers race", async () => {
		const other = postgres(databaseUrl ?? "", { max: 2 });
		try {
			const otherStore = postgresStore({ client: postgresJs(other) });

			const results = await Promise.all([
				migrate({ store, dimensions: 1536 }),
				migrate({ store: otherStore, dimensions: 1536 }),
			]);

			expect(results.flatMap((result) => result.applied).sort()).toEqual(
				ALL_MIGRATIONS,
			);
			expect(results.flatMap((result) => result.adopted)).toEqual([]);
			expect(await trackedVersions()).toEqual([0, 1, 2, 3]);
		} finally {
			await other.end();
		}
	});

	test("rolls back a failing migration and leaves the earlier ones applied", async () => {
		await applyFiles(
			"0000_initial.sql",
			"0001_add_mnemocyte_meta.sql",
			"0002_add_embedding_model.sql",
		);
		// 0003 drops this index, so the migration fails partway through.
		await sql`DROP INDEX mnemocyte_memories_entity_type_idx`;

		const error = await expectMnemocyteError(migrate({ store }), "MIGRATION");

		expect(error.message).toContain("0003_schema_v2");
		expect(await trackedVersions()).toEqual([0, 1, 2]);
		const [column] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count
			FROM pg_catalog.pg_attribute
			WHERE attrelid = 'mnemocyte_memories'::regclass AND attname = 'namespace'
		`;
		expect(column?.count).toBe(0);
	});

	test("migrate({ memory }) installs at the embedder's dimensions", async () => {
		const memory = createMemory({ store, embedder: fakeEmbedder(384) });

		await expect(migrate({ memory })).resolves.toEqual({
			applied: ALL_MIGRATIONS,
			adopted: [],
			extensionCreated: false,
		});
		expect(await embeddingType()).toBe("vector(384)");
		await expectMnemocyteError(migrate({ memory, dimensions: 768 }), "CONFIG");
	});

	test("createExtension enables pgvector before a fresh install", async () => {
		await sql`DROP EXTENSION vector`;
		const memory = createMemory({ store, embedder: fakeEmbedder(768) });

		await expectMnemocyteError(migrate({ memory }), "MIGRATION");
		await expect(migrate({ memory, createExtension: true })).resolves.toEqual({
			applied: ALL_MIGRATIONS,
			adopted: [],
			extensionCreated: true,
		});
		expect(await embeddingType()).toBe("vector(768)");
	});

	test("two callers with createExtension create pgvector once", async () => {
		await sql`DROP EXTENSION vector`;
		const other = postgres(databaseUrl ?? "", { max: 2 });
		try {
			const otherStore = postgresStore({ client: postgresJs(other) });

			const results = await Promise.all([
				migrate({ store, dimensions: 1536, createExtension: true }),
				migrate({ store: otherStore, dimensions: 1536, createExtension: true }),
			]);

			expect(results.map((result) => result.extensionCreated).sort()).toEqual([
				false,
				true,
			]);
			expect(results.flatMap((result) => result.applied).sort()).toEqual(
				ALL_MIGRATIONS,
			);
		} finally {
			await other.end();
		}
	});

	test("createExtension without the privilege names the admin step and rolls back", async () => {
		await sql`DROP EXTENSION vector`;
		const role = "mnemocyte_restricted_test";
		const password = randomUUID();
		await sql.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
		await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
		await sql.unsafe(
			`CREATE ROLE ${role} LOGIN NOSUPERUSER PASSWORD '${password}'`,
		);
		const url = new URL(databaseUrl ?? "");
		url.username = role;
		url.password = password;
		const database = url.pathname.slice(1) || "postgres";
		await sql.unsafe(`GRANT CREATE ON DATABASE "${database}" TO ${role}`);
		await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA public TO ${role}`);
		const restricted = postgres(url.toString(), { max: 1 });
		const before = await catalogSnapshot();
		try {
			const error = await expectMnemocyteError(
				migrate({
					store: postgresStore({ client: restricted }),
					dimensions: 1536,
					createExtension: true,
				}),
				"MIGRATION",
			);

			expect(error.message).toContain("admin");
			expect(error.cause).toMatchObject({ code: "42501" });
			expect(await catalogSnapshot()).toEqual(before);
		} finally {
			await restricted.end();
			await sql.unsafe(`DROP OWNED BY ${role}`);
			await sql.unsafe(`DROP ROLE ${role}`);
		}
	});

	test("dryRun predicts a fresh install with createExtension and changes nothing", async () => {
		await sql`DROP EXTENSION vector`;
		const memory = createMemory({ store, embedder: fakeEmbedder(1536) });
		const before = await catalogSnapshot();

		const predicted = await migrate({
			memory,
			createExtension: true,
			dryRun: true,
		});

		expect(await catalogSnapshot()).toEqual(before);
		await expect(migrate({ memory, createExtension: true })).resolves.toEqual(
			predicted,
		);
		expect(predicted.extensionCreated).toBe(true);
	});

	test("dryRun predicts adopting a 0.5 schema and changes nothing", async () => {
		await applyFiles(
			"0000_initial.sql",
			"0001_add_mnemocyte_meta.sql",
			"0002_add_embedding_model.sql",
		);
		const before = await catalogSnapshot();

		const predicted = await migrate({ store, dryRun: true });

		expect(predicted).toEqual({
			adopted: ALL_MIGRATIONS.slice(0, 3),
			applied: ["0003_schema_v2"],
			extensionCreated: false,
		});
		expect(await catalogSnapshot()).toEqual(before);
		await expect(migrate({ store })).resolves.toEqual(predicted);
	});
});
