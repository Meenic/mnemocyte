import type { MnemocyteDatabase } from "../db/index.js";
import {
	lexicalSearch,
	markMemoryAccessed,
	vectorSearch,
} from "../db/queries/memories.js";
import type { MemoryRow } from "../db/schema.js";
import { embedOne, rowToMemory } from "../memory/shared.js";
import type {
	Embedder,
	MemoryWithScore,
	ProviderResilienceConfig,
	RecallInput,
	RetrievalConfig,
} from "../types.js";
import {
	cosineSimilarity,
	DEFAULT_CANDIDATE_MULTIPLIER,
	lexicalScore,
	toScoredMemory,
} from "./scorer.js";

interface HybridRecallInput {
	db: MnemocyteDatabase;
	embedder: Embedder;
	input: RecallInput;
	limit: number;
	minScore: number;
	retrieval: RetrievalConfig | undefined;
	signal?: AbortSignal;
	resilience?: ProviderResilienceConfig;
}

interface ScoredRow {
	row: MemoryRow;
	vectorScore: number;
	lexicalScore: number;
}

export async function hybridRecall(
	input: HybridRecallInput,
): Promise<MemoryWithScore[]> {
	const queryEmbedding = await embedOne(input.embedder, input.input.query, {
		...(input.signal === undefined ? {} : { signal: input.signal }),
		...(input.resilience === undefined ? {} : { resilience: input.resilience }),
	});
	const candidateMultiplier =
		input.retrieval?.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
	const candidateLimit = Math.max(
		input.limit,
		input.limit * candidateMultiplier,
	);
	const [vectorRows, lexicalRows] = await Promise.all([
		vectorSearch(input.db, {
			...input.input,
			embedding: queryEmbedding,
			limit: candidateLimit,
			minScore: 0,
		}),
		lexicalSearch(input.db, { ...input.input, limit: candidateLimit }),
	]);
	const merged = new Map<string, ScoredRow>();
	for (const row of vectorRows) {
		merged.set(row.id, {
			row,
			vectorScore: row.vectorScore,
			lexicalScore: lexicalScore(row.content, input.input.query),
		});
	}
	for (const row of lexicalRows) {
		const existing = merged.get(row.id);
		if (existing) {
			existing.lexicalScore = row.lexicalScore;
		} else {
			const embedding = (row as unknown as { embedding: number[] }).embedding;
			const sim = embedding ? cosineSimilarity(embedding, queryEmbedding) : 0;
			merged.set(row.id, {
				row,
				vectorScore: Math.max(0, sim),
				lexicalScore: row.lexicalScore,
			});
		}
	}
	const scored = Array.from(merged.values())
		.map((entry) =>
			toScoredMemory(
				rowToMemory(entry.row),
				Math.max(0, entry.vectorScore),
				Math.max(0, entry.lexicalScore),
				input.input,
				input.retrieval,
			),
		)
		.filter((memory) => memory.score >= input.minScore)
		.sort((a, b) => b.score - a.score)
		.slice(0, input.limit);
	await markMemoryAccessed(
		input.db,
		scored.map((memory) => memory.id),
	);
	return scored;
}
