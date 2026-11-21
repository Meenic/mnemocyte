import { createMemory, type Embedder } from "mnemocyte";
import { defineMemoryStore } from "mnemocyte/store";
import { describe, expect, test } from "vitest";
import type { CliArgs } from "../../src/cli/args.js";
import { checkTarget } from "../../src/cli/check.js";
import { CliError } from "../../src/cli/io.js";
import { migrateTarget } from "../../src/cli/migrate.js";
import { assertSchemaFlag, type MemoryTarget } from "../../src/cli/target.js";
import { textSearchTarget } from "../../src/cli/text-search.js";
import { readMemoryClientInternals } from "../../src/memory/client-internals.js";
import { inMemoryStoreV1 } from "../store/in-memory-v1.js";
import { createTestIo } from "./io.js";

const embedder: Embedder = {
	model: "cli-custom",
	dimensions: 2,
	async embed(texts) {
		return texts.map(() => [1, 0]);
	},
};

function args(overrides: Partial<CliArgs>): CliArgs {
	return {
		command: "migrate",
		yes: false,
		dryRun: false,
		json: false,
		...overrides,
	};
}

function target(withOptionalMethods: boolean): MemoryTarget {
	const memory = createMemory({
		store: defineMemoryStore({
			store: inMemoryStoreV1({ withOptionalMethods }),
		}),
		embedder,
	});
	return {
		kind: "memory",
		label: "memory.ts",
		memory,
		store: readMemoryClientInternals(memory).store,
		embedder,
		async close() {},
	};
}

/** The CLI on a memory file whose store comes from `defineMemoryStore`. */
describe("CLI commands (custom store)", () => {
	test("migrate says a store without migrate manages its own schema", async () => {
		const io = createTestIo(".");
		expect(await migrateTarget(target(false), args({}), io)).toBe(0);
		expect(io.stdout()).toContain(
			'custom store "in-memory-v1", which manages its own schema',
		);
	});

	test("migrate runs a store's own migrate", async () => {
		const io = createTestIo(".", false);
		expect(await migrateTarget(target(true), args({}), io)).toBe(0);
		expect(io.stdout()).not.toContain("manages its own schema");
		expect(io.stderr()).toBe("");
	});

	test("check reports no installation", async () => {
		const io = createTestIo(".");
		expect(
			await checkTarget(target(true), args({ command: "check" }), io),
		).toBe(0);
		expect(io.stdout()).toContain(
			'custom store "in-memory-v1", which reports no installation',
		);
		const json = createTestIo(".");
		await checkTarget(
			target(true),
			args({ command: "check", json: true }),
			json,
		);
		expect(JSON.parse(json.stdout())).toMatchObject({
			backend: "custom",
			installation: null,
		});
	});

	test("text-search has nothing to change", async () => {
		const io = createTestIo(".");
		expect(
			await textSearchTarget(
				target(true),
				args({ command: "text-search", textSearchConfig: "simple" }),
				io,
			),
		).toBe(0);
		expect(io.stdout()).toContain("no text search configuration");
	});

	test("--schema is rejected", () => {
		expect(() =>
			assertSchemaFlag("app", target(true).store, "memory.ts"),
		).toThrow(CliError);
	});
});
