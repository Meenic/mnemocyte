import { createMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

describe("embedding output validation", () => {
	test.each([
		{
			name: "single-memory embedding",
			vectors: [[Number.NaN, 1]],
			run: async (client: ReturnType<typeof createMemory>) => {
				await client.add({ scope: testScope("alice"), content: "invalid" });
			},
		},
		{
			name: "batched embeddings",
			vectors: [
				[1, 0],
				[Number.POSITIVE_INFINITY, 1],
			],
			run: async (client: ReturnType<typeof createMemory>) => {
				await client.addMany({
					scope: testScope("alice"),
					memories: [{ content: "valid" }, { content: "invalid" }],
				});
			},
		},
	])("rejects non-finite values from $name", async ({ vectors, run }) => {
		const client = createMemory({
			embedder: {
				model: "non-finite-test",
				dimensions: 2,
				async embed() {
					return vectors;
				},
			},
		});

		await expectMnemocyteError(run(client), "EMBEDDING");
		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({
			memoryCount: 0,
		});
	});

	test("rejects zero-norm embeddings before writes or recall comparisons", async () => {
		const client = createMemory({
			embedder: {
				model: "zero-norm-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) =>
						text.includes("zero") ? [0, -0] : [1, 0],
					);
				},
			},
		});

		await expectMnemocyteError(
			client.add({ scope: testScope("alice"), content: "zero single" }),
			"EMBEDDING",
		);
		await expectMnemocyteError(
			client.addMany({
				scope: testScope("alice"),
				memories: [{ content: "valid batch" }, { content: "zero batch" }],
			}),
			"EMBEDDING",
		);
		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({
			memoryCount: 0,
		});

		await client.add({ scope: testScope("alice"), content: "valid stored" });
		await expectMnemocyteError(
			client.search({ scope: testScope("alice"), query: "zero query" }),
			"EMBEDDING",
		);
		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({
			memoryCount: 1,
		});
	});

	test("accepts tiny nonzero embeddings without a magnitude threshold", async () => {
		const client = createMemory({
			embedder: {
				model: "tiny-norm-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map(() => [1e-20, 0]);
				},
			},
		});

		await expect(
			client.add({ scope: testScope("alice"), content: "tiny" }),
		).resolves.toMatchObject({ scope: testScope("alice") });
	});
});
