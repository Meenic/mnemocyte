import { buildContext } from "../context/builder.js";
import type { DatabaseHandle } from "../db/index.js";
import { insertEvent, listEvents } from "../db/queries/events.js";
import {
	countPruneMatches,
	deleteMemoriesForEntity,
	deleteMemory,
	findDuplicatePairs,
	getEntityMemoryStatsCounts,
	getGlobalMemoryStatsCounts,
	getMemoryById,
	insertMemories,
	insertMemory,
	loadConsolidationTargets,
	markMemoriesSuperseded,
	type PruneFilter,
	pruneMemories,
	setMemoryTags,
} from "../db/queries/memories.js";
import type { EventRow } from "../db/schema.js";
import { MnemocyteError } from "../errors.js";
import { observe } from "../observability.js";
import { hybridRecall } from "../retrieval/index.js";
import type {
	AuditEvent,
	ConsolidateInput,
	ConsolidateResult,
	DuplicatePair,
	EntityStats,
	ExperimentalMnemocyteClient,
	FindDuplicatesInput,
	GlobalStats,
	ImportanceLevel,
	ListAuditLogInput,
	Memory,
	MnemocyteClient,
	MnemocyteConfig,
	PruneInput,
	PruneResult,
	RememberInput,
} from "../types.js";
import {
	assertLimit,
	assertMinScore,
	assertNonEmptyString,
	contextInputToRecallInput,
	createEventId,
	createId,
	DEFAULT_AUDIT_LOG_LIMIT,
	DEFAULT_DUPLICATE_LIMIT,
	DEFAULT_DUPLICATE_THRESHOLD,
	DEFAULT_IMPORTANCE,
	DEFAULT_LIMIT,
	DEFAULT_MIN_SCORE,
	DEFAULT_TYPE,
	embedMany,
	embedOne,
	IMPORTANCE_RANK,
	normalizeTags,
	rowToMemory,
	validateConsolidateInput,
	validateFindDuplicatesInput,
	validateListAuditLogInput,
	validatePruneInput,
	validateRecallInput,
	validateRememberInput,
} from "./shared.js";

function rowToAuditEvent(row: EventRow): AuditEvent {
	return {
		id: row.id,
		entityId: row.entityId,
		description: row.description,
		metadata: row.metadata as Record<string, unknown>,
		timestamp: row.timestamp,
	};
}

const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = [
	"low",
	"normal",
	"high",
	"critical",
];

function importanceCeilingLevels(
	max: ImportanceLevel,
): readonly ImportanceLevel[] {
	return IMPORTANCE_LEVELS.filter(
		(level) => IMPORTANCE_RANK[level] <= IMPORTANCE_RANK[max],
	);
}

function toPruneFilter(input: PruneInput): PruneFilter {
	const filter: PruneFilter = {};
	if (input.entityId !== undefined) {
		filter.entityId = input.entityId;
	}
	if (input.expired === true) {
		filter.expired = true;
	}
	if (input.superseded === true) {
		filter.superseded = true;
	}
	if (input.createdBefore !== undefined) {
		filter.createdBefore = input.createdBefore;
	}
	if (input.notAccessedSince !== undefined) {
		filter.notAccessedSince = input.notAccessedSince;
	}
	if (input.types !== undefined && input.types.length > 0) {
		filter.types = input.types;
	}
	if (input.tags !== undefined && input.tags.length > 0) {
		filter.tags = input.tags;
	}
	if (input.maxImportance !== undefined) {
		filter.maxImportanceLevels = importanceCeilingLevels(input.maxImportance);
	}
	return filter;
}

export function createPostgresClient(
	config: MnemocyteConfig,
	handle: DatabaseHandle,
): MnemocyteClient {
	let closed = false;

	function assertOpen(): void {
		if (closed) {
			throw new MnemocyteError("Mnemocyte client is closed.", "DB");
		}
	}

	async function recordAudit(
		entityId: string,
		description: string,
		metadata: Record<string, unknown>,
	): Promise<void> {
		if (config.audit?.enabled !== true) {
			return;
		}
		try {
			await insertEvent(handle.db, {
				id: createEventId(),
				entityId,
				description,
				metadata,
				timestamp: new Date(),
			});
		} catch {
			// Audit writes must not break the primary operation.
		}
	}

	async function remember(input: RememberInput): Promise<Memory> {
		return observe(
			config,
			"postgres",
			"remember",
			{ entityId: input.entityId },
			async () => {
				assertOpen();
				validateRememberInput(input);
				const embedding = await embedOne(config.embedder, input.content, {
					...(input.signal === undefined ? {} : { signal: input.signal }),
					...(config.provider === undefined
						? {}
						: { resilience: config.provider }),
				});
				const now = new Date();
				const row = await insertMemory(handle.db, {
					id: createId(),
					entityId: input.entityId,
					content: input.content,
					type: input.type ?? DEFAULT_TYPE,
					importance: input.importance ?? DEFAULT_IMPORTANCE,
					tags: normalizeTags(input.tags),
					source: input.source ?? null,
					metadata: input.metadata ?? {},
					confidence: input.confidence ?? 1,
					embedding,
					embeddingModel: config.embedder.model,
					embeddingDimensions: config.embedder.dimensions,
					supersededBy: null,
					supersededAt: null,
					expiresAt: input.expiresAt ?? null,
					lastAccessedAt: null,
					accessCount: 0,
					createdAt: now,
					updatedAt: now,
				});
				const memory = rowToMemory(row);
				await recordAudit(memory.entityId, "memory.created", {
					memoryId: memory.id,
					type: memory.type,
					importance: memory.importance,
				});
				return memory;
			},
			(memory) => ({ memoryId: memory.id, count: 1 }),
		);
	}

	const client: MnemocyteClient = {
		remember,
		async rememberMany(inputs) {
			return observe(
				config,
				"postgres",
				"rememberMany",
				{ count: inputs.length },
				async () => {
					assertOpen();
					if (inputs.length === 0) {
						return [];
					}
					for (const input of inputs) {
						validateRememberInput(input);
					}
					const embeddings = await embedMany(
						config.embedder,
						inputs.map((i) => i.content),
						{
							...(inputs[0]?.signal === undefined
								? {}
								: { signal: inputs[0].signal }),
							...(config.provider === undefined
								? {}
								: { resilience: config.provider }),
						},
					);
					const now = new Date();
					const rows = inputs.map((input, idx) => ({
						id: createId(),
						entityId: input.entityId,
						content: input.content,
						type: input.type ?? DEFAULT_TYPE,
						importance: input.importance ?? DEFAULT_IMPORTANCE,
						tags: normalizeTags(input.tags),
						source: input.source ?? null,
						metadata: input.metadata ?? {},
						confidence: input.confidence ?? 1,
						embedding: embeddings[idx] as number[],
						embeddingModel: config.embedder.model,
						embeddingDimensions: config.embedder.dimensions,
						supersededBy: null,
						supersededAt: null,
						expiresAt: input.expiresAt ?? null,
						lastAccessedAt: null,
						accessCount: 0,
						createdAt: now,
						updatedAt: now,
					}));
					const inserted = await insertMemories(handle.db, rows);
					const memories = inserted.map(rowToMemory);
					for (const memory of memories) {
						void recordAudit(memory.entityId, "memory.created", {
							memoryId: memory.id,
							type: memory.type,
							importance: memory.importance,
						});
					}
					return memories;
				},
				(result) => ({ count: result.length }),
			);
		},
		async recall(input) {
			return observe(
				config,
				"postgres",
				"recall",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					validateRecallInput(input);
					const limit = input.limit ?? config.defaults?.limit ?? DEFAULT_LIMIT;
					const minScore =
						input.minScore ?? config.defaults?.minScore ?? DEFAULT_MIN_SCORE;
					assertLimit(limit);
					assertMinScore(minScore);
					return hybridRecall({
						db: handle.db,
						embedder: config.embedder,
						input,
						limit,
						minScore,
						retrieval: config.retrieval,
						...(input.signal === undefined ? {} : { signal: input.signal }),
						...(config.provider === undefined
							? {}
							: { resilience: config.provider }),
					});
				},
				(result) => ({ count: result.length }),
			);
		},
		async buildContext(input) {
			return observe(
				config,
				"postgres",
				"buildContext",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					return buildContext({
						input,
						recall: (contextInput) => {
							const recallInput = contextInputToRecallInput(contextInput);
							return client.recall(
								input.signal === undefined
									? recallInput
									: { ...recallInput, signal: input.signal },
							);
						},
					});
				},
			);
		},
		async forget(input) {
			return observe(
				config,
				"postgres",
				"forget",
				{ entityId: input.entityId, memoryId: input.memoryId },
				async () => {
					assertOpen();
					assertNonEmptyString(input.entityId, "entityId");
					assertNonEmptyString(input.memoryId, "memoryId");
					const deleted = await deleteMemory(
						handle.db,
						input.entityId,
						input.memoryId,
					);
					if (!deleted) {
						throw new MnemocyteError("Memory was not found.", "NOT_FOUND");
					}
					await recordAudit(input.entityId, "memory.deleted", {
						memoryId: input.memoryId,
					});
				},
			);
		},
		async forgetAll(input) {
			return observe(
				config,
				"postgres",
				"forgetAll",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					assertNonEmptyString(input.entityId, "entityId");
					const deletedCount = await deleteMemoriesForEntity(
						handle.db,
						input.entityId,
					);
					await recordAudit(input.entityId, "entity.cleared", {
						count: deletedCount,
					});
					return deletedCount;
				},
				(count) => ({ count }),
			).then(() => undefined);
		},
		async prune(input: PruneInput): Promise<PruneResult> {
			return observe(
				config,
				"postgres",
				"prune",
				input.entityId === undefined ? {} : { entityId: input.entityId },
				async () => {
					assertOpen();
					validatePruneInput(input);
					const filter = toPruneFilter(input);
					const dryRun = input.dryRun === true;
					if (dryRun) {
						const matchedCount = await countPruneMatches(handle.db, filter);
						return { matchedCount, deletedCount: 0, dryRun: true };
					}
					const deletedCount = await pruneMemories(handle.db, filter);
					if (deletedCount > 0 && input.entityId !== undefined) {
						await recordAudit(input.entityId, "memory.pruned", {
							count: deletedCount,
						});
					}
					return {
						matchedCount: deletedCount,
						deletedCount,
						dryRun: false,
					};
				},
				(result) => ({ count: result.deletedCount }),
			);
		},
		async findDuplicates(input: FindDuplicatesInput): Promise<DuplicatePair[]> {
			return observe(
				config,
				"postgres",
				"findDuplicates",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					validateFindDuplicatesInput(input);
					const threshold = input.threshold ?? DEFAULT_DUPLICATE_THRESHOLD;
					const limit = input.limit ?? DEFAULT_DUPLICATE_LIMIT;
					const rows = await findDuplicatePairs(handle.db, {
						entityId: input.entityId,
						threshold,
						limit,
						...(input.types === undefined ? {} : { types: input.types }),
						...(input.tags === undefined ? {} : { tags: input.tags }),
						...(input.includeSuperseded === undefined
							? {}
							: { includeSuperseded: input.includeSuperseded }),
						...(input.includeExpired === undefined
							? {}
							: { includeExpired: input.includeExpired }),
					});
					return rows.map((row) => ({
						a: rowToMemory(row.a),
						b: rowToMemory(row.b),
						similarity: Math.max(0, Math.min(1, row.similarity)),
					}));
				},
				(result) => ({ count: result.length }),
			);
		},
		async listAuditLog(input: ListAuditLogInput): Promise<AuditEvent[]> {
			return observe(
				config,
				"postgres",
				"listAuditLog",
				{ entityId: input.entityId },
				async () => {
					assertOpen();
					validateListAuditLogInput(input);
					const rows = await listEvents(handle.db, {
						entityId: input.entityId,
						limit: input.limit ?? DEFAULT_AUDIT_LOG_LIMIT,
						...(input.before === undefined ? {} : { before: input.before }),
						...(input.after === undefined ? {} : { after: input.after }),
					});
					return rows.map(rowToAuditEvent);
				},
				(result) => ({ count: result.length }),
			);
		},
		async stats(input) {
			return observe(
				config,
				"postgres",
				"stats",
				input?.entityId ? { entityId: input.entityId } : {},
				async () => {
					assertOpen();
					const now = new Date();
					if (input?.entityId) {
						const counts = await getEntityMemoryStatsCounts(
							handle.db,
							input.entityId,
							now,
						);
						return {
							entityId: input.entityId,
							...counts,
						} satisfies EntityStats;
					}
					return (await getGlobalMemoryStatsCounts(
						handle.db,
						now,
					)) satisfies GlobalStats;
				},
			);
		},
		experimental: createExperimental(),
		async close() {
			return observe(config, "postgres", "close", {}, async () => {
				closed = true;
				await handle.close();
			});
		},
	};
	return client;

	function createExperimental(): ExperimentalMnemocyteClient {
		return {
			async consolidate(input: ConsolidateInput): Promise<ConsolidateResult> {
				return observe(
					config,
					"postgres",
					"consolidate",
					{ entityId: input.entityId, memoryId: input.survivorId },
					async () => {
						assertOpen();
						validateConsolidateInput(input);
						const survivor = await getMemoryById(
							handle.db,
							input.entityId,
							input.survivorId,
						);
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
						const targets = await loadConsolidationTargets(
							handle.db,
							input.entityId,
							input.supersededIds,
						);
						const foundIds = new Set(targets.map((t) => t.id));
						for (const id of input.supersededIds) {
							if (!foundIds.has(id)) {
								throw new MnemocyteError(
									"Superseded memory was not found.",
									"NOT_FOUND",
								);
							}
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
						const now = new Date();
						const { newSupersededIds } = await handle.db.transaction(
							async (tx) => {
								const updated = await markMemoriesSuperseded(tx, {
									survivorId: survivor.id,
									entityId: input.entityId,
									ids: losers.map((loser) => loser.id),
									now,
								});
								const newSupersededIds = updated.map((row) => row.id);
								if (config.audit?.enabled === true) {
									for (const id of newSupersededIds) {
										await insertEvent(tx, {
											id: createEventId(),
											entityId: input.entityId,
											description: "memory.superseded",
											metadata: { memoryId: id, supersededBy: survivor.id },
											timestamp: now,
										});
									}
								}
								if (input.mergeTags !== false && updated.length > 0) {
									const mergedTags = new Set(survivor.tags);
									for (const row of updated) {
										for (const tag of row.tags) {
											mergedTags.add(tag);
										}
									}
									if (mergedTags.size !== survivor.tags.length) {
										await setMemoryTags(tx, {
											entityId: input.entityId,
											memoryId: survivor.id,
											tags: [...mergedTags],
											now,
										});
									}
								}
								return { updated, newSupersededIds };
							},
						);
						return {
							survivorId: survivor.id,
							supersededCount: newSupersededIds.length,
							supersededIds: newSupersededIds,
						} satisfies ConsolidateResult;
					},
					(result) => ({ count: result.supersededCount }),
				);
			},
		};
	}
}
