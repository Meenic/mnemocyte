import type { MnemocyteConfig } from "mnemocyte";
import { describe, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import {
	createPausingConsolidationStore,
	exerciseConsolidationSurvivorRaces,
} from "../fixtures/consolidation-survivor-races.js";

describe("consolidation survivor mutation races", () => {
	test("atomically protects the survivor and current tags in memory", async () => {
		const config: MnemocyteConfig = {
			embedder: {
				model: "consolidation-survivor-races",
				dimensions: 2,
				async embed(texts) {
					return texts.map(() => [1, 1]);
				},
			},
			audit: { enabled: true },
		};
		const baseStore = createInMemoryStore();
		const pausingStore = createPausingConsolidationStore(baseStore);
		const client = createMemoryClient(config, pausingStore.store);
		const mutator = createMemoryClient(config, baseStore);

		try {
			await exerciseConsolidationSurvivorRaces({
				client,
				mutator,
				pauseNext: pausingStore.pauseNext,
				entityPrefix: `memory_${Date.now()}_${Math.random().toString(36).slice(2)}`,
			});
		} finally {
			await client.close();
		}
	});
});
