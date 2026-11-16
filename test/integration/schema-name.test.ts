import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemory, type Embedder, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { main } from "../../src/cli/main.js";
import { MIGRATIONS } from "../../src/db/migrations/bundled.js";
import {
	MIGRATION_LOCK_KEY,
	splitStatements,
} from "../../src/db/migrations/runner.js";
import { createTestIo, type TestIo } from "../cli/io.js";
import { expectMnemocyteError } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const NAMES = MIGRATIONS.map((migration) => migration.name);

// Schemas this file creates and drops. Like cli.test.ts, it drops the
// Mnemocyte tables in public before each test and leaves a tracked
// 1536-dimension schema there for the other integration files.
const MOVED = "mnemocyte_it_moved";
const FRESH = "mnemocyte_it_fresh";
const PRINTED = "mnemocyte_it_printed";
const SCHEMAS = [MOVED, FRESH, PRINTED];

const sql = postgres(databaseUrl ?? "postgres://unused", {
	max: 2,
	onnotice() {},
});

const embedder: Embedder = {
	model: "schema-name-integration",
	dimensions: 3,
	async embed(texts) {
		return texts.map((text) => [text.length, 1, 0]);
	},
};

const scope = { namespace: "schema-name", entityId: "u" };

async function dropEverything(): Promise<void> {
	await sql.unsafe(
		'DROP TABLE IF EXISTS public."mnemocyte_migrations", public."mnemocyte_events", public."mnemocyte_memories", public."mnemocyte_meta" CASCADE',
	);
	for (const schema of SCHEMAS) {
		await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
	}
}

/**
 * Columns, constraints, indexes and the installation row of the Mnemocyte
 * tables in `schema`, with `schema.` dropped from the definitions, so two
 * installations in different schemas compare equal when they match.
 * Postgres prints the qualifier only for a schema off `search_path`.
 */
async function snapshot(schema: string) {
	const normalize = (text: string | null) =>
		text?.replaceAll(`${schema}.`, "") ?? null;
	const columns = await sql`
		SELECT c.relname AS "table", a.attnum AS "position", a.attname AS "column",
			format_type(a.atttypid, a.atttypmod) AS "type", a.attnotnull AS "notNull",
			a.attgenerated::text AS "generated",
			pg_get_expr(d.adbin, d.adrelid) AS "default"
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE n.nspname = ${schema} AND c.relkind = 'r'
			AND c.relname LIKE 'mnemocyte\\_%' AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY 1, 2`;
	const constraints = await sql`
		SELECT c.relname AS "table", k.conname AS "name", k.contype::text AS "type",
			pg_get_constraintdef(k.oid, true) AS "definition"
		FROM pg_constraint k
		JOIN pg_class c ON c.oid = k.conrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = ${schema} AND c.relname LIKE 'mnemocyte\\_%'
		ORDER BY 1, 2`;
	const indexes = await sql`
		SELECT t.relname AS "table", i.relname AS "name",
			pg_get_indexdef(x.indexrelid) AS "definition"
		FROM pg_index x
		JOIN pg_class t ON t.oid = x.indrelid
		JOIN pg_class i ON i.oid = x.indexrelid
		JOIN pg_namespace n ON n.oid = t.relnamespace
		WHERE n.nspname = ${schema} AND t.relname LIKE 'mnemocyte\\_%'
		ORDER BY 1, 2`;
	const meta = await sql.unsafe(
		`SELECT key, embedding_dimensions, embedding_model, vector_type FROM "${schema}".mnemocyte_meta`,
	);
	return {
		columns: columns.map((row) => ({
			...row,
			default: normalize(row.default),
		})),
		constraints: constraints.map((row) => ({
			...row,
			definition: normalize(row.definition),
		})),
		indexes: indexes.map((row) => ({
			...row,
			definition: normalize(row.definition),
		})),
		meta: meta.map((row) => ({ ...row })),
	};
}

async function tablesIn(schema: string): Promise<string[]> {
	const rows = await sql<{ name: string }[]>`
		SELECT c.relname AS "name" FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = ${schema} AND c.relkind = 'r'
			AND c.relname LIKE 'mnemocyte\\_%'
		ORDER BY 1`;
	return rows.map((row) => row.name);
}

function client(schemaName?: string, connection = sql) {
	return createMemory({
		store: postgresStore({
			client: connection,
			...(schemaName === undefined ? {} : { schemaName }),
		}),
		embedder,
	});
}

describe.skipIf(!databaseUrl)("schemaName on Postgres", () => {
	let cwd: string;

	async function run(argv: string[]): Promise<{ code: number; io: TestIo }> {
		const io = createTestIo(cwd);
		return { code: await main(argv, io, "0.0.0-test"), io };
	}

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-schema-integration-"));
	});

	beforeEach(async () => {
		await sql`CREATE EXTENSION IF NOT EXISTS vector`;
		await dropEverything();
	});

	afterAll(async () => {
		await dropEverything();
		await migrate({ store: sql, dimensions: 1536 });
		await sql.end();
		await rm(cwd, { recursive: true, force: true });
	});

	test("a fresh install in a schema has the catalog of one in public", async () => {
		await migrate({ store: sql, dimensions: 1536 });
		const inPublic = await snapshot("public");
		await dropEverything();

		await expect(
			migrate({
				store: postgresStore({ client: sql, schemaName: FRESH }),
				dimensions: 1536,
			}),
		).resolves.toEqual({
			applied: NAMES,
			adopted: [],
			extensionCreated: false,
			schemaCreated: true,
		});
		expect(await snapshot(FRESH)).toEqual(inPublic);
		const [reference] = await sql`
			SELECT confrelid::regclass::text AS "target" FROM pg_constraint
			WHERE conname = 'mnemocyte_memories_superseded_by_mnemocyte_memories_id_fk'`;
		expect(reference?.target).toBe(`${FRESH}.mnemocyte_memories`);
		expect(await tablesIn("public")).toEqual([]);
	});

	test("concurrent migrates create the schema once", async () => {
		const connections = [1, 2, 3].map(() =>
			postgres(databaseUrl ?? "", { max: 1, onnotice() {} }),
		);
		try {
			const results = await Promise.all(
				connections.map((connection) =>
					migrate({ memory: client(FRESH, connection) }),
				),
			);
			expect(results.filter((result) => result.schemaCreated)).toHaveLength(1);
			expect(results.map((result) => result.applied.length).sort()).toEqual([
				0,
				0,
				NAMES.length,
			]);
		} finally {
			await Promise.all(connections.map((connection) => connection.end()));
		}
		expect(await tablesIn(FRESH)).toEqual([
			"mnemocyte_events",
			"mnemocyte_memories",
			"mnemocyte_meta",
			"mnemocyte_migrations",
		]);
	});

	test("a fresh install refuses while public holds an installation", async () => {
		await migrate({ store: sql, dimensions: 3 });
		await expectMnemocyteError(
			migrate({ memory: client(FRESH) }),
			"CONFIG",
			"INSTALLATION_ELSEWHERE",
		);
		const { code, io } = await run(["migrate", "--schema", FRESH, "--yes"]);
		expect(code).not.toBe(0);
		expect(io.stderr()).toContain("migrate() does not move an installation");
		const schemas =
			await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${FRESH}`;
		expect(schemas).toHaveLength(0);
	});

	test("the move recipe keeps the data and the links; the CLI finds it with --schema", async () => {
		await migrate({ store: sql, dimensions: 3 });
		const before = client();
		const kept = await before.add({ scope, content: "survivor" });
		const merged = await before.add({ scope, content: "merged" });
		await before.consolidate({
			scope,
			survivorId: kept.id,
			supersededIds: [merged.id],
		});

		// The recipe in docs/guide/postgres.md, "Move an existing installation".
		await sql.begin(async (tx) => {
			await tx.unsafe(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
			await tx.unsafe(`CREATE SCHEMA ${MOVED}`);
			for (const table of [
				"mnemocyte_memories",
				"mnemocyte_events",
				"mnemocyte_meta",
				"mnemocyte_migrations",
			]) {
				await tx.unsafe(`ALTER TABLE public.${table} SET SCHEMA ${MOVED}`);
			}
		});

		const checked = await run([
			"check",
			"--schema",
			MOVED,
			"--dimensions",
			"3",
		]);
		expect(checked.code).toBe(0);
		expect(checked.io.stdout()).toContain(`schema      ${MOVED}\n`);
		expect(checked.io.stdout()).toContain("migrations  5 of 5 applied\n");
		const migrated = await run(["migrate", "--schema", MOVED]);
		expect(migrated.code).toBe(0);
		expect(migrated.io.stdout()).toContain("The schema is up to date.");

		const after = client(MOVED);
		const all = await after.list({ scope, includeSuperseded: true });
		expect(all.memories.map((memory) => memory.content).sort()).toEqual([
			"merged",
			"survivor",
		]);
		await expectMnemocyteError(
			after.delete({ scope, id: kept.id }),
			"CONFLICT",
			"HAS_DEPENDENTS",
		);
		await expectMnemocyteError(
			before.list({ scope }),
			"MIGRATION",
			"SCHEMA_MISSING",
		);
	});

	test("the CLI installs into --schema and changes keyword search there", async () => {
		const migrated = await run([
			"migrate",
			"--schema",
			FRESH,
			"--dimensions",
			"3",
			"--yes",
		]);
		expect(migrated.code).toBe(0);
		expect(migrated.io.stdout()).toBe(
			`Using DATABASE_URL\nCreated the schema ${FRESH}.\nApplied: ${NAMES.join(", ")}\n`,
		);

		const checked = await run(["check", "--schema", FRESH, "--json"]);
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.io.stdout())).toMatchObject({
			ok: true,
			installation: { schema: FRESH, dimensions: 3 },
		});

		const memory = client(FRESH);
		await memory.add({ scope, content: "The runners were running" });
		const changed = await run([
			"text-search",
			"simple",
			"--schema",
			FRESH,
			"--yes",
		]);
		expect(changed.code).toBe(0);
		const [column] = await sql.unsafe(
			`SELECT pg_get_expr(d.adbin, d.adrelid) AS "expression"
			FROM pg_attribute a
			JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE a.attrelid = '"${FRESH}".mnemocyte_memories'::regclass
				AND a.attname = 'content_tsv'`,
		);
		expect(column?.expression).toBe(
			"to_tsvector('simple'::regconfig, content)",
		);
		const indexes = await sql`
			SELECT 1 FROM pg_indexes
			WHERE schemaname = ${FRESH}
				AND indexname = 'mnemocyte_memories_content_tsv_idx'`;
		expect(indexes).toHaveLength(1);
		expect(await tablesIn("public")).toEqual([]);
	});

	test("the SQL that sql --schema prints installs into that schema", async () => {
		const printed = await run([
			"sql",
			"--schema",
			PRINTED,
			"--dimensions",
			"3",
		]);
		expect(printed.code).toBe(0);
		// One connection of its own: the script's SET search_path lasts for
		// the session.
		const session = postgres(databaseUrl ?? "", { max: 1, onnotice() {} });
		try {
			for (const statement of splitStatements(printed.io.stdout())) {
				await session.unsafe(statement);
			}
		} finally {
			await session.end();
		}
		expect(await tablesIn(PRINTED)).toEqual([
			"mnemocyte_events",
			"mnemocyte_memories",
			"mnemocyte_meta",
		]);
		expect(await tablesIn("public")).toEqual([]);
		// migrate adopts it like any untracked install.
		await expect(migrate({ memory: client(PRINTED) })).resolves.toEqual({
			applied: [],
			adopted: NAMES,
			extensionCreated: false,
			schemaCreated: false,
		});
	});
});
