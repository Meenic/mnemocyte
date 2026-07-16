import { describe, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { verifyRecallAccessMetadata } from "../fixtures/recall-access-metadata.js";

describe("recall access metadata", () => {
	test("returns the successful in-memory access update without rescoring it", async () => {
		const store = createInMemoryStore();
		const client = createMemoryClient(
			{
				embedder: {
					model: "recall-access-metadata-test",
					dimensions: 1,
					async embed(texts) {
						return texts.map(() => [1]);
					},
				},
			},
			store,
		);

		try {
			await verifyRecallAccessMetadata(client, "access_in_memory", (memories) =>
				Promise.all(
					memories.map(async (memory) => {
						const stored = await store.getMemory(memory.entityId, memory.id);
						if (!stored) {
							throw new Error(`Missing stored memory ${memory.id}.`);
						}
						return stored;
					}),
				),
			);
		} finally {
			await client.close();
		}
	});
});
