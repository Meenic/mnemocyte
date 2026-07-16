import { createMnemocyte } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

describe("embedding output validation", () => {
	test.each([
		{
			name: "single-memory embedding",
			vectors: [[Number.NaN, 1]],
			run: async (client: ReturnType<typeof createMnemocyte>) => {
				await client.remember({ entityId: "alice", content: "invalid" });
			},
		},
		{
			name: "batched embeddings",
			vectors: [
				[1, 0],
				[Number.POSITIVE_INFINITY, 1],
			],
			run: async (client: ReturnType<typeof createMnemocyte>) => {
				await client.rememberMany([
					{ entityId: "alice", content: "valid" },
					{ entityId: "alice", content: "invalid" },
				]);
			},
		},
	])("rejects non-finite values from $name", async ({ vectors, run }) => {
		const client = createMnemocyte({
			embedder: {
				model: "non-finite-test",
				dimensions: 2,
				async embed() {
					return vectors;
				},
			},
		});

		try {
			await expectMnemocyteError(run(client), "EMBEDDING");
			await expect(client.stats({ entityId: "alice" })).resolves.toMatchObject({
				memoryCount: 0,
			});
		} finally {
			await client.close();
		}
	});

	test("rejects zero-norm embeddings before writes or recall comparisons", async () => {
		const client = createMnemocyte({
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

		try {
			await expectMnemocyteError(
				client.remember({ entityId: "alice", content: "zero single" }),
				"EMBEDDING",
			);
			await expectMnemocyteError(
				client.rememberMany({
					inputs: [
						{ entityId: "alice", content: "valid batch" },
						{ entityId: "alice", content: "zero batch" },
					],
				}),
				"EMBEDDING",
			);
			await expect(client.stats({ entityId: "alice" })).resolves.toMatchObject({
				memoryCount: 0,
			});

			await client.remember({ entityId: "alice", content: "valid stored" });
			await expectMnemocyteError(
				client.recall({ entityId: "alice", query: "zero query" }),
				"EMBEDDING",
			);
			await expect(client.stats({ entityId: "alice" })).resolves.toMatchObject({
				memoryCount: 1,
			});
		} finally {
			await client.close();
		}
	});

	test("accepts tiny nonzero embeddings without a magnitude threshold", async () => {
		const client = createMnemocyte({
			embedder: {
				model: "tiny-norm-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map(() => [1e-20, 0]);
				},
			},
		});

		try {
			await expect(
				client.remember({ entityId: "alice", content: "tiny" }),
			).resolves.toMatchObject({ entityId: "alice" });
		} finally {
			await client.close();
		}
	});
});
