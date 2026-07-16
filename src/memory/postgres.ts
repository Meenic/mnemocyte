import type { DatabaseHandle } from "../db/index.js";
import { insertEvent, listEvents } from "../db/queries/events.js";
import {
	countPruneMatches,
	deleteMemoriesForEntity as deleteMemoriesForEntityQuery,
	deleteMemory as deleteMemoryQuery,
	findDuplicatePairs as findDuplicatePairsQuery,
	getEntityMemoryStatsCounts,
	getGlobalMemoryStatsCounts,
	getMemoryById,
	getMemoryEmbeddings as getMemoryEmbeddingsQuery,
	insertMemories as insertMemoryRows,
	lexicalSearch as lexicalSearchQuery,
	loadConsolidationTargets,
	markMemoriesAccessed,
	markMemoriesSuperseded,
	type PruneFilter,
	pruneMemories,
	setMemoryTags,
	vectorSearch as vectorSearchQuery,
} from "../db/queries/memories.js";
import {
	getInstallationMeta,
	getStoredEmbeddingModels,
	recordInstallationEmbeddingModel,
} from "../db/queries/meta.js";
import type { EventRow, NewMemoryRow } from "../db/schema.js";
import { MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import type {
	AuditEvent,
	Embedder,
	EntityStats,
	GlobalStats,
	ImportanceLevel,
	MnemocyteClient,
	MnemocyteConfig,
} from "../types.js";
import { createMemoryClient } from "./client-core.js";
import {
	DEFAULT_AUDIT_LOG_LIMIT,
	DEFAULT_DUPLICATE_LIMIT,
	DEFAULT_DUPLICATE_THRESHOLD,
	IMPORTANCE_RANK,
} from "./defaults.js";
import { memoryHasDependentsError } from "./deletion.js";
import { cloneJsonObject } from "./json.js";
import { rowToMemory } from "./postgres-records.js";
import { createEventId, type StoredMemory } from "./records.js";
import {
	assertPruneFilterHasSelector,
	type MemoryStore,
	type StoreConsolidateInput,
	type StoreConsolidateResult,
	type StoreDuplicatePair,
	type StoreLexicalCandidate,
	type StoreLexicalSearchInput,
	type StoreVectorCandidate,
	type StoreVectorSearchInput,
	type ValidatedPruneFilter,
} from "./store.js";

const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = [
	"low",
	"normal",
	"high",
	"critical",
];

const MIGRATION_ERROR_CODES = new Set(["42P01", "42703", "42704", "42883"]);
const CONSOLIDATION_SURVIVOR_FOREIGN_KEY =
	"mnemocyte_memories_superseded_by_mnemocyte_memories_id_fk";

function rowToAuditEvent(row: EventRow): AuditEvent {
	return {
		id: row.id,
		entityId: row.entityId,
		description: row.description,
		metadata: cloneJsonObject(row.metadata),
		timestamp: new Date(row.timestamp),
	};
}

function importanceCeilingLevels(
	max: ImportanceLevel,
): readonly ImportanceLevel[] {
	return IMPORTANCE_LEVELS.filter(
		(level) => IMPORTANCE_RANK[level] <= IMPORTANCE_RANK[max],
	);
}

function hasPostgresErrorCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

function hasPostgresConstraintName(error: unknown, name: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"constraint_name" in error &&
		error.constraint_name === name
	);
}

function getPostgresErrorCode(error: unknown): string | undefined {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string"
		? (error as { code: string }).code
		: undefined;
}

function normalizePostgresError(error: unknown): MnemocyteError {
	if (error instanceof MnemocyteError) {
		return error;
	}
	const code = getPostgresErrorCode(error);
	if (code && MIGRATION_ERROR_CODES.has(code)) {
		return new MnemocyteError(
			"Postgres schema is missing or incompatible. Apply the bundled Mnemocyte migrations before using the Postgres backend.",
			"MIGRATION",
			error,
		);
	}
	return new MnemocyteError("Postgres operation failed.", "DB", error);
}

async function runPostgresOperation<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw normalizePostgresError(error);
	}
}

async function runPostgresDeleteOperation<T>(
	operation: () => Promise<T>,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof MnemocyteError) {
			throw error;
		}
		if (
			hasPostgresErrorCode(error, "23503") &&
			hasPostgresConstraintName(error, CONSOLIDATION_SURVIVOR_FOREIGN_KEY)
		) {
			throw memoryHasDependentsError(error);
		}
		throw normalizePostgresError(error);
	}
}

function toPruneFilter(input: ValidatedPruneFilter): PruneFilter {
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

function toMemoryRow(memory: StoredMemory): NewMemoryRow {
	return {
		...memory,
		tags: [...memory.tags],
		embedding: [...memory.embedding],
	};
}

export function createPostgresStore(handle: DatabaseHandle): MemoryStore {
	let schemaValidated = false;
	let schemaValidationPromise: Promise<void> | undefined;

	async function ensureEmbeddingCompatibility(
		embedder: Embedder,
	): Promise<void> {
		if (schemaValidated) {
			return;
		}
		if (!schemaValidationPromise) {
			schemaValidationPromise = validateEmbeddingCompatibility(embedder).catch(
				(error: unknown) => {
					schemaValidationPromise = undefined;
					throw error;
				},
			);
		}
		await schemaValidationPromise;
	}

	async function validateEmbeddingCompatibility(
		embedder: Embedder,
	): Promise<void> {
		let meta: Awaited<ReturnType<typeof getInstallationMeta>>;
		try {
			meta = await getInstallationMeta(handle.db);
		} catch (error) {
			if (
				hasPostgresErrorCode(error, "42P01") ||
				hasPostgresErrorCode(error, "42703")
			) {
				throw new MnemocyteError(
					"Postgres embedding metadata is missing or outdated. Apply the bundled migrations through 0002_add_embedding_model.sql, or render a fresh dimension-specific initial migration, before using embedding-dependent operations.",
					"MIGRATION",
					error,
				);
			}
			throw normalizePostgresError(error);
		}
		if (!meta) {
			throw new MnemocyteError(
				'mnemocyte_meta is missing the "installation" row. Apply the bundled migrations, or render a fresh dimension-specific initial migration, before using embedding-dependent operations.',
				"MIGRATION",
			);
		}
		if (meta.embeddingDimensions !== embedder.dimensions) {
			throw new MnemocyteError(
				`embedder.dimensions (${embedder.dimensions}) must match mnemocyte_meta.embedding_dimensions (${meta.embeddingDimensions}). Render and apply a migration for the selected embedding dimension, or configure an embedder that matches this installation.`,
				"CONFIG",
			);
		}
		let installationModel = meta.embeddingModel;
		if (installationModel === null) {
			try {
				const storedModels = await getStoredEmbeddingModels(handle.db);
				if (storedModels.length > 1) {
					throw new MnemocyteError(
						"mnemocyte_meta.embedding_model is unset, but stored memories contain multiple embedding_model values. Re-embed or remove the mixed historical rows, then explicitly record the installation model before using embedding-dependent operations.",
						"MIGRATION",
					);
				}
				const inferredModel = storedModels[0] ?? embedder.model;
				const recorded = await recordInstallationEmbeddingModel(
					handle.db,
					inferredModel,
				);
				if (recorded) {
					installationModel = recorded.embeddingModel;
				} else {
					const concurrentlyRecorded = await getInstallationMeta(handle.db);
					installationModel = concurrentlyRecorded?.embeddingModel ?? null;
				}
			} catch (error) {
				throw normalizePostgresError(error);
			}
			if (installationModel === null) {
				throw new MnemocyteError(
					"mnemocyte_meta.embedding_model could not be recorded. Verify the installation metadata row and retry.",
					"MIGRATION",
				);
			}
		}
		if (installationModel !== embedder.model) {
			throw new MnemocyteError(
				`embedder.model ("${embedder.model}") must match mnemocyte_meta.embedding_model ("${installationModel}"). Configure the recorded model, or explicitly re-embed existing memories and update the installation metadata.`,
				"CONFIG",
			);
		}
		schemaValidated = true;
	}

	return {
		backend: "postgres",
		async ensureSchema() {},
		ensureEmbeddingCompatibility,
		async insertMemories(memories) {
			return runPostgresOperation(async () => {
				const rows = await insertMemoryRows(
					handle.db,
					memories.map(toMemoryRow),
				);
				return rows.map(rowToMemory);
			});
		},
		async vectorSearch(input: StoreVectorSearchInput) {
			return runPostgresOperation(async () => {
				const rows = await vectorSearchQuery(handle.db, input);
				return rows.map(
					(row) =>
						({
							memory: rowToMemory(row),
							vectorScore: row.vectorScore,
						}) satisfies StoreVectorCandidate,
				);
			});
		},
		async lexicalSearch(input: StoreLexicalSearchInput) {
			return runPostgresOperation(async () => {
				const rows = await lexicalSearchQuery(handle.db, input);
				return rows.map(
					(row) =>
						({
							memory: rowToMemory(row),
							lexicalScore: row.lexicalScore,
						}) satisfies StoreLexicalCandidate,
				);
			});
		},
		async getMemoryEmbeddings(memoryIds) {
			return runPostgresOperation(() =>
				getMemoryEmbeddingsQuery(handle.db, memoryIds),
			);
		},
		async markMemoriesAccessed(memoryIds) {
			return runPostgresOperation(() =>
				markMemoriesAccessed(handle.db, memoryIds),
			);
		},
		async deleteMemory(entityId, memoryId) {
			return runPostgresDeleteOperation(async () => {
				const result = await deleteMemoryQuery(handle.db, entityId, memoryId);
				if (result.hasDependents) {
					throw memoryHasDependentsError();
				}
				return result.deletedCount > 0;
			});
		},
		async deleteMemoriesForEntity(entityId) {
			return runPostgresDeleteOperation(async () => {
				const result = await deleteMemoriesForEntityQuery(handle.db, entityId);
				if (result.hasDependents) {
					throw memoryHasDependentsError();
				}
				return result.deletedCount;
			});
		},
		async prune(input, options) {
			return runPostgresDeleteOperation(async () => {
				throwIfAborted(options?.signal);
				assertPruneFilterHasSelector(input);
				const filter = toPruneFilter(input);
				const dryRun = input.dryRun === true;
				if (dryRun) {
					return {
						matchedCount: await countPruneMatches(
							handle.db,
							filter,
							options?.signal,
						),
						deletedCount: 0,
						dryRun: true,
					};
				}
				const result = await pruneMemories(handle.db, filter, options?.signal);
				if (result.hasDependents) {
					throw memoryHasDependentsError();
				}
				return {
					matchedCount: result.matchedCount,
					deletedCount: result.deletedCount,
					dryRun: false,
				};
			});
		},
		async findDuplicatePairs(input, options) {
			return runPostgresOperation(async () => {
				const rows = await findDuplicatePairsQuery(
					handle.db,
					{
						entityId: input.entityId,
						threshold: input.threshold ?? DEFAULT_DUPLICATE_THRESHOLD,
						limit: input.limit ?? DEFAULT_DUPLICATE_LIMIT,
						...(input.types === undefined ? {} : { types: input.types }),
						...(input.tags === undefined ? {} : { tags: input.tags }),
						...(input.includeSuperseded === undefined
							? {}
							: { includeSuperseded: input.includeSuperseded }),
						...(input.includeExpired === undefined
							? {}
							: { includeExpired: input.includeExpired }),
					},
					options?.signal,
				);
				return rows.map(
					(row) =>
						({
							a: rowToMemory(row.a),
							b: rowToMemory(row.b),
							similarity: Math.max(0, Math.min(1, row.similarity)),
						}) satisfies StoreDuplicatePair,
				);
			});
		},
		async addAuditEvents(events) {
			return runPostgresOperation(async () => {
				for (const event of events) {
					await insertEvent(handle.db, {
						id: event.id,
						entityId: event.entityId,
						description: event.description,
						metadata: cloneJsonObject(event.metadata),
						timestamp: event.timestamp,
					});
				}
			});
		},
		async listAuditLog(input, options) {
			return runPostgresOperation(async () => {
				const rows = await listEvents(
					handle.db,
					{
						entityId: input.entityId,
						limit: input.limit ?? DEFAULT_AUDIT_LOG_LIMIT,
						...(input.before === undefined ? {} : { before: input.before }),
						...(input.after === undefined ? {} : { after: input.after }),
					},
					options?.signal,
				);
				return rows.map(rowToAuditEvent);
			});
		},
		async getMemory(entityId, memoryId, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				const row = await getMemoryById(handle.db, entityId, memoryId);
				throwIfAborted(options?.signal);
				return row ? rowToMemory(row) : null;
			});
		},
		async loadConsolidationTargets(entityId, ids, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				const targets = await loadConsolidationTargets(
					handle.db,
					entityId,
					ids,
				);
				throwIfAborted(options?.signal);
				return targets;
			});
		},
		async consolidate(
			input: StoreConsolidateInput,
			options,
		): Promise<StoreConsolidateResult> {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				const newSupersededIds = await handle.db.transaction(async (tx) => {
					throwIfAborted(options?.signal);
					const updated = await markMemoriesSuperseded(tx, {
						survivorId: input.survivorId,
						entityId: input.entityId,
						ids: input.supersededIds,
						now: input.now,
					});
					throwIfAborted(options?.signal);
					const ids = updated.map((row) => row.id);
					if (input.auditEnabled) {
						for (const id of ids) {
							throwIfAborted(options?.signal);
							await insertEvent(tx, {
								id: createEventId(),
								entityId: input.entityId,
								description: "memory.superseded",
								metadata: { memoryId: id, supersededBy: input.survivorId },
								timestamp: input.now,
							});
							throwIfAborted(options?.signal);
						}
					}
					if (input.mergeTags && updated.length > 0) {
						const mergedTags = new Set(input.survivorTags);
						for (const row of updated) {
							throwIfAborted(options?.signal);
							for (const tag of row.tags) {
								mergedTags.add(tag);
							}
						}
						if (mergedTags.size !== input.survivorTags.length) {
							throwIfAborted(options?.signal);
							await setMemoryTags(tx, {
								entityId: input.entityId,
								memoryId: input.survivorId,
								tags: [...mergedTags],
								now: input.now,
							});
							throwIfAborted(options?.signal);
						}
					}
					throwIfAborted(options?.signal);
					return ids;
				});
				return { supersededIds: newSupersededIds };
			});
		},
		async stats(input, now) {
			return runPostgresOperation(async () => {
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
			});
		},
		async close() {
			return runPostgresOperation(() => handle.close());
		},
	};
}

export function createPostgresClient(
	config: MnemocyteConfig,
	handle: DatabaseHandle,
): MnemocyteClient {
	return createMemoryClient(config, createPostgresStore(handle));
}
