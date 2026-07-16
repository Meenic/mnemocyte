import { createMnemocyte } from "mnemocyte";
import { describe, expect, test } from "vitest";
import {
	retrievalConfig,
	retrievalQualityCases,
	testEmbedder,
} from "../fixtures/retrieval-quality.js";
import { expectDefined } from "../helpers.js";

describe("retrieval quality", () => {
	test("orders retrieval results and explains scoring", async () => {
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

				expect(results.length, testCase.name).toBe(testCase.memories.length);
				expect(results[0]?.content, testCase.name).toBe(
					testCase.expectedTopContent,
				);
				expect(results[0]?.explanation, testCase.name).toBeTruthy();
				expect(
					results[0]?.scores.confidence !== undefined,
					testCase.name,
				).toBeTruthy();
				expect(
					results[0]?.scores.access !== undefined,
					testCase.name,
				).toBeTruthy();
				expect(
					results[0]?.scores.importance !== undefined,
					testCase.name,
				).toBeTruthy();
			} finally {
				await client.close();
			}
		}

		{
			const client = createMnemocyte({
				embedder: testEmbedder,
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
				expect(result).toBeTruthy();
				const scoredMemory = expectDefined(result);
				const explanation = expectDefined(scoredMemory.explanation);
				expect(explanation.lexicalScore).toBe(2 / 3);
				expect(explanation.weights).toEqual({
					vector: 0.55,
					lexical: 0.2,
					recency: 0.1,
					confidence: 0.05,
					access: 0.05,
					importance: 0.05,
				});
				const expectedFinalScore =
					scoredMemory.scores.vector * explanation.weights.vector +
					scoredMemory.scores.lexical * explanation.weights.lexical +
					scoredMemory.scores.recency * explanation.weights.recency +
					scoredMemory.scores.confidence * explanation.weights.confidence +
					scoredMemory.scores.access * explanation.weights.access +
					scoredMemory.scores.importance * explanation.weights.importance;
				expect(Math.abs(scoredMemory.score - expectedFinalScore)).toBeLessThan(
					1e-12,
				);
				expect(explanation.finalScore).toBe(scoredMemory.score);
			} finally {
				await client.close();
			}
		}
	});
});
