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

{
	const client = createMnemocyte({
		embedder: testEmbedder,
		retrieval: {
			weights: {
				vector: 0,
				lexical: 0,
				recency: 0,
				confidence: 0,
				access: 0,
				importance: 0,
			},
		},
	});
	const entityId = `retrieval_scoring_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	try {
		await client.remember({
			entityId,
			content: "Prefers concise TypeScript library answers.",
			type: "preference",
			importance: "high",
			confidence: 0.8,
		});
		const [result] = await client.recall({
			entityId,
			query: "  TYPESCRIPT   concise   missing ",
			limit: 1,
			explain: true,
		});
		assert.ok(result);
		assert.ok(result.explanation);
		assert.equal(result.explanation.lexicalScore, 2 / 3);
		assert.deepEqual(result.explanation.weights, {
			vector: 0.55,
			lexical: 0.2,
			recency: 0.1,
			confidence: 0.05,
			access: 0.05,
			importance: 0.05,
		});
		const expectedFinalScore =
			result.scores.vector * result.explanation.weights.vector +
			result.scores.lexical * result.explanation.weights.lexical +
			result.scores.recency * result.explanation.weights.recency +
			result.scores.confidence * result.explanation.weights.confidence +
			result.scores.access * result.explanation.weights.access +
			result.scores.importance * result.explanation.weights.importance;
		assert.ok(Math.abs(result.score - expectedFinalScore) < 1e-12);
		assert.equal(result.explanation.finalScore, result.score);
	} finally {
		await client.close();
	}
}

console.log("Retrieval quality tests passed.");
