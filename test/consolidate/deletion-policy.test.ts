import { createMnemocyte } from "mnemocyte";
import { describe, test } from "vitest";
import { exerciseConsolidationDeletePolicy } from "../fixtures/consolidation-delete-policy.js";

describe("consolidation survivor deletion policy", () => {
	test("rejects referenced survivors atomically in memory", async () => {
		const client = createMnemocyte({
			embedder: {
				model: "consolidation-delete-policy",
				dimensions: 2,
				async embed(texts) {
					return texts.map(() => [1, 1]);
				},
			},
		});

		try {
			await exerciseConsolidationDeletePolicy(
				client,
				`memory_${Date.now()}_${Math.random().toString(36).slice(2)}`,
			);
		} finally {
			await client.close();
		}
	});
});
