import { MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import {
	cosineSimilarity,
	createLexicalScorer,
	toVectorScore,
} from "../retrieval/scorer.js";
import type {
	AuditEvent,
	Memory,
	MemoryConfig,
	MemoryStats,
} from "../types.js";
import {
	deletedEvents,
	prunedEvent,
	supersededEvent,
	updatedEvent,
	writtenEvent,
} from "./audit.js";
import { type CoreMemoryClient, createMemoryClient } from "./client-core.js";
import { hiddenDependentsError, memoryHasDependentsError } from "./deletion.js";
import {
	isExpired,
	isSameScope,
	isSelected,
	isVisible,
	matchesDuplicateFilter,
	matchesMemoryFilter,
	matchesPruneFilter,
} from "./filters.js";
import { cloneAuditEvent, cloneMemory, type StoredMemory } from "./records.js";
import {
	assertPruneFilterHasSelector,
	type MemoryStore,
	type StoreConsolidateInput,
	type StoreConsolidateResult,
	type StoreDeleteInput,
	type StoreDeleteResult,
	type StoreDuplicateInput,
	type StoreDuplicatePair,
	type StoreLexicalCandidate,
	type StoreLexicalSearchInput,
	type StoreListPosition,
	type StoreVectorCandidate,
	type StoreVectorSearchInput,
} from "./store.js";

function comparePositions(
	a: { id: string; timestamp: Date },
	b: { id: string; timestamp: Date },
): number {
	const timestampDifference = a.timestamp.getTime() - b.timestamp.getTime();
	if (timestampDifference !== 0) {
		return timestampDifference;
	}
	if (a.id === b.id) {
		return 0;
	}
	return a.id < b.id ? -1 : 1;
}

function listPosition(memory: Memory): { id: string; timestamp: Date } {
	return { id: memory.id, timestamp: memory.createdAt };
}

function cursorPosition(position: StoreListPosition): {
	id: string;
	timestamp: Date;
} {
	return { id: position.id, timestamp: position.createdAt };
}

function compareIds(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function keyConflictError(): MnemocyteError {
	return new MnemocyteError(
		"Another memory in this scope already uses that key.",
		"CONFLICT",
	);
}

interface FoundPair {
	a: StoredMemory;
	b: StoredMemory;
	similarity: number;
}

/**
 * The exact `count` nearest of `candidates` to `memory`, without itself,
 * most similar first and ties by id. Similarities are clamped to `[0, 1]`.
 */
function nearestNeighbors(
	memory: StoredMemory,
	candidates: readonly StoredMemory[],
	count: number,
): Array<{ other: StoredMemory; similarity: number }> {
	return candidates
		.filter((other) => other.id !== memory.id)
		.map((other) => ({
			other,
			similarity: Math.max(
				0,
				Math.min(1, cosineSimilarity(memory.embedding, other.embedding)),
			),
		}))
		.sort(
			(x, y) =>
				y.similarity - x.similarity || compareIds(x.other.id, y.other.id),
		)
		.slice(0, count);
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

function toStorePair({ a, b, similarity }: FoundPair): StoreDuplicatePair {
	return { a: cloneMemory(a), b: cloneMemory(b), similarity };
}

export function createInMemoryStore(): MemoryStore {
	const memories = new Map<string, StoredMemory>();
	const auditLog: AuditEvent[] = [];

	function findByKey(
		scope: StoredMemory["scope"],
		key: string,
	): StoredMemory | undefined {
		for (const memory of memories.values()) {
			if (memory.key === key && isSameScope(memory.scope, scope)) {
				return memory;
			}
		}
		return undefined;
	}

	/** The memories a duplicate search compares. */
	function duplicateCandidates(
		input: Omit<StoreDuplicateInput, "limit">,
		signal: AbortSignal | undefined,
	): StoredMemory[] {
		throwIfAborted(signal);
		const now = new Date();
		return Array.from(memories.values()).filter((memory) => {
			throwIfAborted(signal);
			return matchesDuplicateFilter(memory, input, now);
		});
	}

	/** Memories whose `supersededBy` is `memoryId`, by id. */
	function dependentsOf(memoryId: string): StoredMemory[] {
		return Array.from(memories.values())
			.filter((memory) => memory.supersededBy === memoryId)
			.sort((a, b) => compareIds(a.id, b.id));
	}

	function deleteAuditEvents(
		input: StoreDeleteInput,
		result: StoreDeleteResult,
	): AuditEvent[] {
		return deletedEvents({
			scope: input.visibility.scope,
			memoryId: input.memoryId,
			deletedIds: result.deletedIds,
			restoredIds: result.restoredIds,
			now: input.now,
		});
	}

	/**
	 * Throws `"CONFLICT"` when a memory outside `targetIds` (or any memory when
	 * `allowSelectedDependents` is false) references a target.
	 */
	function assertNoDependents(
		targetIds: ReadonlySet<string>,
		allowSelectedDependents: boolean,
	): void {
		for (const memory of memories.values()) {
			if (
				memory.supersededBy !== null &&
				targetIds.has(memory.supersededBy) &&
				!(allowSelectedDependents && targetIds.has(memory.id))
			) {
				throw memoryHasDependentsError();
			}
		}
	}

	return {
		backend: "in-memory",
		async migrate() {
			return { applied: [], adopted: [], extensionCreated: false };
		},
		async ensureEmbeddingCompatibility() {},
		async insertMemories(rows, options) {
			throwIfAborted(options?.signal);
			// Keys are distinct within a call, so every row's target can be
			// found, and its audit event built, before anything changes.
			const planned = rows.map((row) => ({
				row,
				existing: row.key === null ? undefined : findByKey(row.scope, row.key),
			}));
			const events =
				options?.audit === true
					? planned.map(({ row, existing }) =>
							writtenEvent(
								existing
									? { ...row, id: existing.id, scope: existing.scope }
									: row,
								existing === undefined,
							),
						)
					: [];
			const results: Memory[] = [];
			for (const { row, existing } of planned) {
				if (!existing) {
					memories.set(row.id, row);
					results.push(cloneMemory(row));
					continue;
				}
				existing.content = row.content;
				existing.kind = row.kind;
				existing.importance = row.importance;
				existing.tags = row.tags;
				existing.source = row.source;
				existing.metadata = row.metadata;
				existing.confidence = row.confidence;
				existing.embedding = row.embedding;
				existing.embeddingModel = row.embeddingModel;
				existing.embeddingDimensions = row.embeddingDimensions;
				existing.expiresAt = row.expiresAt;
				existing.updatedAt = row.updatedAt;
				results.push(cloneMemory(existing));
			}
			auditLog.push(...events);
			return results;
		},
		async vectorSearch(input: StoreVectorSearchInput) {
			const now = new Date();
			const minVectorScore = input.minVectorScore ?? 0;
			return Array.from(memories.values())
				.filter((memory) => matchesMemoryFilter(memory, input, now))
				.map((memory) => ({
					memory: cloneMemory(memory),
					vectorScore: toVectorScore(
						cosineSimilarity(memory.embedding, input.embedding),
					),
				}))
				.filter((candidate) => candidate.vectorScore >= minVectorScore)
				.sort((a, b) => b.vectorScore - a.vectorScore)
				.slice(0, input.limit) satisfies StoreVectorCandidate[];
		},
		async lexicalSearch(input: StoreLexicalSearchInput) {
			const now = new Date();
			const scoreLexical = createLexicalScorer(input.query);
			return Array.from(memories.values())
				.filter((memory) => matchesMemoryFilter(memory, input, now))
				.map((memory) => ({
					memory: cloneMemory(memory),
					lexicalScore: scoreLexical(memory.content),
				}))
				.filter((candidate) => candidate.lexicalScore > 0)
				.sort((a, b) => b.lexicalScore - a.lexicalScore)
				.slice(0, input.limit) satisfies StoreLexicalCandidate[];
		},
		async listMemories(input, options) {
			throwIfAborted(options?.signal);
			const now = new Date();
			const after =
				input.position === undefined
					? undefined
					: cursorPosition(input.position);
			return Array.from(memories.values())
				.filter(
					(memory) =>
						matchesMemoryFilter(memory, input, now) &&
						(after === undefined ||
							comparePositions(listPosition(memory), after) < 0),
				)
				.sort((a, b) => comparePositions(listPosition(b), listPosition(a)))
				.slice(0, input.limit)
				.map(cloneMemory);
		},
		async markMemoriesAccessed(visibility, memoryIds) {
			const now = new Date();
			for (const id of memoryIds) {
				const memory = memories.get(id);
				if (memory && isVisible(memory.scope, visibility)) {
					memory.lastAccessedAt = now;
					memory.accessCount += 1;
				}
			}
		},
		async getMemory(visibility, memoryId, options) {
			throwIfAborted(options?.signal);
			const memory = memories.get(memoryId);
			return memory && isVisible(memory.scope, visibility)
				? cloneMemory(memory)
				: null;
		},
		async getMemoryByKey(scope, key, options) {
			throwIfAborted(options?.signal);
			const memory = findByKey(scope, key);
			return memory ? cloneMemory(memory) : null;
		},
		async updateMemory(input) {
			const memory = memories.get(input.id);
			if (!memory || !isVisible(memory.scope, input.visibility)) {
				return null;
			}
			const { patch } = input;
			if (patch.key !== undefined && patch.key !== null) {
				const holder = findByKey(memory.scope, patch.key);
				if (holder && holder.id !== memory.id) {
					throw keyConflictError();
				}
			}
			const event =
				input.audit === undefined
					? undefined
					: updatedEvent(
							{ ...memory, updatedAt: input.now },
							input.audit.fields,
						);
			if (patch.content !== undefined) {
				memory.content = patch.content;
			}
			if (patch.embedding !== undefined) {
				memory.embedding = [...patch.embedding];
			}
			if (patch.embeddingModel !== undefined) {
				memory.embeddingModel = patch.embeddingModel;
			}
			if (patch.embeddingDimensions !== undefined) {
				memory.embeddingDimensions = patch.embeddingDimensions;
			}
			if (patch.key !== undefined) {
				memory.key = patch.key;
			}
			if (patch.kind !== undefined) {
				memory.kind = patch.kind;
			}
			if (patch.importance !== undefined) {
				memory.importance = patch.importance;
			}
			if (patch.tags !== undefined) {
				memory.tags = [...patch.tags];
			}
			if (patch.source !== undefined) {
				memory.source = patch.source;
			}
			if (patch.metadata !== undefined) {
				memory.metadata = patch.metadata;
			}
			if (patch.confidence !== undefined) {
				memory.confidence = patch.confidence;
			}
			if (patch.expiresAt !== undefined) {
				memory.expiresAt = patch.expiresAt;
			}
			memory.updatedAt = input.now;
			if (event) {
				auditLog.push(event);
			}
			return cloneMemory(memory);
		},
		async deleteMemory(input, options) {
			throwIfAborted(options?.signal);
			const { memoryId, visibility } = input;
			const memory = memories.get(memoryId);
			if (!memory || !isVisible(memory.scope, visibility)) {
				return null;
			}
			const direct = dependentsOf(memoryId);
			if (direct.length > 0 && input.dependents === "reject") {
				throw memoryHasDependentsError();
			}
			if (input.dependents === "restore") {
				if (
					direct.some((dependent) => !isVisible(dependent.scope, visibility))
				) {
					throw hiddenDependentsError();
				}
				const result = {
					deletedIds: [memoryId],
					restoredIds: direct.map((dependent) => dependent.id),
				};
				const events = input.audit ? deleteAuditEvents(input, result) : [];
				for (const dependent of direct) {
					dependent.supersededBy = null;
					dependent.supersededAt = null;
					dependent.updatedAt = input.now;
				}
				memories.delete(memoryId);
				auditLog.push(...events);
				return result;
			}
			// "delete", or "reject" without dependents: the memory and every
			// memory consolidated into it, directly or through another.
			const tree: StoredMemory[] = [];
			const pending = [...direct];
			for (let next = pending.pop(); next; next = pending.pop()) {
				tree.push(next);
				pending.push(...dependentsOf(next.id));
			}
			if (tree.some((dependent) => !isVisible(dependent.scope, visibility))) {
				throw hiddenDependentsError();
			}
			const result = {
				deletedIds: [
					memoryId,
					...tree.map((dependent) => dependent.id).sort(compareIds),
				],
				restoredIds: [],
			};
			const events = input.audit ? deleteAuditEvents(input, result) : [];
			for (const id of result.deletedIds) {
				memories.delete(id);
			}
			auditLog.push(...events);
			return result;
		},
		async deleteScope(selector, options) {
			throwIfAborted(options?.signal);
			const targetIds = new Set(
				Array.from(memories.values())
					.filter((memory) => isSelected(memory.scope, selector))
					.map((memory) => memory.id),
			);
			assertNoDependents(targetIds, true);
			for (const id of targetIds) {
				memories.delete(id);
			}
			for (let index = auditLog.length - 1; index >= 0; index -= 1) {
				const event = auditLog[index];
				if (event && isSelected(event.scope, selector)) {
					auditLog.splice(index, 1);
				}
			}
			return targetIds.size;
		},
		async prune(input, options) {
			throwIfAborted(options?.signal);
			assertPruneFilterHasSelector(input);
			const matched: StoredMemory[] = [];
			for (const memory of memories.values()) {
				throwIfAborted(options?.signal);
				if (matchesPruneFilter(memory, input, input.now)) {
					matched.push(memory);
				}
			}
			const dryRun = input.dryRun === true;
			if (!dryRun) {
				throwIfAborted(options?.signal);
				assertNoDependents(new Set(matched.map((memory) => memory.id)), true);
				const counts = new Map<
					string,
					{ namespace: string; entityId: string; count: number }
				>();
				for (const memory of matched) {
					const entityKey = JSON.stringify([
						memory.scope.namespace,
						memory.scope.entityId,
					]);
					const entity = counts.get(entityKey) ?? {
						namespace: memory.scope.namespace,
						entityId: memory.scope.entityId,
						count: 0,
					};
					entity.count += 1;
					counts.set(entityKey, entity);
				}
				const events = input.audit
					? [...counts.values()].map((entity) =>
							prunedEvent({
								selector: input.selector,
								...entity,
								now: input.now,
							}),
						)
					: [];
				for (const memory of matched) {
					memories.delete(memory.id);
				}
				auditLog.push(...events);
			}
			return {
				matchedCount: matched.length,
				deletedCount: dryRun ? 0 : matched.length,
				dryRun,
			};
		},
		async findDuplicatePairs(input, options) {
			const candidates = duplicateCandidates(input, options?.signal);
			// Exact k nearest neighbors per memory; the Postgres store gets them
			// from its HNSW index. Pairs are keyed by their ordered ids.
			const pairs = new Map<string, FoundPair>();
			for (const memory of candidates) {
				throwIfAborted(options?.signal);
				for (const { other, similarity } of nearestNeighbors(
					memory,
					candidates,
					input.neighbors,
				)) {
					if (similarity >= input.threshold) {
						addPair(pairs, memory, other, similarity);
					}
				}
			}
			return sortPairs(pairs).slice(0, input.limit).map(toStorePair);
		},
		async findDuplicatePage(input, options) {
			const candidates = duplicateCandidates(input, options?.signal);
			const compared = candidates
				.filter(({ id }) => input.afterId === undefined || id > input.afterId)
				.sort((x, y) => compareIds(x.id, y.id))
				.slice(0, input.batchSize);
			const pairs = new Map<string, FoundPair>();
			for (const memory of compared) {
				throwIfAborted(options?.signal);
				for (const { other, similarity } of nearestNeighbors(
					memory,
					candidates,
					input.neighbors,
				)) {
					if (similarity < input.threshold) {
						continue;
					}
					// A smaller id was compared on an earlier page (or this one) and
					// owns the pair when it found this memory itself.
					if (
						other.id < memory.id &&
						nearestNeighbors(other, candidates, input.neighbors).some(
							(neighbor) => neighbor.other.id === memory.id,
						)
					) {
						continue;
					}
					addPair(pairs, memory, other, similarity);
				}
			}
			return {
				pairs: sortPairs(pairs).map(toStorePair),
				compared: compared.length,
				lastId: compared.at(-1)?.id ?? null,
			};
		},
		async listAuditLog(input, options) {
			throwIfAborted(options?.signal);
			return auditLog
				.filter((event) => {
					throwIfAborted(options?.signal);
					if (!isSelected(event.scope, input.selector)) {
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
					if (
						input.beforeCursor !== undefined &&
						comparePositions(event, input.beforeCursor) >= 0
					) {
						return false;
					}
					if (
						input.afterCursor !== undefined &&
						comparePositions(event, input.afterCursor) <= 0
					) {
						return false;
					}
					return true;
				})
				.sort((a, b) => comparePositions(b, a))
				.slice(0, input.limit)
				.map(cloneAuditEvent);
		},
		async pruneAuditLog(input, options) {
			throwIfAborted(options?.signal);
			// One synchronous pass: with nothing awaited in between, batches
			// would change nothing, so `batchSize` only matters on Postgres.
			const before = input.before.getTime();
			const matches = (event: AuditEvent) =>
				event.timestamp.getTime() < before &&
				isSelected(event.scope, input.selector);
			if (input.dryRun) {
				const matchedCount = auditLog.filter(matches).length;
				return { matchedCount, deletedCount: 0, dryRun: true };
			}
			// Compact in place, keeping the order of the remaining events.
			let kept = 0;
			for (const event of auditLog) {
				if (!matches(event)) {
					auditLog[kept] = event;
					kept += 1;
				}
			}
			const deletedCount = auditLog.length - kept;
			auditLog.length = kept;
			return { matchedCount: deletedCount, deletedCount, dryRun: false };
		},
		async loadConsolidationTargets(visibility, ids, options) {
			return ids.flatMap((id) => {
				throwIfAborted(options?.signal);
				const memory = memories.get(id);
				if (!memory || !isVisible(memory.scope, visibility)) {
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
			if (
				!survivor ||
				!isVisible(survivor.scope, input.visibility) ||
				survivor.supersededBy !== null
			) {
				throw new MnemocyteError(
					"Consolidation survivor changed before mutation.",
					"CONFLICT",
				);
			}
			const newlySuperseded: StoredMemory[] = [];
			const targets: StoredMemory[] = [];
			for (const id of input.supersededIds) {
				throwIfAborted(options?.signal);
				const memory = memories.get(id);
				if (!memory || !isVisible(memory.scope, input.visibility)) {
					continue;
				}
				targets.push(memory);
			}
			if (
				targets.some(
					(memory) =>
						memory.supersededBy !== null &&
						memory.supersededBy !== input.survivorId,
				)
			) {
				throw new MnemocyteError(
					"Superseded memory already belongs to a different survivor.",
					"CONFLICT",
				);
			}
			for (const memory of targets) {
				if (memory.supersededBy === null) {
					newlySuperseded.push(memory);
				}
			}
			let mergedSurvivorTags: string[] | undefined;
			if (input.mergeTags && newlySuperseded.length > 0) {
				const mergedTags = new Set(survivor.tags);
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
				? newlySuperseded.map((memory) =>
						supersededEvent({
							scope: input.visibility.scope,
							memoryId: memory.id,
							survivorId: input.survivorId,
							now: input.now,
						}),
					)
				: [];
			throwIfAborted(options?.signal);
			for (const memory of newlySuperseded) {
				memory.supersededBy = input.survivorId;
				memory.supersededAt = input.now;
				memory.updatedAt = input.now;
			}
			if (mergedSurvivorTags) {
				survivor.tags = mergedSurvivorTags;
				survivor.updatedAt = input.now;
			}
			auditLog.push(...auditEvents);
			return { supersededIds: newlySuperseded.map((memory) => memory.id) };
		},
		async stats(selector, now) {
			const selected = Array.from(memories.values()).filter((memory) =>
				isSelected(memory.scope, selector),
			);
			return {
				entityCount: new Set(
					selected.map((memory) =>
						JSON.stringify([memory.scope.namespace, memory.scope.entityId]),
					),
				).size,
				memoryCount: selected.length,
				activeMemoryCount: selected.filter(
					(memory) => !isExpired(memory, now) && memory.supersededBy === null,
				).length,
				expiredMemoryCount: selected.filter((memory) => isExpired(memory, now))
					.length,
				supersededMemoryCount: selected.filter(
					(memory) => memory.supersededBy !== null,
				).length,
			} satisfies MemoryStats;
		},
	};
}

export function createInMemoryClient(config: MemoryConfig): CoreMemoryClient {
	return createMemoryClient(config, createInMemoryStore());
}
