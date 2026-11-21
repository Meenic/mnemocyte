import { throwIfAborted } from "../resilience.js";
import { cloneMemory, type StoredMemory } from "./records.js";
import type { StoreDuplicatePair } from "./store.js";

/**
 * Exact nearest-neighbor duplicate search over memories already in memory,
 * shared by the in-memory store and the libSQL store, which reads the
 * candidates' embeddings and compares them here: one SQL
 * `vector_distance_cos` between two stored rows costs about 37 µs at 1,536
 * dimensions, so comparing every pair in SQL took a minute for 1,000
 * memories (docs/features/libsql.md).
 *
 * Similarities are computed as `cosineSimilarity` in `retrieval/scorer.ts`
 * does (the same sums in the same order, so the same values), from vectors
 * and magnitudes prepared once, and clamped to `[0, 1]`. Each memory's
 * neighbors are its `neighbors` most similar others, ties by id.
 */

export interface FoundPair {
	a: StoredMemory;
	b: StoredMemory;
	similarity: number;
}

interface Neighbor {
	readonly index: number;
	readonly similarity: number;
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The candidates' vectors as typed arrays, with their magnitudes. */
class SimilarityIndex {
	readonly #vectors: Float64Array[];
	readonly #magnitudes: Float64Array;

	constructor(readonly memories: readonly StoredMemory[]) {
		this.#vectors = memories.map((memory) =>
			Float64Array.from(memory.embedding),
		);
		this.#magnitudes = Float64Array.from(this.#vectors, (vector) => {
			let sum = 0;
			for (const value of vector) {
				sum += value * value;
			}
			return Math.sqrt(sum);
		});
	}

	similarity(i: number, j: number): number {
		const a = this.#vectors[i];
		const b = this.#vectors[j];
		const magnitudeA = this.#magnitudes[i] ?? 0;
		const magnitudeB = this.#magnitudes[j] ?? 0;
		if (a === undefined || b === undefined) {
			return 0;
		}
		if (magnitudeA === 0 || magnitudeB === 0) {
			return 0;
		}
		let dot = 0;
		const length = Math.min(a.length, b.length);
		for (let k = 0; k < length; k += 1) {
			dot += (a[k] ?? 0) * (b[k] ?? 0);
		}
		return Math.max(0, Math.min(1, dot / (magnitudeA * magnitudeB)));
	}

	id(index: number): string {
		return this.memories[index]?.id ?? "";
	}

	/** Whether `x` ranks before `y`: more similar, then the smaller id. */
	before(x: Neighbor, y: Neighbor): boolean {
		return (
			x.similarity > y.similarity ||
			(x.similarity === y.similarity &&
				compareIds(this.id(x.index), this.id(y.index)) < 0)
		);
	}

	/** Insert into a best-first list kept at `limit` entries. */
	offer(list: Neighbor[], candidate: Neighbor, limit: number): void {
		if (limit <= 0) {
			return;
		}
		const last = list[list.length - 1];
		if (
			list.length === limit &&
			last !== undefined &&
			!this.before(candidate, last)
		) {
			return;
		}
		let position = list.length;
		while (position > 0) {
			const previous = list[position - 1];
			if (previous === undefined || !this.before(candidate, previous)) {
				break;
			}
			position -= 1;
		}
		list.splice(position, 0, candidate);
		if (list.length > limit) {
			list.pop();
		}
	}

	/** The `limit` nearest of every other candidate to `index`. */
	nearest(index: number, limit: number): Neighbor[] {
		const list: Neighbor[] = [];
		for (let other = 0; other < this.memories.length; other += 1) {
			if (other !== index) {
				this.offer(
					list,
					{ index: other, similarity: this.similarity(index, other) },
					limit,
				);
			}
		}
		return list;
	}
}

/** Add a pair keyed by its ordered ids, keeping the first one found. */
function addPair(
	pairs: Map<string, FoundPair>,
	x: StoredMemory,
	y: StoredMemory,
	similarity: number,
): void {
	const [a, b] = x.id < y.id ? [x, y] : [y, x];
	const key = `${a.id} ${b.id}`;
	if (!pairs.has(key)) {
		pairs.set(key, { a, b, similarity });
	}
}

function sortPairs(pairs: Map<string, FoundPair>): FoundPair[] {
	return [...pairs.values()].sort(
		(x, y) =>
			y.similarity - x.similarity ||
			compareIds(x.a.id, y.a.id) ||
			compareIds(x.b.id, y.b.id),
	);
}

/** A pair as the store returns it: detached memories without embeddings. */
export function toStorePair({
	a,
	b,
	similarity,
}: FoundPair): StoreDuplicatePair {
	return { a: cloneMemory(a), b: cloneMemory(b), similarity };
}

/**
 * The most similar pairs at or above `threshold` where one memory is among
 * the other's `neighbors` nearest, by decreasing similarity, then ids, up
 * to `limit`. Every pair is compared once, and both memories' neighbor
 * lists take the result.
 */
export function exactDuplicatePairs(
	candidates: readonly StoredMemory[],
	input: { neighbors: number; threshold: number; limit: number },
	signal?: AbortSignal,
): FoundPair[] {
	const index = new SimilarityIndex(candidates);
	const nearest: Neighbor[][] = candidates.map(() => []);
	for (let i = 0; i < candidates.length; i += 1) {
		throwIfAborted(signal);
		for (let j = i + 1; j < candidates.length; j += 1) {
			const similarity = index.similarity(i, j);
			index.offer(nearest[i] ?? [], { index: j, similarity }, input.neighbors);
			index.offer(nearest[j] ?? [], { index: i, similarity }, input.neighbors);
		}
	}
	const pairs = new Map<string, FoundPair>();
	nearest.forEach((list, i) => {
		const memory = candidates[i];
		for (const neighbor of list) {
			const other = candidates[neighbor.index];
			if (
				memory !== undefined &&
				other !== undefined &&
				neighbor.similarity >= input.threshold
			) {
				addPair(pairs, memory, other, neighbor.similarity);
			}
		}
	});
	return sortPairs(pairs).slice(0, input.limit);
}

/**
 * One page of a run over every candidate by id: the first `batchSize` after
 * `afterId`, each compared with every candidate. A pair found from memory
 * `x` belongs to this page unless its smaller id is another memory whose
 * own nearest neighbors include `x`: that memory's page owns it.
 */
export function exactDuplicatePage(
	candidates: readonly StoredMemory[],
	input: {
		neighbors: number;
		threshold: number;
		batchSize: number;
		afterId?: string;
	},
	signal?: AbortSignal,
): { pairs: FoundPair[]; compared: number; lastId: string | null } {
	const index = new SimilarityIndex(candidates);
	const compared = candidates
		.map((memory, position) => ({ memory, position }))
		.filter(
			({ memory }) => input.afterId === undefined || memory.id > input.afterId,
		)
		.sort((x, y) => compareIds(x.memory.id, y.memory.id))
		.slice(0, input.batchSize);
	const neighborIds = new Map<number, Set<string>>();
	const ownNeighbors = (position: number): Set<string> => {
		let found = neighborIds.get(position);
		if (found === undefined) {
			found = new Set(
				index
					.nearest(position, input.neighbors)
					.map((neighbor) => index.id(neighbor.index)),
			);
			neighborIds.set(position, found);
		}
		return found;
	};
	const pairs = new Map<string, FoundPair>();
	for (const { memory, position } of compared) {
		throwIfAborted(signal);
		for (const neighbor of index.nearest(position, input.neighbors)) {
			const other = candidates[neighbor.index];
			if (other === undefined || neighbor.similarity < input.threshold) {
				continue;
			}
			// A smaller id was compared on an earlier page (or this one) and
			// owns the pair when it found this memory itself.
			if (other.id < memory.id && ownNeighbors(neighbor.index).has(memory.id)) {
				continue;
			}
			addPair(pairs, memory, other, neighbor.similarity);
		}
	}
	return {
		pairs: sortPairs(pairs),
		compared: compared.length,
		lastId: compared.at(-1)?.memory.id ?? null,
	};
}
