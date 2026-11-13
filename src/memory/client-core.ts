import { buildContext } from "../context/builder.js";
import { MnemocyteError } from "../errors.js";
import {
	type ObservationMetadata,
	observe,
	observePrepared,
} from "../observability.js";
import { throwIfAborted } from "../resilience.js";
import {
	compareScoredMemories,
	createScoringConfig,
	DEFAULT_CANDIDATE_MULTIPLIER,
	type FusionCandidate,
	rankByScore,
	toScoredMemory,
} from "../retrieval/scorer.js";
import type {
	AddInput,
	AddManyInput,
	AuditEvent,
	ConsolidateResult,
	DuplicatePair,
	EmbeddingPurpose,
	JsonObject,
	Memory,
	MemoryClient,
	MemoryConfig,
	MemoryRecordScope,
	MemoryWithScore,
	NewMemory,
	SearchInput,
	UpdateInput,
} from "../types.js";
import { decodeListCursor, encodeListCursor } from "./cursor.js";
import {
	DEFAULT_AUDIT_LOG_LIMIT,
	DEFAULT_DUPLICATE_LIMIT,
	DEFAULT_DUPLICATE_NEIGHBORS,
	DEFAULT_DUPLICATE_THRESHOLD,
	DEFAULT_IMPORTANCE,
	DEFAULT_KIND,
	DEFAULT_LIMIT,
	DEFAULT_LIST_LIMIT,
	DEFAULT_MIN_SCORE,
} from "./defaults.js";
import { embedMany, embedOne } from "./embeddings.js";
import { snapshotMetadata } from "./json.js";
import { MAX_ADD_MANY } from "./limits.js";
import {
	cloneMemory,
	createEventId,
	createId,
	normalizeTags,
	type StoredMemory,
} from "./records.js";
import type {
	MemoryStore,
	StoreMemoryFilter,
	StoreMemoryPatch,
	StorePruneEntityDeletion,
	StorePruneResult,
	StoreScope,
	StoreSelector,
	StoreVisibility,
} from "./store.js";
import {
	assertDistinctKeys,
	assertKey,
	assertLimit,
	assertMinScore,
	assertNonEmptyString,
	assertOptionalSignal,
	contextInputToSearchInput,
	type PreparedNewMemory,
	type PreparedUpdateFields,
	validateConsolidateInput,
	validateContextInput,
	validateDeleteInput,
	validateEntitySelector,
	validateFindDuplicatesInput,
	validateListAuditLogInput,
	validateListFilter,
	validateNewMemory,
	validatePruneInput,
	validateScope,
	validateSearchInput,
	validateSelectorInput,
	validateUpdateFields,
	validateVisibility,
	writeVisibility,
} from "./validation.js";

function providerOptions(
	config: MemoryConfig,
	purpose: EmbeddingPurpose,
	signal: AbortSignal | undefined,
) {
	return {
		purpose,
		...(signal === undefined ? {} : { signal }),
		...(config.provider === undefined ? {} : { resilience: config.provider }),
	};
}

function storeOptions(signal: AbortSignal | undefined) {
	return signal === undefined ? undefined : { signal };
}

/**
 * Observation fields read from an unvalidated input's `scope`, so a
 * malformed input still produces its start and error events.
 */
function scopeMetadata(input: unknown): ObservationMetadata {
	if (typeof input !== "object" || input === null || !("scope" in input)) {
		return {};
	}
	const scope: unknown = input.scope;
	if (typeof scope !== "object" || scope === null) {
		return {};
	}
	const { namespace, entityId } = scope as {
		namespace?: unknown;
		entityId?: unknown;
	};
	return {
		...(typeof namespace === "string" ? { namespace } : {}),
		...(typeof entityId === "string" ? { entityId } : {}),
	};
}

function snapshotNewMemory(input: NewMemory): PreparedNewMemory {
	if (typeof input !== "object" || input === null) {
		throw new MnemocyteError("Each memory must be an object.", "VALIDATION");
	}
	return {
		content: input.content,
		...(input.key === undefined ? {} : { key: input.key }),
		...(input.kind === undefined ? {} : { kind: input.kind }),
		...(input.importance === undefined ? {} : { importance: input.importance }),
		...(input.tags === undefined
			? {}
			: { tags: Array.isArray(input.tags) ? [...input.tags] : input.tags }),
		...(input.source === undefined ? {} : { source: input.source }),
		metadata: snapshotMetadata(input.metadata ?? {}),
		...(input.confidence === undefined ? {} : { confidence: input.confidence }),
		...(input.expiresAt === undefined
			? {}
			: {
					expiresAt:
						input.expiresAt instanceof Date
							? new Date(input.expiresAt)
							: input.expiresAt,
				}),
	};
}

function snapshotUpdateFields(input: UpdateInput): PreparedUpdateFields {
	const fields: PreparedUpdateFields = {};
	if (input.content !== undefined) {
		fields.content = input.content;
	}
	if (input.key !== undefined) {
		fields.key = input.key;
	}
	if (input.kind !== undefined) {
		fields.kind = input.kind;
	}
	if (input.importance !== undefined) {
		fields.importance = input.importance;
	}
	if (input.tags !== undefined) {
		fields.tags = Array.isArray(input.tags) ? [...input.tags] : input.tags;
	}
	if (input.source !== undefined) {
		fields.source = input.source;
	}
	if (input.metadata !== undefined) {
		fields.metadata = snapshotMetadata(input.metadata);
	}
	if (input.confidence !== undefined) {
		fields.confidence = input.confidence;
	}
	if (input.expiresAt !== undefined) {
		fields.expiresAt =
			input.expiresAt instanceof Date
				? new Date(input.expiresAt)
				: input.expiresAt;
	}
	return fields;
}

function createStoredMemory(
	config: MemoryConfig,
	scope: StoreScope,
	input: PreparedNewMemory,
	embedding: number[],
	now: Date,
): StoredMemory {
	return {
		id: createId(),
		scope: { ...scope },
		key: input.key ?? null,
		content: input.content,
		kind: input.kind ?? DEFAULT_KIND,
		importance: input.importance ?? DEFAULT_IMPORTANCE,
		tags: normalizeTags(input.tags),
		source: input.source ?? null,
		metadata: input.metadata,
		confidence: input.confidence ?? 1,
		embeddingModel: config.embedder.model,
		embeddingDimensions: config.embedder.dimensions,
		supersededBy: null,
		supersededAt: null,
		expiresAt: input.expiresAt ?? null,
		lastAccessedAt: null,
		accessCount: 0,
		createdAt: now,
		updatedAt: now,
		embedding,
	};
}

function auditEvent(
	scope: MemoryRecordScope,
	description: string,
	metadata: JsonObject,
	timestamp = new Date(),
): AuditEvent {
	return {
		id: createEventId(),
		scope: { ...scope },
		description,
		metadata,
		timestamp,
	};
}

interface InsertOutcome {
	memory: Memory;
	/** `false` when a keyed row updated an existing memory. */
	created: boolean;
}

/**
 * Match store results to prepared rows. Store order is untrusted: an inserted
 * row comes back with its prepared id, a keyed row that updated an existing
 * memory with that memory's id and the prepared key.
 */
function matchInsertResults(
	prepared: readonly StoredMemory[],
	returned: readonly Memory[],
): InsertOutcome[] {
	const byId = new Map<string, Memory>();
	const byKey = new Map<string, Memory>();
	for (const memory of returned) {
		if (byId.has(memory.id)) {
			throw new MnemocyteError("Memory insert returned a duplicate ID.", "DB");
		}
		byId.set(memory.id, memory);
		if (memory.key !== null) {
			byKey.set(memory.key, memory);
		}
	}
	const used = new Set<string>();
	const outcomes = prepared.map((row) => {
		const inserted = byId.get(row.id);
		const memory =
			inserted ?? (row.key === null ? undefined : byKey.get(row.key));
		if (!memory || used.has(memory.id)) {
			throw new MnemocyteError(
				"Memory insert did not return every requested row.",
				"DB",
			);
		}
		used.add(memory.id);
		return { memory, created: inserted !== undefined };
	});
	if (used.size !== returned.length) {
		throw new MnemocyteError("Memory insert returned an unknown ID.", "DB");
	}
	return outcomes;
}

function writeAuditEvent(outcome: InsertOutcome): AuditEvent {
	const { memory } = outcome;
	return auditEvent(
		memory.scope,
		outcome.created ? "memory.created" : "memory.updated",
		{
			memoryId: memory.id,
			kind: memory.kind,
			importance: memory.importance,
			...(memory.key === null ? {} : { key: memory.key }),
		},
	);
}

function normalizePruneEntityDeletions(
	result: StorePruneResult,
	selector: StoreSelector,
): StorePruneEntityDeletion[] {
	const seen = new Set<string>();
	let detailedDeletedCount = 0;

	for (const detail of result.deletedByEntity) {
		const entityKey = JSON.stringify([detail.namespace, detail.entityId]);
		if (
			detail.entityId.length === 0 ||
			!Number.isInteger(detail.deletedCount) ||
			detail.deletedCount <= 0 ||
			seen.has(entityKey) ||
			(selector.namespace !== null &&
				detail.namespace !== selector.namespace) ||
			(selector.entityId !== undefined && detail.entityId !== selector.entityId)
		) {
			throw new MnemocyteError(
				"Memory prune returned invalid per-entity deletion details.",
				"DB",
			);
		}
		seen.add(entityKey);
		detailedDeletedCount += detail.deletedCount;
	}

	if (
		detailedDeletedCount !== result.deletedCount ||
		(result.dryRun && result.deletedByEntity.length > 0)
	) {
		throw new MnemocyteError(
			"Memory prune deletion details did not match the deleted count.",
			"DB",
		);
	}

	return [...result.deletedByEntity];
}

function toDuplicatePair(pair: {
	a: Memory;
	b: Memory;
	similarity: number;
}): DuplicatePair {
	return {
		a: cloneMemory(pair.a),
		b: cloneMemory(pair.b),
		similarity: Math.max(0, Math.min(1, pair.similarity)),
	};
}

function memoryFilter(
	visibility: StoreVisibility,
	input: {
		kinds?: StoreMemoryFilter["kinds"];
		tags?: StoreMemoryFilter["tags"];
		before?: Date;
		after?: Date;
		includeSuperseded?: boolean;
		includeExpired?: boolean;
	},
): StoreMemoryFilter {
	return {
		visibility,
		...(input.kinds === undefined ? {} : { kinds: [...input.kinds] }),
		...(input.tags === undefined ? {} : { tags: [...input.tags] }),
		...(input.before === undefined ? {} : { before: new Date(input.before) }),
		...(input.after === undefined ? {} : { after: new Date(input.after) }),
		...(input.includeSuperseded === undefined
			? {}
			: { includeSuperseded: input.includeSuperseded }),
		...(input.includeExpired === undefined
			? {}
			: { includeExpired: input.includeExpired }),
	};
}

/**
 * The client methods that take a full scope. `createMemory` adds the
 * default namespace and `for()` on top (`memory/scope-binding.ts`).
 */
export type CoreMemoryClient = Omit<MemoryClient, "for">;

export function createMemoryClient(
	config: MemoryConfig,
	store: MemoryStore,
): CoreMemoryClient {
	async function ensureEmbeddingCompatibility(): Promise<void> {
		await store.ensureEmbeddingCompatibility(config.embedder);
	}

	async function recordAudit(events: readonly AuditEvent[]): Promise<void> {
		if (events.length === 0 || config.audit?.enabled !== true) {
			return;
		}
		try {
			await store.addAuditEvents(events);
		} catch {
			// Audit writes must not break the primary operation.
		}
	}

	/**
	 * Starts the access write for a search's results without waiting for it.
	 * The store call begins before search resolves, so the driver already has
	 * the statement; failures go to `onEvent` as `"trackAccess"` errors.
	 */
	function trackAccess(
		visibility: StoreVisibility,
		memoryIds: readonly string[],
	): void {
		if (memoryIds.length === 0) {
			return;
		}
		// Settled into a value at once, so a failure that lands before the
		// observed action awaits it is never an unhandled rejection.
		const outcome = store.markMemoriesAccessed(visibility, memoryIds).then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		observe(
			config,
			store.backend,
			"trackAccess",
			{
				namespace: visibility.scope.namespace,
				entityId: visibility.scope.entityId,
				count: memoryIds.length,
			},
			async () => {
				const result = await outcome;
				if (!result.ok) {
					throw result.error;
				}
			},
		).catch(() => {
			// Reported through onEvent; access tracking never fails a search.
		});
	}

	function add(input: AddInput): Promise<Memory> {
		return observePrepared(
			config,
			store.backend,
			"add",
			scopeMetadata(input),
			() => ({
				scope: validateScope(input.scope),
				memory: snapshotNewMemory(input),
				signal: input.signal,
			}),
			async ({ scope, memory, signal }) => {
				validateNewMemory(memory);
				assertOptionalSignal(signal);
				await ensureEmbeddingCompatibility();
				const embedding = await embedOne(
					config.embedder,
					memory.content,
					providerOptions(config, "document", signal),
				);
				const stored = [
					createStoredMemory(config, scope, memory, embedding, new Date()),
				];
				const [outcome] = matchInsertResults(
					stored,
					await store.insertMemories(stored),
				);
				if (!outcome) {
					throw new MnemocyteError(
						"Memory insert did not return the inserted row.",
						"DB",
					);
				}
				await recordAudit([writeAuditEvent(outcome)]);
				return outcome.memory;
			},
			(memory) => ({ memoryId: memory.id, count: 1 }),
		);
	}

	function addMany(input: AddManyInput): Promise<Memory[]> {
		const count = Array.isArray(input?.memories)
			? input.memories.length
			: undefined;
		return observePrepared(
			config,
			store.backend,
			"addMany",
			{ ...scopeMetadata(input), ...(count === undefined ? {} : { count }) },
			() => {
				const scope = validateScope(input.scope);
				if (!Array.isArray(input.memories)) {
					throw new MnemocyteError("memories must be an array.", "VALIDATION");
				}
				if (input.memories.length > MAX_ADD_MANY) {
					throw new MnemocyteError(
						`memories must contain at most ${MAX_ADD_MANY} items; split larger batches into several addMany calls.`,
						"VALIDATION",
					);
				}
				return {
					scope,
					memories: input.memories.map(snapshotNewMemory),
					signal: input.signal,
				};
			},
			async ({ scope, memories, signal }) => {
				assertOptionalSignal(signal);
				if (memories.length === 0) {
					return [];
				}
				for (const memory of memories) {
					validateNewMemory(memory);
				}
				assertDistinctKeys(memories);
				await ensureEmbeddingCompatibility();
				const embeddings = await embedMany(
					config.embedder,
					memories.map((memory) => memory.content),
					providerOptions(config, "document", signal),
				);
				const now = new Date();
				const stored = memories.map((memory, index) =>
					createStoredMemory(
						config,
						scope,
						memory,
						embeddings[index] as number[],
						now,
					),
				);
				// Every chunk was embedded above, outside any transaction; the
				// store writes all rows in one transaction, so a failure writes
				// none of them.
				const outcomes = matchInsertResults(
					stored,
					await store.insertMemories(stored, storeOptions(signal)),
				);
				await recordAudit(outcomes.map(writeAuditEvent));
				return outcomes.map((outcome) => outcome.memory);
			},
			(result) => ({ count: result.length }),
		);
	}

	function search(input: SearchInput): Promise<MemoryWithScore[]> {
		return observe(
			config,
			store.backend,
			"search",
			scopeMetadata(input),
			async () => {
				const visibility = validateSearchInput(input);
				const limit = input.limit ?? config.defaults?.limit ?? DEFAULT_LIMIT;
				const minScore =
					input.minScore ?? config.defaults?.minScore ?? DEFAULT_MIN_SCORE;
				assertLimit(limit);
				assertMinScore(minScore);
				await ensureEmbeddingCompatibility();
				const queryEmbedding = await embedOne(
					config.embedder,
					input.query,
					providerOptions(config, "query", input.signal),
				);
				const candidateMultiplier =
					config.retrieval?.candidateMultiplier ?? DEFAULT_CANDIDATE_MULTIPLIER;
				const candidateLimit = Math.max(limit, limit * candidateMultiplier);
				const scoringConfig = createScoringConfig(config.retrieval);
				const filter = memoryFilter(visibility, input);
				// A list with weight 0 cannot change the fused score, so its
				// search is skipped instead of adding unranked candidates.
				const [vectorCandidates, lexicalCandidates] = await Promise.all([
					scoringConfig.fusion.vector > 0
						? store.vectorSearch({
								...filter,
								embedding: queryEmbedding,
								limit: candidateLimit,
								minVectorScore: 0,
							})
						: [],
					scoringConfig.fusion.lexical > 0
						? store.lexicalSearch({
								...filter,
								query: input.query,
								limit: candidateLimit,
							})
						: [],
				]);
				const merged = new Map<string, FusionCandidate>();
				const vectorRanks = rankByScore(
					vectorCandidates.map((candidate) => candidate.vectorScore),
				);
				vectorCandidates.forEach((candidate, index) => {
					merged.set(candidate.memory.id, {
						memory: candidate.memory,
						vectorRank: vectorRanks[index] ?? null,
						lexicalRank: null,
						vectorScore: candidate.vectorScore,
						lexicalScore: null,
					});
				});
				const lexicalRanks = rankByScore(
					lexicalCandidates.map((candidate) => candidate.lexicalScore),
				);
				lexicalCandidates.forEach((candidate, index) => {
					const lexicalRank = lexicalRanks[index] ?? null;
					const existing = merged.get(candidate.memory.id);
					if (existing) {
						existing.lexicalRank = lexicalRank;
						existing.lexicalScore = candidate.lexicalScore;
						return;
					}
					merged.set(candidate.memory.id, {
						memory: candidate.memory,
						vectorRank: null,
						lexicalRank,
						vectorScore: null,
						lexicalScore: candidate.lexicalScore,
					});
				});
				const scored: MemoryWithScore[] = Array.from(merged.values())
					.map((candidate) => toScoredMemory(candidate, input, scoringConfig))
					.filter((memory) => memory.score >= minScore)
					.sort(compareScoredMemories)
					.slice(0, limit);
				if (input.trackAccess ?? config.retrieval?.trackAccess ?? false) {
					trackAccess(
						visibility,
						scored.map((memory) => memory.id),
					);
				}
				return scored;
			},
			(result) => ({ count: result.length }),
		);
	}

	const client: Omit<CoreMemoryClient, "experimental"> = {
		add,
		addMany,
		search,
		get(input) {
			return observe(
				config,
				store.backend,
				"get",
				scopeMetadata(input),
				async () => {
					const visibility = validateVisibility(input);
					assertOptionalSignal(input.signal);
					throwIfAborted(input.signal);
					const hasId = input.id !== undefined;
					const hasKey = input.key !== undefined;
					if (hasId === hasKey) {
						throw new MnemocyteError(
							"get requires exactly one of id or key.",
							"VALIDATION",
						);
					}
					if (hasId) {
						assertNonEmptyString(input.id, "id");
						return store.getMemory(
							visibility,
							input.id,
							storeOptions(input.signal),
						);
					}
					assertKey(input.key);
					return store.getMemoryByKey(
						visibility.scope,
						input.key,
						storeOptions(input.signal),
					);
				},
				(memory) => ({
					count: memory ? 1 : 0,
					...(memory ? { memoryId: memory.id } : {}),
				}),
			);
		},
		list(input) {
			return observe(
				config,
				store.backend,
				"list",
				scopeMetadata(input),
				async () => {
					const visibility = validateVisibility(input);
					validateListFilter(input);
					throwIfAborted(input.signal);
					const limit = input.limit ?? DEFAULT_LIST_LIMIT;
					const position =
						input.cursor === undefined
							? undefined
							: decodeListCursor(input.cursor);
					// One extra row says whether another page exists.
					const rows = await store.listMemories(
						{
							...memoryFilter(visibility, input),
							limit: limit + 1,
							...(position === undefined ? {} : { position }),
						},
						storeOptions(input.signal),
					);
					const memories = rows.slice(0, limit);
					const last = memories.at(-1);
					return {
						memories,
						nextCursor:
							rows.length > limit && last
								? encodeListCursor({ createdAt: last.createdAt, id: last.id })
								: null,
					};
				},
				(result) => ({ count: result.memories.length }),
			);
		},
		update(input) {
			return observePrepared(
				config,
				store.backend,
				"update",
				{
					...scopeMetadata(input),
					...(typeof input?.id === "string" ? { memoryId: input.id } : {}),
				},
				() => ({
					scope: validateScope(input.scope),
					fields: snapshotUpdateFields(input),
				}),
				async ({ scope, fields }) => {
					assertNonEmptyString(input.id, "id");
					validateUpdateFields(fields);
					assertOptionalSignal(input.signal);
					let embedding: number[] | undefined;
					if (fields.content !== undefined) {
						await ensureEmbeddingCompatibility();
						embedding = await embedOne(
							config.embedder,
							fields.content,
							providerOptions(config, "document", input.signal),
						);
					}
					throwIfAborted(input.signal);
					const patch: StoreMemoryPatch = {
						...fields,
						...(fields.tags === undefined
							? {}
							: { tags: normalizeTags(fields.tags) }),
						...(embedding === undefined
							? {}
							: {
									embedding,
									embeddingModel: config.embedder.model,
									embeddingDimensions: config.embedder.dimensions,
								}),
					};
					const memory = await store.updateMemory({
						visibility: writeVisibility(scope),
						id: input.id,
						patch,
						now: new Date(),
					});
					if (!memory) {
						throw new MnemocyteError("Memory was not found.", "NOT_FOUND");
					}
					await recordAudit([
						auditEvent(memory.scope, "memory.updated", {
							memoryId: memory.id,
							fields: Object.keys(fields).sort(),
						}),
					]);
					return memory;
				},
				(memory) => ({ memoryId: memory.id, count: 1 }),
			);
		},
		delete(input) {
			return observe(
				config,
				store.backend,
				"delete",
				{
					...scopeMetadata(input),
					...(typeof input?.id === "string" ? { memoryId: input.id } : {}),
				},
				async () => {
					const { scope, dependents } = validateDeleteInput(input);
					throwIfAborted(input.signal);
					const result = await store.deleteMemory(
						{
							visibility: writeVisibility(scope),
							memoryId: input.id,
							dependents,
							now: new Date(),
						},
						storeOptions(input.signal),
					);
					if (!result) {
						throw new MnemocyteError("Memory was not found.", "NOT_FOUND");
					}
					await recordAudit(
						result.deletedIds.map((memoryId) =>
							auditEvent(
								scope,
								"memory.deleted",
								memoryId === input.id
									? {
											memoryId,
											...(result.restoredIds.length > 0
												? { restoredIds: [...result.restoredIds] }
												: {}),
										}
									: { memoryId, deletedWith: input.id },
							),
						),
					);
				},
			);
		},
		deleteScope(input) {
			return observe(
				config,
				store.backend,
				"deleteScope",
				scopeMetadata(input),
				async () => {
					const selector = validateEntitySelector(input?.scope);
					assertOptionalSignal(input.signal);
					throwIfAborted(input.signal);
					const deletedCount = await store.deleteScope(
						selector,
						storeOptions(input.signal),
					);
					return { deletedCount };
				},
				(result) => ({ count: result.deletedCount }),
			);
		},
		context(input) {
			return observe(
				config,
				store.backend,
				"context",
				scopeMetadata(input),
				async () => {
					validateContextInput(input);
					return buildContext({
						input,
						search: (contextInput) =>
							search(contextInputToSearchInput(contextInput)),
					});
				},
			);
		},
		prune(input) {
			return observe(
				config,
				store.backend,
				"prune",
				scopeMetadata(input),
				async () => {
					throwIfAborted(input?.signal);
					const filter = validatePruneInput(input);
					const result = await store.prune(filter, storeOptions(input.signal));
					const deletedByEntity = normalizePruneEntityDeletions(
						result,
						filter.selector,
					);
					if (result.deletedCount > 0 && result.dryRun === false) {
						await recordAudit(
							deletedByEntity.map((detail) =>
								auditEvent(
									{
										namespace: detail.namespace,
										entityId: detail.entityId,
										agentId: filter.selector.agentId ?? null,
										sessionId: filter.selector.sessionId ?? null,
									},
									"memory.pruned",
									{ count: detail.deletedCount },
								),
							),
						);
					}
					return {
						matchedCount: result.matchedCount,
						deletedCount: result.deletedCount,
						dryRun: result.dryRun,
					};
				},
				(result) => ({ count: result.deletedCount }),
			);
		},
		findDuplicates(input) {
			return observe(
				config,
				store.backend,
				"findDuplicates",
				scopeMetadata(input),
				async () => {
					throwIfAborted(input?.signal);
					const visibility = validateFindDuplicatesInput(input);
					await ensureEmbeddingCompatibility();
					const pairs = await store.findDuplicatePairs(
						{
							...memoryFilter(visibility, input),
							threshold: input.threshold ?? DEFAULT_DUPLICATE_THRESHOLD,
							limit: input.limit ?? DEFAULT_DUPLICATE_LIMIT,
							neighbors: input.neighbors ?? DEFAULT_DUPLICATE_NEIGHBORS,
						},
						storeOptions(input.signal),
					);
					return pairs.map(toDuplicatePair);
				},
				(result) => ({ count: result.length }),
			);
		},
		listAuditLog(input) {
			return observe(
				config,
				store.backend,
				"listAuditLog",
				scopeMetadata(input),
				async () => {
					throwIfAborted(input?.signal);
					const selector = validateListAuditLogInput(input);
					return store.listAuditLog(
						{
							selector,
							limit: input.limit ?? DEFAULT_AUDIT_LOG_LIMIT,
							...(input.before === undefined ? {} : { before: input.before }),
							...(input.after === undefined ? {} : { after: input.after }),
							...(input.beforeCursor === undefined
								? {}
								: { beforeCursor: input.beforeCursor }),
							...(input.afterCursor === undefined
								? {}
								: { afterCursor: input.afterCursor }),
						},
						storeOptions(input.signal),
					);
				},
				(result) => ({ count: result.length }),
			);
		},
		stats(input) {
			return observe(
				config,
				store.backend,
				"stats",
				scopeMetadata(input),
				async () => {
					const selector = validateSelectorInput(input);
					return store.stats(selector, new Date());
				},
			);
		},
		consolidate(input) {
			return observe(
				config,
				store.backend,
				"consolidate",
				{
					...scopeMetadata(input),
					...(typeof input?.survivorId === "string"
						? { memoryId: input.survivorId }
						: {}),
				},
				async () => {
					throwIfAborted(input?.signal);
					const visibility = writeVisibility(validateConsolidateInput(input));
					const survivor = await store.getMemory(
						visibility,
						input.survivorId,
						storeOptions(input.signal),
					);
					throwIfAborted(input.signal);
					if (!survivor) {
						throw new MnemocyteError(
							"Survivor memory was not found.",
							"NOT_FOUND",
						);
					}
					if (survivor.supersededBy !== null) {
						throw new MnemocyteError(
							"Survivor memory is itself superseded.",
							"VALIDATION",
						);
					}
					const targets = await store.loadConsolidationTargets(
						visibility,
						input.supersededIds,
						storeOptions(input.signal),
					);
					throwIfAborted(input.signal);
					const foundIds = new Set(targets.map((target) => target.id));
					for (const id of input.supersededIds) {
						if (!foundIds.has(id)) {
							throw new MnemocyteError(
								"Superseded memory was not found.",
								"NOT_FOUND",
							);
						}
					}
					if (
						targets.some(
							(target) =>
								target.supersededBy !== null &&
								target.supersededBy !== survivor.id,
						)
					) {
						throw new MnemocyteError(
							"Superseded memory already belongs to a different survivor.",
							"CONFLICT",
						);
					}
					const losers = targets.filter(
						(target) => target.supersededBy === null,
					);
					if (losers.length === 0) {
						return {
							survivorId: survivor.id,
							supersededCount: 0,
							supersededIds: [],
						} satisfies ConsolidateResult;
					}
					const result = await store.consolidate(
						{
							visibility,
							survivorId: survivor.id,
							supersededIds: input.supersededIds,
							mergeTags: input.mergeTags !== false,
							now: new Date(),
							auditEnabled: config.audit?.enabled === true,
						},
						storeOptions(input.signal),
					);
					return {
						survivorId: survivor.id,
						supersededCount: result.supersededIds.length,
						supersededIds: result.supersededIds,
					} satisfies ConsolidateResult;
				},
				(result) => ({ count: result.supersededCount }),
			);
		},
	};
	return {
		...client,
		experimental: {
			// Deprecated alias of `consolidate`, removed in 1.0.
			consolidate: (input) => client.consolidate(input),
		},
	};
}
