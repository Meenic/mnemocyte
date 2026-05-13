import assert from "node:assert/strict";
import { createMnemocyte, MnemocyteError } from "mnemocyte";

assert.equal(typeof createMnemocyte, "function");
assert.equal(typeof MnemocyteError, "function");

const client = createMnemocyte({
	embedder: {
		model: "exports-smoke",
		dimensions: 2,
		async embed(texts) {
			return texts.map((text) => [text.length, 1]);
		},
	},
});

const memory = await client.remember({
	entityId: "exports_smoke",
	content: "Package self-reference import works.",
});
assert.equal(memory.entityId, "exports_smoke");
assert.equal(typeof client.buildContext, "function");

await client.close();

console.log("Package runtime export smoke test passed.");
