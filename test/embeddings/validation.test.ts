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
});
