import { MnemocyteError } from "../errors.js";
import {
	cosineSimilarity,
	lexicalScore,
	toScoredMemory,
} from "../retrieval/scorer.js";
import type {
	EntityStats,
	GlobalStats,
	Memory,
	MnemocyteClient,
	MnemocyteConfig,
	RememberInput,
} from "../types.js";
import {
	assertLimit,
	assertMinScore,
	assertNonEmptyString,
	cloneMemory,
	createId,
	DEFAULT_IMPORTANCE,
	DEFAULT_LIMIT,
	DEFAULT_MIN_SCORE,
	DEFAULT_TYPE,
	embedOne,
	isExpired,
	matchesRecallFilter,
	normalizeTags,
	type StoredMemory,
	validateRecallInput,
	validateRememberInput,
} from "./shared.js";

export function createInMemoryClient(config: MnemocyteConfig): MnemocyteClient {
	const memories = new Map<string, StoredMemory>();
	let closed = false;

	function assertOpen(): void {
		if (closed) {
			throw new MnemocyteError("Mnemocyte client is closed.", "DB");
		}
	}

	async function remember(input: RememberInput): Promise<Memory> {
		assertOpen();
		validateRememberInput(input);
		const embedding = await embedOne(config.embedder, input.content);
		const now = new Date();
		const memory: StoredMemory = {
			id: createId(),
			entityId: input.entityId,
			content: input.content,
			type: input.type ?? DEFAULT_TYPE,
			importance: input.importance ?? DEFAULT_IMPORTANCE,
			tags: normalizeTags(input.tags),
			source: input.source ?? null,
			metadata: input.metadata ?? {},
			confidence: input.confidence ?? 1,
			embeddingModel: config.embedder.model,
			embeddingDimensions: config.embedder.dimensions,
			supersededBy: null,
			expiresAt: input.expiresAt ?? null,
			lastAccessedAt: null,
			accessCount: 0,
			createdAt: now,
			updatedAt: now,
			embedding,
		};
		memories.set(memory.id, memory);
		return cloneMemory(memory);
	}

	return {
		remember,
		async rememberMany(inputs) {
			assertOpen();
			const result: Memory[] = [];
			for (const input of inputs) {
				result.push(await remember(input));
			}
			return result;
		},
		async recall(input) {
			assertOpen();
			validateRecallInput(input);
			const limit = input.limit ?? config.defaults?.limit ?? DEFAULT_LIMIT;
			const minScore =
				input.minScore ?? config.defaults?.minScore ?? DEFAULT_MIN_SCORE;
			assertLimit(limit);
			assertMinScore(minScore);
			const queryEmbedding = await embedOne(config.embedder, input.query);
			const now = new Date();
			const scored = Array.from(memories.values())
				.filter((memory) => matchesRecallFilter(memory, input, now))
				.map((memory) =>
					toScoredMemory(
						memory,
						Math.max(0, cosineSimilarity(memory.embedding, queryEmbedding)),
						lexicalScore(memory.content, input.query),
						input,
					),
				)
				.filter((memory) => memory.score >= minScore)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);
			for (const memory of scored) {
				const stored = memories.get(memory.id);
				if (stored) {
					stored.lastAccessedAt = now;
					stored.accessCount += 1;
					stored.updatedAt = now;
				}
			}
			return scored;
		},
		async forget(input) {
			assertOpen();
			assertNonEmptyString(input.entityId, "entityId");
			assertNonEmptyString(input.memoryId, "memoryId");
			const memory = memories.get(input.memoryId);
			if (!memory || memory.entityId !== input.entityId) {
				throw new MnemocyteError("Memory was not found.", "NOT_FOUND");
			}
			memories.delete(input.memoryId);
		},
		async forgetAll(input) {
			assertOpen();
			assertNonEmptyString(input.entityId, "entityId");
			for (const [id, memory] of memories) {
				if (memory.entityId === input.entityId) {
					memories.delete(id);
				}
			}
		},
		async stats(input) {
			assertOpen();
			const now = new Date();
			const allMemories = Array.from(memories.values());
			const selected = input?.entityId
				? allMemories.filter((memory) => memory.entityId === input.entityId)
				: allMemories;
			const activeMemoryCount = selected.filter(
				(memory) => !isExpired(memory, now) && memory.supersededBy === null,
			).length;
			const expiredMemoryCount = selected.filter((memory) =>
				isExpired(memory, now),
			).length;
			const supersededMemoryCount = selected.filter(
				(memory) => memory.supersededBy !== null,
			).length;
			if (input?.entityId) {
				return {
					entityId: input.entityId,
					memoryCount: selected.length,
					activeMemoryCount,
					expiredMemoryCount,
					supersededMemoryCount,
				} satisfies EntityStats;
			}
			return {
				entityCount: new Set(allMemories.map((memory) => memory.entityId)).size,
				memoryCount: selected.length,
				activeMemoryCount,
				expiredMemoryCount,
				supersededMemoryCount,
			} satisfies GlobalStats;
		},
		async close() {
			closed = true;
			memories.clear();
		},
	};
}
