import { createMemory, type Embedder } from "mnemocyte";
import { describe, expect, test, vi } from "vitest";
import {
	IN_MEMORY_CAPABILITIES,
	POSTGRES_CAPABILITIES,
} from "../../src/memory/capabilities.js";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { createPostgresStore } from "../../src/memory/postgres.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { createMnemocyteStoreConfig } from "../../src/memory/store-config.js";
import { resolveStore } from "../../src/memory/store-input.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { expectDefined, expectMnemocyteError, testScope } from "../helpers.js";

const embedder: Embedder = {
	model: "capabilities-test",
	dimensions: 2,
	async embed(texts) {
		return texts.map((text) => [text.length, 1]);
	},
};

const executor: SqlExecutor = {
	async query() {
		return [];
	},
	async transaction(fn) {
		return fn(executor);
	},
};

describe("store capabilities", () => {
	test("the in-memory backend declares an exact scan and overlap scores", () => {
		expect(createInMemoryStore().capabilities).toEqual({
			vectorSearch: "exact",
			filteredVectorSearch: "prefilter",
			lexicalSearch: "overlap",
			locking: "database",
			maxDimensions: Number.POSITIVE_INFINITY,
		});
	});

	test("the Postgres backend declares HNSW with iterative scans and ts_rank", () => {
		const expected = {
			vectorSearch: "approximate",
			filteredVectorSearch: "iterative",
			lexicalSearch: "ts_rank",
			locking: "row",
			maxDimensions: 4000,
		};
		expect(createPostgresStore(executor).capabilities).toEqual(expected);
		// The lazy store for a raw client declares the same before loading.
		expect(resolveStore(executor).capabilities).toEqual(expected);
		expect(POSTGRES_CAPABILITIES).toEqual(expected);
		expect(IN_MEMORY_CAPABILITIES).not.toEqual(expected);
	});

	test("search asks for no lexical list on a backend without keyword search", async () => {
		const base = createInMemoryStore();
		const store: MemoryStore = {
			...base,
			capabilities: { ...base.capabilities, lexicalSearch: "none" },
		};
		const searchCandidates = vi.spyOn(store, "searchCandidates");
		const client = createMemoryClient({ embedder }, store);
		await client.add({ scope: testScope("alice"), content: "dog facts" });

		const results = await client.search({
			scope: testScope("alice"),
			query: "dog facts",
		});

		expect(searchCandidates).toHaveBeenCalledTimes(1);
		const [searched] = expectDefined(searchCandidates.mock.calls[0]);
		expect(searched.lexical).toBeUndefined();
		expect(searched.vector).toMatchObject({ minScore: 0 });
		expect(results[0]?.scores).toMatchObject({
			lexicalRank: null,
			lexical: null,
			vectorRank: 1,
		});
	});

	test("createMemory rejects a store from a copy with another contract", () => {
		// What a store config from a copy of the package before the
		// contract changed holds: the old method names, no capabilities.
		const { capabilities: _capabilities, ...rest } = createInMemoryStore();
		const { searchCandidates: _searchCandidates, ...older } = rest;
		const store = createMnemocyteStoreConfig(older as unknown as MemoryStore);

		expect(() => createMemory({ embedder, store })).toThrow(
			expect.objectContaining({ code: "CONFIG", reason: "INVALID_OPTION" }),
		);
	});

	test("an in-memory client passes the contract check", async () => {
		const client = createMemory({ embedder });
		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({ memoryCount: 0 });
		await expectMnemocyteError(
			client.get({ scope: testScope("alice") } as never),
			"VALIDATION",
		);
	});
});
