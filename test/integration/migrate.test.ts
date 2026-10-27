import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte, type Embedder, migrate } from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

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
		await migrate({ store, dimensions: 1536 });
		await sql.end();
	});

	test("installs a working schema at 768 dimensions", async () => {
		const result = await migrate({ store, dimensions: 768 });

		expect(result).toEqual({ applied: ALL_MIGRATIONS, adopted: [] });
		expect(await trackedVersions()).toEqual([0, 1, 2, 3]);
		expect(await embeddingType()).toBe("vector(768)");

		const client = createMnemocyte({ store, embedder: fakeEmbedder(768) });
		await client.remember({ entityId: "migrate_768", content: "Likes tea." });
		const recalled = await client.recall({
			entityId: "migrate_768",
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
		});
	});

	test("adopts a schema installed from fresh-install.sql without running anything", async () => {
		await applyFiles("fresh-install.sql");

		await expect(migrate({ store, dimensions: 1536 })).resolves.toEqual({
			applied: [],
			adopted: ALL_MIGRATIONS,
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
});
