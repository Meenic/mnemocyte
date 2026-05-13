import assert from "node:assert/strict";
import { createMnemocyte } from "../../dist/index.mjs";

const embedder = {
	model: "context-test",
	dimensions: 4,
	async embed(texts) {
		return texts.map((text) => [
			text.length,
			text.includes("xml") ? 1 : 0,
			text.includes("direct") ? 1 : 0,
			1,
		]);
	},
};

const client = createMnemocyte({ embedder });
const entityId = `context_${Date.now()}_${Math.random().toString(36).slice(2)}`;

try {
	await client.remember({
		entityId,
		content: "Prefers short, direct answers with <xml> safety & escaping.",
		type: "preference",
		importance: "high",
		tags: ["style"],
	});

	const markdown = await client.buildContext({
		entityId,
		query: "direct xml answers",
		format: "markdown",
		limit: 1,
	});
	assert.match(markdown, /# Memory Context/);
	assert.match(markdown, /Relevant Memories/);
	assert.match(markdown, /Prefers short, direct answers/);

	const plain = await client.buildContext({
		entityId,
		query: "direct xml answers",
		format: "plain",
		limit: 1,
	});
	assert.match(plain, /MEMORY CONTEXT/);
	assert.match(plain, /RELEVANT MEMORIES/);

	const xml = await client.buildContext({
		entityId,
		query: "direct xml answers",
		format: "xml",
		limit: 1,
	});
	assert.match(xml, /<memory_context/);
	assert.match(xml, /&lt;xml&gt; safety &amp; escaping/);
	assert.doesNotMatch(xml, /<xml> safety & escaping/);

	const trimmed = await client.buildContext({
		entityId,
		query: "direct xml answers",
		format: "markdown",
		limit: 1,
		maxTokens: 12,
		tokenCounter: {
			count(text) {
				return text.split(/\s+/).filter(Boolean).length;
			},
		},
	});
	assert.match(trimmed, /\[truncated to fit token budget\]/);
} finally {
	await client.close();
}

console.log("Context builder tests passed.");
