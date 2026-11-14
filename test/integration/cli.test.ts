import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "mnemocyte";
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
import { createTestIo, type TestIo } from "../cli/io.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const ALL_MIGRATIONS =
	"0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2";

// Like migrate.test.ts, these tests commit: each one drops the Mnemocyte
// tables first, and the file leaves a tracked 1536-dimension schema behind
// for the other integration files.
const sql = postgres(databaseUrl ?? "postgres://unused", {
	max: 2,
	onnotice() {},
});

async function dropMnemocyteTables(): Promise<void> {
	await sql.unsafe(
		'DROP TABLE IF EXISTS "mnemocyte_migrations", "mnemocyte_events", "mnemocyte_memories", "mnemocyte_meta" CASCADE',
	);
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
		expect(checked.io.stdout()).toContain("migrations  4 of 4 applied");
		expect(checked.io.stdout()).toContain("dimensions  768 (vector)");
		expect(checked.io.stdout().trimEnd().endsWith("ok")).toBe(true);

		const mismatch = await run(["check", "--dimensions", "1536"]);
		expect(mismatch.code).toBe(1);
		expect(mismatch.io.stdout()).toContain(
			"problem: The installation stores 768-dimension embeddings, but the embedder has 1536 dimensions.",
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

			const migrated = await run(["migrate", "--dimensions", "768"]);
			expect(migrated.code).toBe(1);
			expect(migrated.io.stderr()).toContain("cause:");
		} finally {
			process.env.DATABASE_URL = original;
		}
	});
});
