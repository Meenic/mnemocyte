import type { Embedder, ImportanceLevel, Memory } from "mnemocyte";
import { describe, expect, test, vi } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { createUuidV7 } from "../../src/memory/records.js";
import {
	compareScoredMemories,
	createScoringConfig,
	fusedScore,
	rankByScore,
	toScoredMemory,
} from "../../src/retrieval/scorer.js";
import { expectDefined } from "../helpers.js";

const DAY_MS = 86_400_000;

function memory(
	overrides: Partial<Memory> & { importance?: ImportanceLevel } = {},
): Memory {
	const now = new Date();
	return {
		id: createUuidV7(),
		entityId: "alice",
		content: "content",
		type: "fact",
		importance: "normal",
		tags: [],
		source: null,
		metadata: {},
		confidence: 1,
		embeddingModel: "test",
		embeddingDimensions: 2,
		supersededBy: null,
		supersededAt: null,
		expiresAt: null,
		lastAccessedAt: null,
		accessCount: 0,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

const defaults = createScoringConfig();

describe("rankByScore", () => {
	test("gives equal scores the same competition rank", () => {
		expect(rankByScore([0.9, 0.9, 0.5, 0.5, 0.1])).toEqual([1, 1, 3, 3, 5]);
		expect(rankByScore([3, 2, 1])).toEqual([1, 2, 3]);
		expect(rankByScore([])).toEqual([]);
	});
});

describe("fusedScore", () => {
	test("is 1 for rank 1 in both lists and 0.5 for rank 1 in one", () => {
		expect(fusedScore(1, 1, defaults.fusion)).toBe(1);
		expect(fusedScore(1, null, defaults.fusion)).toBe(0.5);
		expect(fusedScore(null, 1, defaults.fusion)).toBe(0.5);
		expect(fusedScore(null, null, defaults.fusion)).toBe(0);
	});

	test("sums reciprocal ranks with k = 60", () => {
		expect(fusedScore(3, 7, defaults.fusion)).toBeCloseTo(
			(1 / 63 + 1 / 67) / (2 / 61),
			15,
		);
	});

	test("ranks a memory found by both lists above one found by a single list", () => {
		expect(fusedScore(10, 10, defaults.fusion)).toBeGreaterThan(
			fusedScore(1, null, defaults.fusion),
		);
	});

	test("applies list weights and k", () => {
		const fusion = { k: 0, vector: 3, lexical: 1 };
		expect(fusedScore(1, null, fusion)).toBe(0.75);
		expect(fusedScore(null, 2, fusion)).toBe(0.125);
	});
});

describe("toScoredMemory", () => {
	const candidate = {
		vectorRank: 2,
		lexicalRank: null,
		vectorScore: 0.7,
		lexicalScore: null,
	};

	test("returns the fused score unchanged when boosts are off", () => {
		const config = createScoringConfig({
			boosts: { recency: 0, importance: 0 },
		});
		const scored = toScoredMemory(
			{ memory: memory(), ...candidate },
			{ entityId: "alice", query: "q", explain: true },
			config,
		);
		expect(scored.score).toBe(scored.scores.fused);
		expect(scored.explanation?.boostFactor).toBe(1);
		expect(scored.scores).toMatchObject({
			vectorRank: 2,
			lexicalRank: null,
			vector: 0.7,
			lexical: null,
		});
	});

	test("scales the fused score by recency and importance", () => {
		const fresh = toScoredMemory(
			{ memory: memory({ importance: "critical" }), ...candidate },
			{ entityId: "alice", query: "q" },
			defaults,
		);
		const stale = toScoredMemory(
			{
				memory: memory({
					importance: "low",
					createdAt: new Date(Date.now() - 3_650 * DAY_MS),
				}),
				...candidate,
			},
			{ entityId: "alice", query: "q", explain: true },
			defaults,
		);
		expect(fresh.score).toBeCloseTo(fresh.scores.fused, 9);
		expect(stale.scores.recency).toBeLessThan(1e-9);
		expect(expectDefined(stale.explanation).boostFactor).toBeCloseTo(
			1 / 1.2,
			9,
		);
		expect(stale.score).toBeCloseTo(stale.scores.fused / 1.2, 9);
		expect(fresh.explanation).toBeNull();
	});

	test("keeps a small boost from lifting a memory many ranks", () => {
		const relevantButOld = toScoredMemory(
			{
				memory: memory({
					importance: "low",
					createdAt: new Date(Date.now() - 3_650 * DAY_MS),
				}),
				vectorRank: 1,
				lexicalRank: 1,
				vectorScore: 0.9,
				lexicalScore: 0.1,
			},
			{ entityId: "alice", query: "q" },
			defaults,
		);
		const newButWeak = toScoredMemory(
			{ memory: memory({ importance: "critical" }), ...candidate },
			{ entityId: "alice", query: "q" },
			defaults,
		);
		expect(relevantButOld.score).toBeGreaterThan(newButWeak.score);
	});
});

describe("compareScoredMemories", () => {
	test("breaks score ties by newer createdAt, then by id", () => {
		const createdAt = new Date("2026-01-01T00:00:00Z");
		const scored = (overrides: Partial<Memory>) =>
			toScoredMemory(
				{
					memory: memory({ createdAt, ...overrides }),
					vectorRank: 1,
					lexicalRank: null,
					vectorScore: 1,
					lexicalScore: null,
				},
				{ entityId: "alice", query: "q" },
				createScoringConfig({ boosts: { recency: 0, importance: 0 } }),
			);
		const newer = scored({
			id: "b",
			createdAt: new Date("2026-02-01T00:00:00Z"),
		});
		const a = scored({ id: "a" });
		const c = scored({ id: "c" });
		expect([c, a, newer].sort(compareScoredMemories).map((m) => m.id)).toEqual([
			"b",
			"a",
			"c",
		]);
	});
});

describe("recall fusion", () => {
	const embedder: Embedder = {
		model: "fusion-test",
		dimensions: 2,
		async embed(texts) {
			return texts.map((text) => (text.includes("cat") ? [1, 0] : [0, 1]));
		},
	};

	test("includes lexical-only candidates without a vector rank", async () => {
		const client = createMemoryClient(
			{
				embedder: {
					...embedder,
					async embed(texts) {
						return texts.map((text) =>
							text.includes("ledger")
								? [0, 1]
								: text.includes("videos")
									? [1, 1]
									: [1, 0],
						);
					},
				},
				retrieval: { candidateMultiplier: 1 },
			},
			createInMemoryStore(),
		);
		try {
			await client.rememberMany({
				inputs: [
					{ entityId: "alice", content: "cat photos" },
					{ entityId: "alice", content: "cat videos" },
					{ entityId: "alice", content: "kennel ledger" },
				],
			});
			// The query embeds like "cat photos" and close to "cat videos", so
			// the two-item vector list misses the ledger; only the lexical list
			// finds it, and it ties "cat photos" for the top two places.
			const results = await client.recall({
				entityId: "alice",
				query: "kennel",
				limit: 2,
			});
			const ledger = expectDefined(
				results.find((result) => result.content === "kennel ledger"),
			);
			expect(ledger.scores).toMatchObject({
				vectorRank: null,
				vector: null,
				lexicalRank: 1,
			});
		} finally {
			await client.close();
		}
	});

	test("skips the search of a list whose weight is zero", async () => {
		const store = createInMemoryStore();
		const vectorSearch = vi.spyOn(store, "vectorSearch");
		const lexicalSearch = vi.spyOn(store, "lexicalSearch");
		const client = createMemoryClient(
			{ embedder, retrieval: { fusion: { vector: 0 } } },
			store,
		);
		try {
			await client.rememberMany({
				inputs: [
					{ entityId: "alice", content: "cat facts" },
					{ entityId: "alice", content: "dog facts" },
				],
			});
			const results = await client.recall({
				entityId: "alice",
				query: "dog",
			});
			expect(vectorSearch).not.toHaveBeenCalled();
			expect(lexicalSearch).toHaveBeenCalledTimes(1);
			expect(results.map((result) => result.content)).toEqual(["dog facts"]);
			expect(results[0]?.scores).toMatchObject({
				vectorRank: null,
				vector: null,
				lexicalRank: 1,
				fused: 1,
			});
		} finally {
			await client.close();
		}
	});
});
