import type { MnemocyteDatabase } from "../db/index.js";
import {
	getMemoryEmbeddings,
	lexicalSearch,
	markMemoryAccessed,
	type RecallMemoryRow,
	vectorSearch,
} from "../db/queries/memories.js";
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
	createLexicalScorer,
	createScoringConfig,
	DEFAULT_CANDIDATE_MULTIPLIER,
	toScoredMemoryWithConfig,
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
	row: RecallMemoryRow;
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
	const scoreLexical = createLexicalScorer(input.input.query);
	const scoringConfig = createScoringConfig(input.retrieval);
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
			lexicalScore: scoreLexical(row.content),
		});
	}
	const lexicalOnlyRows = lexicalRows.filter((row) => !merged.has(row.id));
	const lexicalOnlyEmbeddings = await getMemoryEmbeddings(
		input.db,
		lexicalOnlyRows.map((row) => row.id),
	);
	for (const row of lexicalRows) {
		const existing = merged.get(row.id);
		if (existing) {
			existing.lexicalScore = row.lexicalScore;
		} else {
			const embedding = lexicalOnlyEmbeddings.get(row.id);
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
			toScoredMemoryWithConfig(
				rowToMemory(entry.row),
				Math.max(0, entry.vectorScore),
				Math.max(0, entry.lexicalScore),
				input.input,
				scoringConfig,
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
