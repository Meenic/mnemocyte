import { cloneMemory } from "../memory/shared.js";
import type {
	ImportanceLevel,
	Memory,
	MemoryWithScore,
	RecallInput,
} from "../types.js";

const IMPORTANCE_BOOSTS: Record<ImportanceLevel, number> = {
	low: -0.05,
	normal: 0,
	high: 0.08,
	critical: 0.15,
};

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

export function lexicalScore(content: string, query: string): number {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) {
		return 0;
	}
	const lowerContent = content.toLowerCase();
	const matches = terms.filter((term) => lowerContent.includes(term)).length;
	return matches / terms.length;
}

function recencyScore(createdAt: Date): number {
	const ageMs = Date.now() - createdAt.getTime();
	const ageDays = Math.max(0, ageMs / 86_400_000);
	return Math.exp((-Math.LN2 * ageDays) / 90);
}

export function toScoredMemory(
	memory: Memory,
	vector: number,
	lexical: number,
	input: RecallInput,
): MemoryWithScore {
	const recency = recencyScore(memory.createdAt);
	const importanceBoost = IMPORTANCE_BOOSTS[memory.importance];
	const score = Math.max(
		0,
		Math.min(1, vector * 0.7 + lexical * 0.2 + recency * 0.1 + importanceBoost),
	);
	return {
		...cloneMemory(memory),
		score,
		scores: { vector, lexical, recency },
		explanation: input.explain
			? {
					vectorScore: vector,
					lexicalScore: lexical,
					recencyScore: recency,
					importanceBoost,
					finalScore: score,
				}
			: null,
	};
}
