import { cloneMemory } from "../memory/records.js";
import type {
	ImportanceLevel,
	Memory,
	MemoryWithScore,
	RecallInput,
	RetrievalBoosts,
	RetrievalConfig,
	RetrievalFusionConfig,
} from "../types.js";

const IMPORTANCE_SCORES: Record<ImportanceLevel, number> = {
	low: 0,
	normal: 0.5,
	high: 0.8,
	critical: 1,
};

export const DEFAULT_FUSION: Readonly<Required<RetrievalFusionConfig>> = {
	k: 60,
	vector: 1,
	lexical: 1,
};

export const DEFAULT_BOOSTS: Readonly<Required<RetrievalBoosts>> = {
	recency: 0.1,
	importance: 0.1,
};

const DEFAULT_RECENCY_HALF_LIFE_DAYS = 90;
export const DEFAULT_CANDIDATE_MULTIPLIER = 3;

export interface ScoringConfig {
	fusion: Required<RetrievalFusionConfig>;
	boosts: Required<RetrievalBoosts>;
	recencyHalfLifeDays: number;
}

/**
 * A memory's position in each candidate list. Ranks are 1-based; `null`
 * means the memory is not in that list.
 */
export interface FusionCandidate {
	memory: Memory;
	vectorRank: number | null;
	lexicalRank: number | null;
	vectorScore: number | null;
	lexicalScore: number | null;
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

export function createScoringConfig(config?: RetrievalConfig): ScoringConfig {
	return {
		fusion: { ...DEFAULT_FUSION, ...config?.fusion },
		boosts: { ...DEFAULT_BOOSTS, ...config?.boosts },
		recencyHalfLifeDays:
			config?.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS,
	};
}

/**
 * Assigns 1-based competition ranks ("1224") to a list already sorted by
 * decreasing score, so equal scores share a rank whatever order the store
 * returned them in.
 */
export function rankByScore(scores: readonly number[]): number[] {
	const ranks: number[] = [];
	for (let i = 0; i < scores.length; i += 1) {
		const previousRank = ranks[i - 1];
		ranks.push(
			previousRank !== undefined && scores[i] === scores[i - 1]
				? previousRank
				: i + 1,
		);
	}
	return ranks;
}

/**
 * Weighted reciprocal rank fusion, `Σ w / (k + rank)` over the lists the
 * memory appears in, divided by the score of rank 1 in every list so the
 * result is in `[0, 1]`.
 */
export function fusedScore(
	vectorRank: number | null,
	lexicalRank: number | null,
	fusion: Required<RetrievalFusionConfig>,
): number {
	const best = (fusion.vector + fusion.lexical) / (fusion.k + 1);
	let score = 0;
	if (vectorRank !== null) {
		score += fusion.vector / (fusion.k + vectorRank);
	}
	if (lexicalRank !== null) {
		score += fusion.lexical / (fusion.k + lexicalRank);
	}
	return clampScore(score / best);
}

function recencyScore(createdAt: Date, halfLifeDays: number): number {
	const ageMs = Date.now() - createdAt.getTime();
	const ageDays = Math.max(0, ageMs / 86_400_000);
	return Math.exp((-Math.LN2 * ageDays) / halfLifeDays);
}

export function toScoredMemory(
	candidate: FusionCandidate,
	input: RecallInput,
	config: ScoringConfig,
): MemoryWithScore {
	const { memory } = candidate;
	const { fusion, boosts } = config;
	const fused = fusedScore(candidate.vectorRank, candidate.lexicalRank, fusion);
	const recency = recencyScore(memory.createdAt, config.recencyHalfLifeDays);
	const importance = IMPORTANCE_SCORES[memory.importance];
	// Boosts scale the fused score instead of adding to it, so a memory that
	// matched neither search well cannot rank high only for being new.
	const boostFactor =
		(1 + boosts.recency * recency + boosts.importance * importance) /
		(1 + boosts.recency + boosts.importance);
	const score = clampScore(fused * boostFactor);
	return {
		...cloneMemory(memory),
		score,
		scores: {
			vectorRank: candidate.vectorRank,
			lexicalRank: candidate.lexicalRank,
			vector:
				candidate.vectorScore === null
					? null
					: clampScore(candidate.vectorScore),
			lexical: candidate.lexicalScore,
			fused,
			recency,
			importance,
		},
		explanation: input.explain
			? {
					fusion: { ...fusion },
					boosts: { ...boosts },
					boostFactor,
					finalScore: score,
				}
			: null,
	};
}

/**
 * Orders scored memories by decreasing score; ties go to the newer memory,
 * then to the lower id, so the order does not depend on the stores.
 */
export function compareScoredMemories(
	a: MemoryWithScore,
	b: MemoryWithScore,
): number {
	return (
		b.score - a.score ||
		b.createdAt.getTime() - a.createdAt.getTime() ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	);
}
