import { createMnemocyte } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectDefined } from "../helpers.js";

function expectNoEmbedding(value: object): void {
	expect(Object.hasOwn(value, "embedding")).toBe(false);
}

describe("in-memory public results", () => {
	test("never expose internal embedding vectors", async () => {
		const client = createMnemocyte({
			embedder: {
				model: "public-results-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) =>
						text.toLowerCase().includes("alpha") ? [1, 0] : [0, 1],
					);
				},
			},
			audit: { enabled: true },
		});
		try {
			const alpha = await client.remember({
				entityId: "alice",
				content: "alpha preference",
			});
			expectNoEmbedding(alpha);

			const remembered = await client.rememberMany([
				{ entityId: "alice", content: "alpha duplicate" },
				{ entityId: "alice", content: "beta fact" },
			]);
			for (const memory of remembered) {
				expectNoEmbedding(memory);
			}

			const duplicatePairs = await client.findDuplicates({
				entityId: "alice",
				threshold: 0.99,
			});
			const firstPair = expectDefined(duplicatePairs[0]);
			expectNoEmbedding(firstPair.a);
			expectNoEmbedding(firstPair.b);

			const recalled = await client.recall({
				entityId: "alice",
				query: "alpha",
				explain: true,
			});
			for (const memory of recalled) {
				expectNoEmbedding(memory);
			}

			const loser = expectDefined(remembered[0]);
			await client.experimental.consolidate({
				entityId: "alice",
				survivorId: alpha.id,
				supersededIds: [loser.id],
			});
			const withSuperseded = await client.recall({
				entityId: "alice",
				query: "alpha",
				includeSuperseded: true,
			});
			for (const memory of withSuperseded) {
				expectNoEmbedding(memory);
			}
		} finally {
			await client.close();
		}
	});
});
