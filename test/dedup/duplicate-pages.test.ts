import { createMemory } from "mnemocyte";
import { describe, test } from "vitest";
import { CONTRACT_DIMENSIONS, embedText } from "../contract/suite.js";
import { verifyDuplicatePages } from "../fixtures/duplicate-pages.js";
import { testScope } from "../helpers.js";

describe("duplicate pages (in-memory)", () => {
	test("follow the shared fixture", async () => {
		const client = createMemory({
			embedder: {
				model: "duplicate-pages",
				dimensions: CONTRACT_DIMENSIONS,
				async embed(texts) {
					return texts.map(embedText);
				},
			},
		});
		await verifyDuplicatePages(client, testScope);
	});
});
