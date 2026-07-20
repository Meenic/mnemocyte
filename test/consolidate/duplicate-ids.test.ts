import type { MnemocyteConfig } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { exerciseConsolidationDuplicateIdPolicy } from "../fixtures/consolidation-duplicate-ids.js";

describe("consolidation duplicate loser IDs", () => {
	test("rejects before store access and preserves one transition in memory", async () => {
		const config: MnemocyteConfig = {
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
		let targetLoadCount = 0;
		let mutationCount = 0;
		const store: MemoryStore = {
			...baseStore,
			async loadConsolidationTargets(entityId, ids, options) {
				targetLoadCount += 1;
				return baseStore.loadConsolidationTargets(entityId, ids, options);
			},
			async consolidate(input, options) {
				mutationCount += 1;
				return baseStore.consolidate(input, options);
			},
		};
		const client = createMemoryClient(config, store);

		try {
			await exerciseConsolidationDuplicateIdPolicy({
				client,
				entityPrefix: `memory_${Date.now()}_${Math.random().toString(36).slice(2)}`,
				afterDuplicateRejection() {
					expect(targetLoadCount).toBe(0);
					expect(mutationCount).toBe(0);
				},
			});
			expect(targetLoadCount).toBe(2);
			expect(mutationCount).toBe(1);
		} finally {
			await client.close();
		}
	});
});
