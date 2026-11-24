import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createMemory, migrate } from "mnemocyte";
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
import type { SqlExecutor } from "../../src/sql/executor.js";
import { postgresJs } from "../../src/sql/postgres-js.js";
import { createTestIo, type TestIo } from "../cli/io.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const ALL_MIGRATIONS =
	"0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2, 0004_audit_memory_id";

// Like migrate.test.ts, these tests commit: each one drops the Mnemocyte
// tables first, and the file leaves a tracked 1536-dimension schema behind
// for the other integration files.
const sql = postgres(databaseUrl ?? "postgres://unused", {
	max: 2,
	onnotice() {},
});

const PUBLIC_TABLES_DROP =
	'DROP TABLE IF EXISTS "mnemocyte_migrations", "mnemocyte_events", "mnemocyte_memories", "mnemocyte_meta" CASCADE';

async function dropMnemocyteTables(): Promise<void> {
	await sql.unsafe(PUBLIC_TABLES_DROP);
}

async function hasPgvector(): Promise<boolean> {
	const rows = await sql`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
	return rows.length > 0;
}

/**
 * The CLI without a memory file: it connects to `DATABASE_URL` with the
 * `postgres` package it resolves itself (the installed 4.x, whatever
 * `POSTGRES_JS` aliases for the other files) and closes that connection.
 * Run in process through `main`, in an empty folder, so no memory file and
 * no `.env` is picked up.
 */
describe.skipIf(!databaseUrl)("CLI on Postgres through DATABASE_URL", () => {
	let cwd: string;

	async function run(
		argv: string[],
		answer?: boolean,
	): Promise<{ code: number; io: TestIo }> {
		const io = createTestIo(cwd, answer);
		return { code: await main(argv, io, "0.0.0-test"), io };
	}

	beforeAll(async () => {
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-integration-"));
	});

	beforeEach(async () => {
		await sql`CREATE EXTENSION IF NOT EXISTS vector`;
		await dropMnemocyteTables();
	});

	afterAll(async () => {
		await sql`CREATE EXTENSION IF NOT EXISTS vector`;
		await dropMnemocyteTables();
		await migrate({ store: sql, dimensions: 1536 });
		await sql.end();
		await rm(cwd, { recursive: true, force: true });
	});

	test("check fails on an empty database", async () => {
		const { code, io } = await run(["check"]);
		expect(io.stderr()).toBe("");
		expect(code).toBe(1);
		expect(io.stdout()).toContain("Using DATABASE_URL");
		expect(io.stdout()).toMatch(/pgvector {4}0\.8\.\d+/);
		expect(io.stdout()).toContain("migrations  not installed");
		expect(io.stdout()).toContain(
			"problem: Mnemocyte's tables are not installed. Run mnemocyte migrate.",
		);
	});

	test("a fresh install needs --dimensions", async () => {
		const { code, io } = await run(["migrate"]);
		expect(code).toBe(2);
		expect(io.stderr()).toContain(
			"This database has no Mnemocyte tables yet. Pass --dimensions <n>",
		);
		expect((await run(["check"])).io.stdout()).toContain(
			"migrations  not installed",
		);
	});

	test("migrate installs, check passes, and a later migrate needs no --dimensions", async () => {
		const plan = await run(["migrate", "--dimensions", "768", "--dry-run"]);
		expect(plan.code).toBe(0);
		expect(plan.io.stdout()).toBe(
			`Using DATABASE_URL\nWould apply: ${ALL_MIGRATIONS}\n`,
		);
		expect((await run(["check"])).io.stdout()).toContain(
			"migrations  not installed",
		);

		const installed = await run(["migrate", "--dimensions", "768"]);
		expect(installed.io.stderr()).toBe("");
		expect(installed.code).toBe(0);
		expect(installed.io.stdout()).toBe(
			`Using DATABASE_URL\nApplied: ${ALL_MIGRATIONS}\n`,
		);

		const checked = await run(["check"]);
		expect(checked.code).toBe(0);
		expect(checked.io.stdout()).toContain("migrations  5 of 5 applied");
		expect(checked.io.stdout()).toContain("dimensions  768 (vector)");
		expect(checked.io.stdout().trimEnd().endsWith("ok")).toBe(true);

		const mismatch = await run(["check", "--dimensions", "1536"]);
		expect(mismatch.code).toBe(1);
		expect(mismatch.io.stdout()).toContain(
			"problem: The installation stores 768-dimension embeddings, but --dimensions is 1536.",
		);

		const again = await run(["migrate"]);
		expect(again.code).toBe(0);
		expect(again.io.stdout()).toBe(
			"Using DATABASE_URL\nThe schema is up to date.\n",
		);

		const wrongSize = await run(["migrate", "--dimensions", "1536"]);
		expect(wrongSize.code).toBe(1);
		expect(wrongSize.io.stderr()).toContain(
			"The installation stores 768-dimension embeddings",
		);
	});

	test("halfvec above 2,000 dimensions", async () => {
		expect((await run(["migrate", "--dimensions", "3072"])).code).toBe(0);
		const checked = await run(["check", "--dimensions", "3072"]);
		expect(checked.code).toBe(0);
		expect(checked.io.stdout()).toContain("dimensions  3072 (halfvec)");
	});

	test("asks before CREATE EXTENSION, and --yes or a yes runs it", async () => {
		await sql`DROP EXTENSION vector`;

		const noTerminal = await run(["migrate", "--dimensions", "768"]);
		expect(noTerminal.code).toBe(1);
		expect(noTerminal.io.questions).toHaveLength(1);
		expect(noTerminal.io.stderr()).toContain(
			"CREATE EXTENSION IF NOT EXISTS vector;",
		);
		expect(await hasPgvector()).toBe(false);

		const refused = await run(["migrate", "--dimensions", "768"], false);
		expect(refused.code).toBe(1);
		expect(refused.io.stderr()).toContain("pgvector was not enabled.");
		expect(await hasPgvector()).toBe(false);

		const checked = await run(["check"]);
		expect(checked.code).toBe(1);
		expect(checked.io.stdout()).toContain("pgvector    not enabled");
		expect(checked.io.stdout()).toContain("2 problems found");

		const dryRun = await run(["migrate", "--dimensions", "768", "--dry-run"]);
		expect(dryRun.io.questions).toEqual([]);
		expect(dryRun.io.stdout()).toContain("Would enable pgvector");
		expect(await hasPgvector()).toBe(false);

		const accepted = await run(["migrate", "--dimensions", "768"], true);
		expect(accepted.io.stderr()).toBe("");
		expect(accepted.code).toBe(0);
		expect(accepted.io.stdout()).toBe(
			`Using DATABASE_URL\nEnabled pgvector.\nApplied: ${ALL_MIGRATIONS}\n`,
		);
		expect(await hasPgvector()).toBe(true);

		await dropMnemocyteTables();
		await sql`DROP EXTENSION vector`;
		const yes = await run(["migrate", "--dimensions", "768", "--yes"], false);
		expect(yes.code).toBe(0);
		expect(yes.io.questions).toEqual([]);
		expect(yes.io.stdout()).toContain("Enabled pgvector.");
	});

	test("a database that cannot be reached: check exits 2, migrate 1", async () => {
		const original = process.env.DATABASE_URL;
		// Port 1 on localhost refuses connections.
		process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/none";
		try {
			const checked = await run(["check"]);
			expect(checked.code).toBe(2);
			expect(checked.io.stderr()).toContain(
				"mnemocyte: Could not read the database, so nothing was checked.",
			);
			expect(checked.io.stderr()).toContain("cause:");
			expect(checked.io.stderr()).not.toContain("postgres:postgres@");

			const json = await run(["check", "--json"]);
			expect(json.code).toBe(2);
			const result = JSON.parse(json.io.stdout()) as {
				error: { causes: string[] };
			};
			expect(result).toMatchObject({
				command: "check",
				ok: false,
				error: {
					message: "Could not read the database, so nothing was checked.",
				},
			});
			expect(result.error.causes.length).toBeGreaterThan(0);
			expect(json.io.stdout()).not.toContain("postgres:postgres@");

			const migrated = await run(["migrate", "--dimensions", "768"]);
			expect(migrated.code).toBe(1);
			expect(migrated.io.stderr()).toContain("cause:");
		} finally {
			process.env.DATABASE_URL = original;
		}
	});
});

/** postgres.js without `transaction`, as a stateless HTTP driver is. */
function batchOnly(inner: SqlExecutor): SqlExecutor {
	return {
		query: (text, params, options) => inner.query(text, params, options),
		...(inner.batch ? { batch: inner.batch.bind(inner) } : {}),
	};
}

/**
 * A memory file whose store is a `batch`-only `SqlExecutor`: `migrate` and
 * `text-search` connect on `DATABASE_URL` with the `postgres` package and
 * the file's dimensions and schema (ARCHITECTURE decision 77). The file
 * takes its client from `globalThis`, so it imports nothing. Everything
 * goes into a schema of its own, dropped at the end.
 */
describe.skipIf(!databaseUrl)("CLI with a batch-only memory file", () => {
	const schemaName = "mnemocyte_cli_direct";
	const key = "__mnemocyteCliDirectMemory";
	let cwd: string;
	let appSql: postgres.Sql;

	beforeAll(async () => {
		// The app's own connection: the file's shared one ends with the
		// describe above.
		appSql = postgres(databaseUrl ?? "", { max: 2, onnotice() {} });
		await appSql`CREATE EXTENSION IF NOT EXISTS vector`;
		await appSql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
		// A schemaName install refuses while public holds one.
		await appSql.unsafe(PUBLIC_TABLES_DROP);
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-direct-"));
		await writeFile(
			join(cwd, "memory.mjs"),
			`export const memory = globalThis.${key};\n`,
		);
		(globalThis as Record<string, unknown>)[key] = createMemory({
			store: postgresStore({
				client: batchOnly(postgresJs(appSql)),
				schemaName,
			}),
			embedder: {
				model: "cli-direct",
				dimensions: 384,
				async embed(texts) {
					return texts.map(() => Array.from({ length: 384 }, () => 0.1));
				},
			},
		});
	});

	afterAll(async () => {
		delete (globalThis as Record<string, unknown>)[key];
		await appSql.unsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
		// Leave public as the describe above does, for the other files.
		await migrate({ store: appSql, dimensions: 1536 });
		await appSql.end();
		await rm(cwd, { recursive: true, force: true });
	});

	async function run(argv: string[]): Promise<{ code: number; io: TestIo }> {
		const io = createTestIo(cwd);
		return { code: await main(argv, io, "0.0.0-test"), io };
	}

	test("migrate, check and text-search over DATABASE_URL", async () => {
		const migrated = await run(["migrate"]);
		expect(migrated.io.stderr()).toBe("");
		expect(migrated.code).toBe(0);
		expect(migrated.io.stdout()).toBe(
			`Using memory.mjs\nConnecting with the "postgres" package on DATABASE_URL: The store in memory.mjs has no interactive transactions (SqlExecutor.transaction), which migrations need.\nCreated the schema ${schemaName}.\nApplied: ${ALL_MIGRATIONS}\n`,
		);
		const columns = await appSql`
			SELECT a.atttypmod AS dimensions
			FROM pg_attribute a
			WHERE a.attrelid = ${`"${schemaName}".mnemocyte_memories`}::regclass
				AND a.attname = 'embedding'`;
		expect(columns[0]?.dimensions).toBe(384);

		const checked = await run(["check"]);
		expect(checked.code).toBe(0);
		expect(checked.io.stdout()).toContain(`schema      ${schemaName}`);

		const changed = await run(["text-search", "simple", "--yes"]);
		expect(changed.io.stderr()).toBe("");
		expect(changed.code).toBe(0);
		expect(changed.io.stdout()).toContain(
			'Changed keyword search from "english" to "simple".',
		);
	});

	test("a database it cannot reach is exit 1, naming the variable and not the URL", async () => {
		const original = process.env.DATABASE_URL;
		process.env.DATABASE_URL = "postgres://postgres:postgres@127.0.0.1:1/none";
		try {
			const { code, io } = await run(["migrate", "--dry-run"]);
			expect(code).toBe(1);
			expect(io.stderr()).toContain(
				"mnemocyte: Connecting over DATABASE_URL failed.",
			);
			expect(io.stderr()).toContain("cause:");
			expect(io.stderr()).not.toContain("postgres:postgres@");
		} finally {
			process.env.DATABASE_URL = original;
		}
	});
});
