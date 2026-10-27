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
				expect(results[0]?.scores.vectorRank, testCase.name).toBe(1);
				expect(results[0]?.scores.lexicalRank, testCase.name).toBe(1);
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
				const { scores } = scoredMemory;
				expect(scores.lexical).toBe(2 / 3);
				expect(scores.vectorRank).toBe(1);
				expect(scores.lexicalRank).toBe(1);
				expect(scores.fused).toBe(1);
				expect(scores.importance).toBe(0.8);
				expect(explanation.fusion).toEqual({ k: 60, vector: 1, lexical: 1 });
				expect(explanation.boosts).toEqual({ recency: 0.1, importance: 0.1 });
				const expectedBoostFactor =
					(1 + 0.1 * scores.recency + 0.1 * scores.importance) / 1.2;
				expect(explanation.boostFactor).toBeCloseTo(expectedBoostFactor, 12);
				expect(scoredMemory.score).toBeCloseTo(
					scores.fused * expectedBoostFactor,
					12,
				);
				expect(explanation.finalScore).toBe(scoredMemory.score);
			} finally {
				await client.close();
			}
		}
	});

	test("clamps negative cosine scores and ranks equal scores together", async () => {
		const vectorByText = new Map<string, number[]>([
			["positive", [1, 0]],
			["orthogonal", [0, 1]],
			["slightly-negative", [-1e-9, 1]],
			["opposite", [-1, 0]],
			["query", [1, 0]],
		]);
		const client = createMnemocyte({
			embedder: {
				model: "signed-vector-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) => vectorByText.get(text) ?? [1, 0]);
				},
			},
		});

		try {
			for (const content of [
				"positive",
				"orthogonal",
				"slightly-negative",
				"opposite",
			]) {
				await client.remember({ entityId: "signed", content });
			}

			const all = await client.recall({
				entityId: "signed",
				query: "query",
				limit: 4,
				explain: true,
			});
			expect(all).toHaveLength(4);
			const vectorScores = new Map(
				all.map((memory) => [memory.content, memory.scores.vector]),
			);
			expect(vectorScores.get("positive")).toBe(1);
			expect(vectorScores.get("orthogonal")).toBe(0);
			expect(vectorScores.get("slightly-negative")).toBe(0);
			expect(vectorScores.get("opposite")).toBe(0);
			expect(all.map((memory) => memory.scores.vectorRank)).toEqual([
				1, 2, 2, 2,
			]);
			expect(all.every((memory) => memory.scores.lexicalRank === null)).toBe(
				true,
			);
			const [first, second] = all;
			expect(expectDefined(first).score).toBeGreaterThan(
				expectDefined(second).score,
			);

			const finalScoreFiltered = await client.recall({
				entityId: "signed",
				query: "query",
				limit: 4,
				minScore:
					(expectDefined(first).score + expectDefined(second).score) / 2,
			});
			expect(finalScoreFiltered.map((memory) => memory.content)).toEqual([
				"positive",
			]);
		} finally {
			await client.close();
		}
	});
});
