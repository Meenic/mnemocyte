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
	RecallInput,
	RetrievalConfig,
} from "../types.js";
import { DEFAULT_CANDIDATE_MULTIPLIER, toScoredMemory } from "./scorer.js";

interface HybridRecallInput {
	db: MnemocyteDatabase;
	embedder: Embedder;
	input: RecallInput;
	limit: number;
	minScore: number;
	retrieval: RetrievalConfig | undefined;
}

interface ScoredRow {
	row: MemoryRow;
	vectorScore: number;
	lexicalScore: number;
}

export async function hybridRecall(
	input: HybridRecallInput,
): Promise<MemoryWithScore[]> {
	const queryEmbedding = await embedOne(input.embedder, input.input.query);
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
			lexicalScore: 0,
		});
	}
	for (const row of lexicalRows) {
		const existing = merged.get(row.id);
		if (existing) {
			existing.lexicalScore = row.lexicalScore;
		} else {
			merged.set(row.id, {
				row,
				vectorScore: 0,
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
