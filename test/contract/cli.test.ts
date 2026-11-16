import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory, type Embedder } from "mnemocyte";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliArgs } from "../../src/cli/args.js";
import { checkTarget } from "../../src/cli/check.js";
import { migrateTarget } from "../../src/cli/migrate.js";
import type { MemoryTarget } from "../../src/cli/target.js";
import { textSearchTarget } from "../../src/cli/text-search.js";
import { readMemoryClientInternals } from "../../src/memory/client-internals.js";
import { createTestIo } from "../cli/io.js";

const ALL_MIGRATIONS =
	"0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2, 0004_audit_memory_id";

function embedder(dimensions: number, model = "cli-contract"): Embedder {
	return {
		model,
		dimensions,
		async embed(texts) {
			return texts.map(() =>
				Array.from({ length: dimensions }, (_, index) => (index === 0 ? 1 : 0)),
			);
		},
	};
}

function args(overrides: Partial<CliArgs> = {}): CliArgs {
	return {
		command: "migrate",
		yes: false,
		dryRun: false,
		json: false,
		...overrides,
	};
}

/**
 * `mnemocyte migrate` and `check` against a resolved target, on a PGlite
 * that starts without pgvector enabled: the answers a terminal can give to
 * the extension question, and `check` on the states a database can be in.
 * Loading the memory file and the bin itself are covered by
 * test/package/cli.test.ts.
 */
describe("CLI commands (PGlite)", () => {
	let db: PGlite;

	beforeEach(async () => {
		db = await PGlite.create({ extensions: { vector } });
	});

	afterEach(async () => {
		await db.close();
	});

	function target(dimensions = 8, model?: string): MemoryTarget {
		const configured = embedder(dimensions, model);
		const memory = createMemory({
			namespace: "cli",
			store: db,
			embedder: configured,
		});
		return {
			kind: "memory",
			label: "memory.ts",
			memory,
			store: readMemoryClientInternals(memory).store,
			embedder: configured,
			async close() {},
		};
	}

	async function hasPgvector(): Promise<boolean> {
		const result = await db.query(
			"SELECT 1 FROM pg_extension WHERE extname = 'vector'",
		);
		return result.rows.length > 0;
	}

	async function check(
		checked: MemoryTarget,
		overrides: Partial<CliArgs> = {},
	): Promise<{ code: number; stdout: string }> {
		const io = createTestIo(".");
		const code = await checkTarget(
			checked,
			args({ command: "check", ...overrides }),
			io,
		);
		expect(io.stderr()).toBe("");
		return { code, stdout: io.stdout() };
	}

	/** Standard output as `--json` must print it: exactly one JSON line. */
	function jsonLine(stdout: string): unknown {
		expect(stdout.endsWith("\n")).toBe(true);
		expect(stdout.slice(0, -1)).not.toContain("\n");
		return JSON.parse(stdout);
	}

	test("migrate --dry-run --json prints the plan as one JSON line", async () => {
		const io = createTestIo(".", true);
		expect(
			await migrateTarget(target(), args({ dryRun: true, json: true }), io),
		).toBe(0);
		expect(io.questions).toEqual([]);
		expect(io.stderr()).toBe("");
		expect(jsonLine(io.stdout())).toEqual({
			command: "migrate",
			ok: true,
			dryRun: true,
			target: "memory.ts",
			backend: "postgres",
			applied: ALL_MIGRATIONS.split(", "),
			adopted: [],
			extensionCreated: true,
			upToDate: false,
		});
		expect(await hasPgvector()).toBe(false);

		await migrateTarget(target(), args({ yes: true }), createTestIo("."));
		const current = createTestIo(".");
		await migrateTarget(target(), args({ dryRun: true, json: true }), current);
		expect(jsonLine(current.stdout())).toMatchObject({
			applied: [],
			adopted: [],
			extensionCreated: false,
			upToDate: true,
		});
	});

	test("check --json reports the installation and coded problems", async () => {
		const empty = await check(target(), { json: true });
		expect(empty.code).toBe(1);
		expect(jsonLine(empty.stdout)).toEqual({
			command: "check",
			ok: false,
			target: "memory.ts",
			backend: "postgres",
			installation: {
				pgvectorVersion: null,
				migrations: { state: "none", applied: [], pending: [] },
				dimensions: null,
				vectorType: null,
				model: null,
				textSearchConfig: null,
			},
			problems: [
				{
					code: "PGVECTOR_MISSING",
					message: expect.stringContaining("pgvector is not enabled"),
				},
				{
					code: "NOT_INSTALLED",
					message: expect.stringContaining("tables are not installed"),
				},
			],
			notes: [],
		});

		await migrateTarget(target(), args({ yes: true }), createTestIo("."));
		const fresh = await check(target(), { json: true });
		expect(fresh.code).toBe(0);
		expect(jsonLine(fresh.stdout)).toEqual({
			command: "check",
			ok: true,
			target: "memory.ts",
			backend: "postgres",
			installation: {
				pgvectorVersion: "0.8.7",
				migrations: {
					state: "tracked",
					applied: ALL_MIGRATIONS.split(", "),
					pending: [],
				},
				dimensions: 8,
				vectorType: "vector",
				model: null,
				textSearchConfig: "english",
			},
			problems: [],
			notes: [
				{
					code: "MODEL_NOT_RECORDED",
					message: expect.stringContaining("No embedding model"),
				},
			],
		});

		const flag = await check(target(), { json: true, dimensions: 16 });
		expect(flag.code).toBe(1);
		expect(jsonLine(flag.stdout)).toMatchObject({
			ok: false,
			problems: [
				{ code: "DIMENSIONS_MISMATCH" },
				{ code: "DIMENSIONS_FLAG_MISMATCH" },
			],
		});
	});

	test("migrate --text-search-config sets a fresh install; check compares it", async () => {
		await migrateTarget(
			target(),
			args({ yes: true, textSearchConfig: "simple" }),
			createTestIo("."),
		);
		const ok = await check(target(), { textSearchConfig: "Simple" });
		expect(ok.code).toBe(0);
		expect(ok.stdout).toContain("text search simple\n");
		const differs = await check(target(), {
			textSearchConfig: "english",
			json: true,
		});
		expect(differs.code).toBe(1);
		expect(jsonLine(differs.stdout)).toMatchObject({
			installation: { textSearchConfig: "simple" },
			problems: [
				{
					code: "TEXT_SEARCH_CONFIG_MISMATCH",
					message: expect.stringContaining("mnemocyte text-search english"),
				},
			],
		});
	});

	test("text-search asks before the rewrite, and --yes, --dry-run and --json skip the question", async () => {
		await migrateTarget(target(), args({ yes: true }), createTestIo("."));
		const textSearch = (overrides: Partial<CliArgs> = {}) =>
			args({
				command: "text-search",
				textSearchConfig: "simple",
				...overrides,
			});

		const plan = createTestIo(".", true);
		expect(
			await textSearchTarget(
				target(),
				textSearch({ dryRun: true, json: true }),
				plan,
			),
		).toBe(0);
		expect(plan.questions).toEqual([]);
		expect(jsonLine(plan.stdout())).toEqual({
			command: "text-search",
			ok: true,
			dryRun: true,
			target: "memory.ts",
			backend: "postgres",
			previous: "english",
			current: "simple",
			changed: true,
		});

		const dry = createTestIo(".", true);
		expect(
			await textSearchTarget(target(), textSearch({ dryRun: true }), dry),
		).toBe(0);
		expect(dry.stdout()).toContain(
			'Would change keyword search from "english" to "simple".',
		);

		const no = createTestIo(".", false);
		expect(await textSearchTarget(target(), textSearch(), no)).toBe(1);
		expect(no.questions).toHaveLength(1);
		expect(no.questions[0]).toContain("rebuilds every index");
		expect(no.stderr()).toBe("Nothing changed.\n");

		const noTerminal = createTestIo(".", undefined);
		expect(await textSearchTarget(target(), textSearch(), noTerminal)).toBe(1);
		expect(noTerminal.stderr()).toContain("Pass --yes");
		expect((await check(target())).stdout).toContain("text search english\n");

		const yes = createTestIo(".", true);
		expect(await textSearchTarget(target(), textSearch(), yes)).toBe(0);
		expect(yes.stdout()).toBe(
			'Using memory.ts\nChanged keyword search from "english" to "simple". Restart other app processes so their keyword search uses it.\n',
		);
		expect((await check(target())).stdout).toContain("text search simple\n");

		const again = createTestIo(".", false);
		expect(
			await textSearchTarget(target(), textSearch({ yes: true }), again),
		).toBe(0);
		expect(again.questions).toEqual([]);
		expect(again.stdout()).toBe(
			'Using memory.ts\nKeyword search already uses the "simple" text search configuration.\n',
		);
	});

	test("asks before enabling pgvector, and a yes installs the schema", async () => {
		const io = createTestIo(".", true);
		expect(await migrateTarget(target(), args(), io)).toBe(0);
		expect(io.questions).toEqual([
			"pgvector is not enabled in this database. Run CREATE EXTENSION vector now? [y/N] ",
		]);
		expect(io.stdout()).toBe(
			`Using memory.ts\nEnabled pgvector.\nApplied: ${ALL_MIGRATIONS}\n`,
		);
		expect(io.stderr()).toBe("");
		expect(await hasPgvector()).toBe(true);

		// Nothing is missing now, so nothing is asked.
		const again = createTestIo(".", false);
		expect(await migrateTarget(target(), args(), again)).toBe(0);
		expect(again.questions).toEqual([]);
		expect(again.stdout()).toBe("Using memory.ts\nThe schema is up to date.\n");
	});

	test("a no changes nothing and prints the statement for an admin", async () => {
		const io = createTestIo(".", false);
		expect(await migrateTarget(target(), args(), io)).toBe(1);
		expect(io.questions).toHaveLength(1);
		expect(io.stderr()).toBe(
			"pgvector was not enabled. To enable it, have a database admin run:\n\n  CREATE EXTENSION IF NOT EXISTS vector;\n\nthen run mnemocyte migrate again.\n",
		);
		expect(await hasPgvector()).toBe(false);
		expect((await check(target())).stdout).toContain(
			"migrations  not installed",
		);
	});

	test("without a terminal it does not wait, and names --yes", async () => {
		const io = createTestIo(".", undefined);
		expect(await migrateTarget(target(), args(), io)).toBe(1);
		expect(io.stderr()).toContain(
			"there is no terminal to ask on. Pass --yes to enable it, or have a database admin run:",
		);
		expect(await hasPgvector()).toBe(false);
	});

	test("--yes enables pgvector without asking", async () => {
		const io = createTestIo(".", false);
		expect(await migrateTarget(target(), args({ yes: true }), io)).toBe(0);
		expect(io.questions).toEqual([]);
		expect(io.stdout()).toContain("Enabled pgvector.");
		expect(await hasPgvector()).toBe(true);
	});

	test("--dry-run reports the plan, asks nothing and changes nothing", async () => {
		const io = createTestIo(".", true);
		expect(await migrateTarget(target(), args({ dryRun: true }), io)).toBe(0);
		expect(io.questions).toEqual([]);
		expect(io.stdout()).toBe(
			`Using memory.ts\nWould enable pgvector (CREATE EXTENSION vector), after asking.\nWould apply: ${ALL_MIGRATIONS}\n`,
		);
		expect(await hasPgvector()).toBe(false);
	});

	test("with pgvector already enabled, migrate asks nothing", async () => {
		await db.exec("CREATE EXTENSION vector;");
		const io = createTestIo(".", false);
		expect(await migrateTarget(target(), args(), io)).toBe(0);
		expect(io.questions).toEqual([]);
		expect(io.stdout()).toBe(`Using memory.ts\nApplied: ${ALL_MIGRATIONS}\n`);
	});

	test("--dimensions that differs from the embedder's fails before any change", async () => {
		const io = createTestIo(".", true);
		await expect(
			migrateTarget(target(), args({ dimensions: 16 }), io),
		).rejects.toMatchObject({ code: "CONFIG" });
		expect(io.questions).toEqual([]);
		expect(await hasPgvector()).toBe(false);
	});

	test("check passes on a fresh install and reports what it found", async () => {
		await migrateTarget(target(), args({ yes: true }), createTestIo("."));
		const fresh = await check(target());
		expect(fresh.code).toBe(0);
		expect(fresh.stdout).toBe(
			[
				"Using memory.ts",
				"pgvector    0.8.7",
				"migrations  5 of 5 applied",
				"dimensions  8 (vector)",
				"model       not recorded yet",
				"text search english",
				"",
				"note: No embedding model is recorded yet; the first add or search records the embedder's.",
				"ok",
				"",
			].join("\n"),
		);

		// The first add records the model; another embedder then fails.
		const client = createMemory({
			namespace: "cli",
			store: db,
			embedder: embedder(8),
		});
		await client.add({
			scope: { entityId: "user" },
			content: "Prefers short answers.",
		});
		const recorded = await check(target());
		expect(recorded.code).toBe(0);
		expect(recorded.stdout).toContain("model       cli-contract");
		expect(recorded.stdout).not.toContain("note:");

		const otherModel = await check(target(8, "another-model"));
		expect(otherModel.code).toBe(1);
		expect(otherModel.stdout).toContain(
			'problem: The installation\'s embedding model is "cli-contract", but the embedder\'s is "another-model".',
		);

		const otherSize = await check(target(16));
		expect(otherSize.code).toBe(1);
		expect(otherSize.stdout).toContain(
			"problem: The installation stores 8-dimension embeddings, but the embedder has 16 dimensions.",
		);

		const flag = await check(target(), { dimensions: 16 });
		expect(flag.code).toBe(1);
		expect(flag.stdout).toContain("2 problems found");
		expect(flag.stdout).toContain(
			"problem: The installation stores 8-dimension embeddings, but --dimensions is 16.",
		);
		expect(flag.stdout).toContain(
			"problem: --dimensions is 16, but the embedder in memory.ts has 8 dimensions.",
		);
	});

	test("check fails on a schema that is behind, and passes once it is adopted", async () => {
		await db.exec("CREATE EXTENSION vector;");
		for (const file of [
			"0000_initial.sql",
			"0001_add_mnemocyte_meta.sql",
			"0002_add_embedding_model.sql",
		]) {
			await db.exec(await readFile(resolve("migrations", file), "utf8"));
		}
		const behind = await check(target(1536));
		expect(behind.code).toBe(1);
		expect(behind.stdout).toContain(
			"migrations  3 of 5 applied, pending: 0003_schema_v2, 0004_audit_memory_id (not recorded)",
		);
		expect(behind.stdout).toContain(
			"problem: 2 migrations are pending (0003_schema_v2, 0004_audit_memory_id). Run mnemocyte migrate.",
		);

		const io = createTestIo(".");
		expect(await migrateTarget(target(1536), args(), io)).toBe(0);
		expect(io.stdout()).toBe(
			"Using memory.ts\nRecorded as already applied: 0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model\nApplied: 0003_schema_v2, 0004_audit_memory_id\n",
		);
		expect((await check(target(1536))).code).toBe(0);
	});

	test("check passes with a note on a current schema installed without migrate", async () => {
		await db.exec("CREATE EXTENSION vector;");
		await db.exec(
			await readFile(resolve("migrations", "fresh-install.sql"), "utf8"),
		);
		const untracked = await check(target(1536));
		expect(untracked.code).toBe(0);
		expect(untracked.stdout).toContain(
			"migrations  5 of 5 applied (not recorded)",
		);
		expect(untracked.stdout).toContain(
			"note: The schema was installed without migrate",
		);
	});

	test("check fails on a schema migrate refuses and on a missing installation row", async () => {
		await migrateTarget(target(), args({ yes: true }), createTestIo("."));
		await db.exec("DELETE FROM mnemocyte_meta;");
		const noRow = await check(target());
		expect(noRow.code).toBe(1);
		expect(noRow.stdout).toContain(
			'problem: mnemocyte_meta has no "installation" row',
		);

		await db.exec("DROP TABLE mnemocyte_meta;");
		const dropped = await check(target());
		expect(dropped.code).toBe(1);
		expect(dropped.stdout).toContain("migrations  invalid");
		expect(dropped.stdout).toContain(
			"problem: mnemocyte_migrations records every migration, but a Mnemocyte table or column is missing.",
		);

		await db.exec("DROP TABLE mnemocyte_migrations;");
		const partial = await check(target());
		expect(partial.code).toBe(1);
		expect(partial.stdout).toContain(
			"problem: The Mnemocyte tables match no migration",
		);
	});
});
