import { createMnemocyte } from "mnemocyte";
import { describe, test } from "vitest";
import { exerciseConsolidationTargetPolicy } from "../fixtures/consolidation-target-policy.js";

describe("consolidation target policy", () => {
	test("enforces survivor-specific idempotency atomically in memory", async () => {
		const client = createMnemocyte({
			embedder: {
				model: "consolidation-target-policy",
				dimensions: 2,
				async embed(texts) {
					return texts.map(() => [1, 1]);
				},
			},
			audit: { enabled: true },
		});

		try {
			await exerciseConsolidationTargetPolicy(
				client,
				`memory_${Date.now()}_${Math.random().toString(36).slice(2)}`,
			);
		} finally {
			await client.close();
		}
	});
});
