import { cloneMemory } from "../memory/records.js";
import type {
	ImportanceLevel,
	Memory,
	MemoryWithScore,
	RecallInput,
	RetrievalConfig,
	RetrievalScoreWeights,
} from "../types.js";

const IMPORTANCE_SCORES: Record<ImportanceLevel, number> = {
	low: 0,
	normal: 0.5,
	high: 0.8,
	critical: 1,
};

export const DEFAULT_RETRIEVAL_WEIGHTS: Readonly<
	Required<RetrievalScoreWeights>
> = {
	vector: 0.55,
	lexical: 0.2,
	recency: 0.1,
	confidence: 0.05,
	access: 0.05,
	importance: 0.05,
};

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90;
const DEFAULT_ACCESS_SATURATION = 10;
export const DEFAULT_CANDIDATE_MULTIPLIER = 3;

export interface ScoringConfig {
	weights: Required<RetrievalScoreWeights>;
	recencyHalfLifeDays: number;
	accessSaturation: number;
}

export function cosineSimilarity(
	a: readonly number[],
	b: readonly number[],
): number {
	let dot = 0;
	let aMagnitude = 0;
	let bMagnitude = 0;
	for (let i = 0; i < a.length; i += 1) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		aMagnitude += av * av;
		bMagnitude += bv * bv;
	}
	if (aMagnitude === 0 || bMagnitude === 0) {
		return 0;
	}
	return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

export function tokenizeQuery(query: string): readonly string[] {
	return query.toLowerCase().split(/\s+/).filter(Boolean);
}

export function lexicalScoreWithTerms(
	content: string,
	terms: readonly string[],
): number {
	if (terms.length === 0) {
		return 0;
	}
	const lowerContent = content.toLowerCase();
	const matches = terms.filter((term) => lowerContent.includes(term)).length;
	return matches / terms.length;
}

export function createLexicalScorer(
	query: string,
): (content: string) => number {
	const terms = tokenizeQuery(query);
	return (content) => lexicalScoreWithTerms(content, terms);
}

function clampScore(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	return Math.max(0, Math.min(1, value));
}

export function toVectorScore(cosineSimilarity: number): number {
	return clampScore(cosineSimilarity);
}

function normalizeWeights(
	weights: RetrievalScoreWeights | undefined,
): Required<RetrievalScoreWeights> {
	const merged = { ...DEFAULT_RETRIEVAL_WEIGHTS, ...weights };
	const total =
		merged.vector +
		merged.lexical +
		merged.recency +
		merged.confidence +
		merged.access +
		merged.importance;
	if (total <= 0) {
		return { ...DEFAULT_RETRIEVAL_WEIGHTS };
	}
	return {
		vector: merged.vector / total,
		lexical: merged.lexical / total,
		recency: merged.recency / total,
		confidence: merged.confidence / total,
		access: merged.access / total,
		importance: merged.importance / total,
	};
}

export function createScoringConfig(config?: RetrievalConfig): ScoringConfig {
	return {
		weights: normalizeWeights(config?.weights),
		recencyHalfLifeDays:
			config?.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS,
		accessSaturation: config?.accessSaturation ?? DEFAULT_ACCESS_SATURATION,
	};
}

function recencyScore(createdAt: Date, halfLifeDays: number): number {
	const ageMs = Date.now() - createdAt.getTime();
	const ageDays = Math.max(0, ageMs / 86_400_000);
	return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

function accessScore(accessCount: number, saturation: number): number {
	if (accessCount <= 0) {
		return 0;
	}
	return Math.min(1, Math.log1p(accessCount) / Math.log1p(saturation));
}

export function toScoredMemoryWithConfig(
	memory: Memory,
	vector: number,
	lexical: number,
	input: RecallInput,
	config: ScoringConfig,
): MemoryWithScore {
	const { weights } = config;
	const recency = recencyScore(memory.createdAt, config.recencyHalfLifeDays);
	const confidence = clampScore(memory.confidence);
	const access = accessScore(memory.accessCount, config.accessSaturation);
	const importance = IMPORTANCE_SCORES[memory.importance];
	const score = Math.max(
		0,
		Math.min(
			1,
			clampScore(vector) * weights.vector +
				clampScore(lexical) * weights.lexical +
				recency * weights.recency +
				confidence * weights.confidence +
				access * weights.access +
				importance * weights.importance,
		),
	);
	return {
		...cloneMemory(memory),
		score,
		scores: {
			vector: clampScore(vector),
			lexical: clampScore(lexical),
			recency,
			confidence,
			access,
			importance,
		},
		explanation: input.explain
			? {
					vectorScore: clampScore(vector),
					lexicalScore: clampScore(lexical),
					recencyScore: recency,
					confidenceScore: confidence,
					accessScore: access,
					importanceScore: importance,
					importanceBoost: importance * weights.importance,
					weights,
					finalScore: score,
				}
			: null,
	};
}
