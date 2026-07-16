import { throwIfAborted } from "../resilience.js";
import { cosineSimilarity, createLexicalScorer } from "../retrieval/scorer.js";
import type {
	AuditEvent,
	EntityStats,
	GlobalStats,
	Memory,
	MnemocyteClient,
	MnemocyteConfig,
} from "../types.js";
import { createMemoryClient } from "./client-core.js";
import {
	DEFAULT_AUDIT_LOG_LIMIT,
	DEFAULT_DUPLICATE_LIMIT,
	DEFAULT_DUPLICATE_THRESHOLD,
} from "./defaults.js";
import {
	isExpired,
	matchesDuplicateFilter,
	matchesPruneFilter,
	matchesRecallFilter,
} from "./filters.js";
import { cloneJsonObject } from "./json.js";
import { cloneMemory, createEventId, type StoredMemory } from "./records.js";
import type {
	MemoryStore,
	StoreConsolidateInput,
	StoreConsolidateResult,
	StoreDuplicatePair,
	StoreLexicalCandidate,
	StoreLexicalSearchInput,
	StoreVectorCandidate,
	StoreVectorSearchInput,
} from "./store.js";

function cloneStoredMemory(memory: StoredMemory): StoredMemory {
	return {
		...cloneMemory(memory),
		embedding: [...memory.embedding],
	};
}

function cloneAuditEvent(event: AuditEvent): AuditEvent {
	return {
		id: event.id,
		entityId: event.entityId,
		description: event.description,
		metadata: cloneJsonObject(event.metadata),
		timestamp: new Date(event.timestamp),
	};
}

export function createInMemoryStore(): MemoryStore {
	const memories = new Map<string, StoredMemory>();
	const auditLog: AuditEvent[] = [];

	return {
		backend: "in-memory",
		async ensureSchema() {},
		async ensureEmbeddingCompatibility() {},
		async insertMemories(rows) {
			const inserted: Memory[] = [];
			for (const row of rows) {
				const stored = cloneStoredMemory(row);
				memories.set(stored.id, stored);
				inserted.push(cloneMemory(stored));
			}
			return inserted;
		},
		async vectorSearch(input: StoreVectorSearchInput) {
			const now = new Date();
			const minScore = input.minScore ?? 0;
			return Array.from(memories.values())
				.filter((memory) => matchesRecallFilter(memory, input, now))
				.map((memory) => ({
					memory: cloneMemory(memory),
					vectorScore: Math.max(
						0,
						cosineSimilarity(memory.embedding, input.embedding),
					),
				}))
				.filter((candidate) => candidate.vectorScore >= minScore)
				.sort((a, b) => b.vectorScore - a.vectorScore)
				.slice(0, input.limit) satisfies StoreVectorCandidate[];
		},
		async lexicalSearch(input: StoreLexicalSearchInput) {
			const now = new Date();
			const scoreLexical = createLexicalScorer(input.query);
			return Array.from(memories.values())
				.filter((memory) => matchesRecallFilter(memory, input, now))
				.map((memory) => ({
					memory: cloneMemory(memory),
					lexicalScore: scoreLexical(memory.content),
				}))
				.filter((candidate) => candidate.lexicalScore > 0)
				.sort((a, b) => b.lexicalScore - a.lexicalScore)
				.slice(0, input.limit) satisfies StoreLexicalCandidate[];
		},
		async getMemoryEmbeddings(memoryIds) {
			const result = new Map<string, number[]>();
			for (const id of memoryIds) {
				const memory = memories.get(id);
				if (memory) {
					result.set(id, [...memory.embedding]);
				}
			}
			return result;
		},
		async markMemoriesAccessed(memoryIds) {
			const now = new Date();
			for (const id of memoryIds) {
				const memory = memories.get(id);
				if (memory) {
					memory.lastAccessedAt = now;
					memory.accessCount += 1;
					memory.updatedAt = now;
				}
			}
		},
		async deleteMemory(entityId, memoryId) {
			const memory = memories.get(memoryId);
			if (!memory || memory.entityId !== entityId) {
				return false;
			}
			return memories.delete(memoryId);
		},
		async deleteMemoriesForEntity(entityId) {
			let deleted = 0;
			for (const [id, memory] of memories) {
				if (memory.entityId === entityId) {
					memories.delete(id);
					deleted += 1;
				}
			}
			return deleted;
		},
		async prune(input, options) {
			throwIfAborted(options?.signal);
			const now = new Date();
			const matched: string[] = [];
			for (const memory of memories.values()) {
				throwIfAborted(options?.signal);
				if (matchesPruneFilter(memory, input, now)) {
					matched.push(memory.id);
				}
			}
			const dryRun = input.dryRun === true;
			if (!dryRun) {
				throwIfAborted(options?.signal);
				for (const id of matched) {
					memories.delete(id);
				}
			}
			return {
				matchedCount: matched.length,
				deletedCount: dryRun ? 0 : matched.length,
				dryRun,
			};
		},
		async findDuplicatePairs(input, options) {
			throwIfAborted(options?.signal);
			const threshold = input.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
			const limit = input.limit ?? DEFAULT_DUPLICATE_LIMIT;
			const now = new Date();
			const candidates = Array.from(memories.values()).filter((memory) => {
				throwIfAborted(options?.signal);
				return matchesDuplicateFilter(memory, input, now);
			});
			const pairs: StoreDuplicatePair[] = [];
			for (let i = 0; i < candidates.length; i += 1) {
				throwIfAborted(options?.signal);
				const a = candidates[i];
				if (a === undefined) {
					continue;
				}
				for (let j = i + 1; j < candidates.length; j += 1) {
					throwIfAborted(options?.signal);
					const b = candidates[j];
					if (b === undefined) {
						continue;
					}
					const similarity = Math.max(
						0,
						Math.min(1, cosineSimilarity(a.embedding, b.embedding)),
					);
					if (similarity >= threshold) {
						pairs.push({
							a: cloneMemory(a),
							b: cloneMemory(b),
							similarity,
						});
					}
				}
			}
			pairs.sort((x, y) => y.similarity - x.similarity);
			return pairs.slice(0, limit);
		},
		async addAuditEvents(events) {
			auditLog.push(...events.map(cloneAuditEvent));
		},
		async listAuditLog(input, options) {
			throwIfAborted(options?.signal);
			const limit = input.limit ?? DEFAULT_AUDIT_LOG_LIMIT;
			const indexed = auditLog.map((event, idx) => ({ event, idx }));
			return indexed
				.filter(({ event }) => {
					throwIfAborted(options?.signal);
					if (event.entityId !== input.entityId) {
						return false;
					}
					if (
						input.before !== undefined &&
						event.timestamp.getTime() >= input.before.getTime()
					) {
						return false;
					}
					if (
						input.after !== undefined &&
						event.timestamp.getTime() <= input.after.getTime()
					) {
						return false;
					}
					return true;
				})
				.sort((a, b) => {
					const dt = b.event.timestamp.getTime() - a.event.timestamp.getTime();
					return dt === 0 ? b.idx - a.idx : dt;
				})
				.slice(0, limit)
				.map(({ event }) => cloneAuditEvent(event));
		},
		async getMemory(entityId, memoryId, options) {
			throwIfAborted(options?.signal);
			const memory = memories.get(memoryId);
			return memory && memory.entityId === entityId
				? cloneMemory(memory)
				: null;
		},
		async loadConsolidationTargets(entityId, ids, options) {
			return ids.flatMap((id) => {
				throwIfAborted(options?.signal);
				const memory = memories.get(id);
				if (!memory || memory.entityId !== entityId) {
					return [];
				}
				return [
					{
						id: memory.id,
						tags: [...memory.tags],
						supersededBy: memory.supersededBy,
					},
				];
			});
		},
		async consolidate(
			input: StoreConsolidateInput,
			options,
		): Promise<StoreConsolidateResult> {
			throwIfAborted(options?.signal);
			const survivor = memories.get(input.survivorId);
			const newlySuperseded: StoredMemory[] = [];
			for (const id of input.supersededIds) {
				throwIfAborted(options?.signal);
				const memory = memories.get(id);
				if (!memory || memory.entityId !== input.entityId) {
					continue;
				}
				if (memory.supersededBy !== null) {
					continue;
				}
				newlySuperseded.push(memory);
			}
			let mergedSurvivorTags: string[] | undefined;
			if (survivor && input.mergeTags && newlySuperseded.length > 0) {
				const mergedTags = new Set(input.survivorTags);
				for (const memory of newlySuperseded) {
					throwIfAborted(options?.signal);
					for (const tag of memory.tags) {
						mergedTags.add(tag);
					}
				}
				if (mergedTags.size !== survivor.tags.length) {
					mergedSurvivorTags = [...mergedTags];
				}
			}
			const auditEvents = input.auditEnabled
				? newlySuperseded.map((memory) => ({
						id: createEventId(),
						entityId: input.entityId,
						description: "memory.superseded",
						metadata: {
							memoryId: memory.id,
							supersededBy: input.survivorId,
						},
						timestamp: input.now,
					}))
				: [];
			throwIfAborted(options?.signal);
			for (const memory of newlySuperseded) {
				memory.supersededBy = input.survivorId;
				memory.supersededAt = input.now;
				memory.updatedAt = input.now;
			}
			if (survivor && mergedSurvivorTags) {
				survivor.tags = mergedSurvivorTags;
				survivor.updatedAt = input.now;
			}
			if (input.auditEnabled) {
				auditLog.push(...auditEvents);
			}
			return { supersededIds: newlySuperseded.map((memory) => memory.id) };
		},
		async stats(input, now) {
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
			memories.clear();
			auditLog.length = 0;
		},
	};
}

export function createInMemoryClient(config: MnemocyteConfig): MnemocyteClient {
	return createMemoryClient(config, createInMemoryStore());
}
