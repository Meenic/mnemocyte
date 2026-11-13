import { createMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectDefined, testScope } from "../helpers.js";

function expectNoEmbedding(value: object): void {
	expect(Object.hasOwn(value, "embedding")).toBe(false);
}

describe("in-memory public results", () => {
	test("never expose internal embedding vectors", async () => {
		const client = createMemory({
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
		const alpha = await client.add({
			scope: testScope("alice"),
			content: "alpha preference",
		});
		expectNoEmbedding(alpha);

		const remembered = await client.addMany({
			scope: testScope("alice"),
			memories: [{ content: "alpha duplicate" }, { content: "beta fact" }],
		});
		for (const memory of remembered) {
			expectNoEmbedding(memory);
		}

		const duplicatePairs = await client.findDuplicates({
			scope: testScope("alice"),
			threshold: 0.99,
		});
		const firstPair = expectDefined(duplicatePairs[0]);
		expectNoEmbedding(firstPair.a);
		expectNoEmbedding(firstPair.b);

		const recalled = await client.search({
			scope: testScope("alice"),
			query: "alpha",
			explain: true,
		});
		for (const memory of recalled) {
			expectNoEmbedding(memory);
		}

		const loser = expectDefined(remembered[0]);
		await client.consolidate({
			scope: testScope("alice"),
			survivorId: alpha.id,
			supersededIds: [loser.id],
		});
		const withSuperseded = await client.search({
			scope: testScope("alice"),
			query: "alpha",
			includeSuperseded: true,
		});
		for (const memory of withSuperseded) {
			expectNoEmbedding(memory);
		}
	});
});
