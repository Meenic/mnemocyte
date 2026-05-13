import assert from "node:assert/strict";
import { createMnemocyte } from "../../dist/index.mjs";
import {
	retrievalConfig,
	retrievalQualityCases,
	testEmbedder,
} from "../fixtures/retrieval-quality.mjs";

for (const testCase of retrievalQualityCases) {
	const client = createMnemocyte({
		embedder: testEmbedder,
		retrieval: retrievalConfig,
	});
	const entityId = `retrieval_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	try {
		for (const memory of testCase.memories) {
			await client.remember({ entityId, ...memory });
		}

		const results = await client.recall({
			entityId,
			query: testCase.query,
			limit: 3,
			explain: true,
		});

		assert.equal(results.length, testCase.memories.length, testCase.name);
		assert.equal(
			results[0]?.content,
			testCase.expectedTopContent,
			testCase.name,
		);
		assert.ok(results[0]?.explanation, testCase.name);
		assert.ok(results[0]?.scores.confidence !== undefined, testCase.name);
		assert.ok(results[0]?.scores.access !== undefined, testCase.name);
		assert.ok(results[0]?.scores.importance !== undefined, testCase.name);
	} finally {
		await client.close();
	}
}

console.log("Retrieval quality tests passed.");
