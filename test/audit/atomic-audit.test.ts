import { createMemory } from "mnemocyte";
import { describe, test } from "vitest";
import { verifyAuditPayloads } from "../fixtures/atomic-audit.js";
import { testScope } from "../helpers.js";

describe("atomic audit (in-memory)", () => {
	test("every write path records the shared payloads", async () => {
		const memory = createMemory({
			embedder: {
				model: "atomic-audit",
				dimensions: 2,
				async embed(texts: readonly string[]) {
					return texts.map((text) => [text.length % 7, 1]);
				},
			},
			audit: { enabled: true },
		});
		await verifyAuditPayloads(memory, testScope);
	});
});
