import { createMemory, type Embedder } from "mnemocyte";
import { libsqlStore } from "mnemocyte/libsql";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliArgs } from "../../src/cli/args.js";
import { checkTarget } from "../../src/cli/check.js";
import { migrateTarget } from "../../src/cli/migrate.js";
import { assertSchemaFlag, type MemoryTarget } from "../../src/cli/target.js";
import { textSearchTarget } from "../../src/cli/text-search.js";
import { readMemoryClientInternals } from "../../src/memory/client-internals.js";
import { createTestIo } from "../cli/io.js";
import { type LibsqlDatabase, openLibsql } from "./libsql.js";

function embedder(dimensions: number, model = "cli-libsql"): Embedder {
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
 * `mnemocyte migrate`, `check` and `text-search` against a memory file whose
 * store is libSQL. The CLI reaches libSQL only through a memory file;
 * `DATABASE_URL` stays Postgres.
 */
describe("CLI commands (libSQL)", () => {
	let database: LibsqlDatabase;

	beforeEach(async () => {
		database = await openLibsql();
	});

	afterEach(async () => {
		await database.close();
	});

	function target(dimensions = 8, model?: string): MemoryTarget {
		const configured = embedder(dimensions, model);
		const memory = createMemory({
			namespace: "cli",
			store: libsqlStore({ client: database.client }),
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

	test("migrate installs without asking about an extension", async () => {
		const dry = createTestIo(".");
		expect(await migrateTarget(target(), args({ dryRun: true }), dry)).toBe(0);
		expect(dry.questions).toEqual([]);
		expect(dry.stdout()).toContain("0000_initial");

		const io = createTestIo(".", false);
		expect(await migrateTarget(target(), args(), io)).toBe(0);
		expect(io.questions).toEqual([]);
		expect(io.stdout()).toBe("Using memory.ts\nApplied: 0000_initial\n");

		const again = createTestIo(".", false);
		expect(await migrateTarget(target(), args(), again)).toBe(0);
		expect(again.stdout()).toBe("Using memory.ts\nThe schema is up to date.\n");
	});

	test("check reports the libSQL installation and compares it", async () => {
		const missing = await check(target());
		expect(missing.code).toBe(1);
		expect(missing.stdout).toContain("migrations  not installed");
		expect(missing.stdout).not.toContain("pgvector");

		await migrateTarget(target(), args(), createTestIo("."));
		const fresh = await check(target());
		expect(fresh.code).toBe(0);
		expect(fresh.stdout).toMatch(
			new RegExp(
				[
					"Using memory.ts",
					"libsql {6}SQLite 3\\.\\d+\\.\\d+",
					"migrations  1 of 1 applied",
					"dimensions  8 \\(F32_BLOB\\)",
					"model       not recorded yet",
					"text search porter",
					"",
					"note: No embedding model is recorded yet; the first add or search records the embedder's.",
					"ok",
					"",
				].join("\n"),
			),
		);

		const otherSize = await check(target(16));
		expect(otherSize.code).toBe(1);
		expect(otherSize.stdout).toContain(
			"problem: The installation stores 8-dimension embeddings, but the embedder has 16 dimensions.",
		);

		const otherTokenizer = await check(target(), {
			textSearchConfig: "unicode61",
		});
		expect(otherTokenizer.code).toBe(1);
		expect(otherTokenizer.stdout).toContain(
			'problem: Keyword search uses the "porter" tokenizer, but --text-search-config is "unicode61".',
		);

		const json = createTestIo(".");
		expect(
			await checkTarget(target(), args({ command: "check", json: true }), json),
		).toBe(0);
		expect(JSON.parse(json.stdout())).toMatchObject({
			ok: true,
			backend: "libsql",
			installation: {
				schema: null,
				pgvectorVersion: null,
				sqliteVersion: expect.stringMatching(/^3\./),
				dimensions: 8,
				vectorType: "F32_BLOB",
				textSearchConfig: "porter",
			},
		});
	});

	test("text-search rebuilds the keyword index after asking", async () => {
		await migrateTarget(target(), args(), createTestIo("."));
		const declined = createTestIo(".", false);
		expect(
			await textSearchTarget(
				target(),
				args({ command: "text-search", textSearchConfig: "unicode61" }),
				declined,
			),
		).toBe(1);
		expect(declined.questions[0]).toContain("rebuilds the keyword index");
		expect(declined.questions[0]).not.toContain("HNSW");

		const io = createTestIo(".");
		expect(
			await textSearchTarget(
				target(),
				args({
					command: "text-search",
					textSearchConfig: "unicode61",
					yes: true,
				}),
				io,
			),
		).toBe(0);
		expect(io.stdout()).toContain(
			'Changed keyword search from "porter" to "unicode61".',
		);
		expect(io.stdout()).not.toContain("1.2 or later");
	});

	test("--schema is rejected for a libSQL store", () => {
		const { store } = target();
		expect(() => assertSchemaFlag("memory", store, "memory.ts")).toThrow(
			/libSQL/,
		);
		expect(() => assertSchemaFlag(undefined, store, "memory.ts")).not.toThrow();
	});
});
