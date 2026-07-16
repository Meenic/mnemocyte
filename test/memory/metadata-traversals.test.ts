import { createMnemocyte } from "mnemocyte";
import { describe, test } from "vitest";
import { verifyMetadataTraversalCounts } from "../fixtures/metadata-traversals.js";

describe("metadata traversal ownership", () => {
	test("validates once at ingress and clones once at public egress", async () => {
		const client = createMnemocyte({
			embedder: {
				model: "metadata-traversal-test",
				dimensions: 1,
				async embed(texts) {
					return texts.map(() => [1]);
				},
			},
			audit: { enabled: true },
		});

		try {
			await verifyMetadataTraversalCounts(client, "traversal_in_memory");
		} finally {
			await client.close();
		}
	});
});
