import type { MemoryConfig } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { exerciseConsolidationDuplicateIdPolicy } from "../fixtures/consolidation-duplicate-ids.js";

describe("consolidation duplicate loser IDs", () => {
	test("rejects before store access and preserves one transition in memory", async () => {
		const config: MemoryConfig = {
			embedder: {
				model: "consolidation-duplicate-ids",
				dimensions: 2,
				async embed(texts) {
					return texts.map(() => [1, 1]);
				},
			},
			audit: { enabled: true },
		};
		const baseStore = createInMemoryStore();
		let readCount = 0;
		let mutationCount = 0;
		const store: MemoryStore = {
			...baseStore,
			async get(input) {
				// Each call that passes validation reads its survivor, then its
				// targets; nothing else in the fixture reads by id.
				readCount += 1;
				return baseStore.get(input);
			},
			async consolidate(input) {
				mutationCount += 1;
				return baseStore.consolidate(input);
			},
		};
		const client = createMemoryClient(config, store);

		await exerciseConsolidationDuplicateIdPolicy({
			client,
			entityPrefix: `memory_${Date.now()}_${Math.random().toString(36).slice(2)}`,
			afterDuplicateRejection() {
				expect(readCount).toBe(0);
				expect(mutationCount).toBe(0);
			},
		});
		expect(readCount).toBe(4);
		expect(mutationCount).toBe(1);
	});
});
