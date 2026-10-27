import { runPostgresMigrations } from "../db/migrations/runner.js";
import { insertEvent, listEvents } from "../db/queries/events.js";
import {
	consolidateMemories,
	countPruneMatches,
	deleteMemoriesForEntity as deleteMemoriesForEntityQuery,
	deleteMemory as deleteMemoryQuery,
	findDuplicatePairs as findDuplicatePairsQuery,
	getEntityMemoryStatsCounts,
	getGlobalMemoryStatsCounts,
	getMemoryById,
	insertMemories as insertMemoryRows,
	lexicalSearch as lexicalSearchQuery,
	loadConsolidationTargets,
	markMemoriesAccessed,
	type NewMemoryRow,
	type PruneFilter,
	pruneMemories,
	vectorSearch as vectorSearchQuery,
} from "../db/queries/memories.js";
import {
	getInstallationMeta,
	getInstallationVectorType,
	getStoredEmbeddingModels,
	recordInstallationEmbeddingModel,
} from "../db/queries/meta.js";
import type { EventRow, VectorType } from "../db/rows.js";
import { MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import type { SqlExecutor } from "../sql/executor.js";
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
import { createEventId, isUuid, type StoredMemory } from "./records.js";
import {
	assertPruneFilterHasSelector,
	DEFAULT_NAMESPACE,
	entityScope,
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
const VECTOR_TYPES: ReadonlySet<string> = new Set(["vector", "halfvec"]);

function rowToAuditEvent(row: EventRow): AuditEvent {
	return {
		id: row.id,
		entityId: row.entityId,
		description: row.description,
		metadata: cloneJsonObject(row.metadata),
		timestamp: row.timestamp,
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
	const filter: PruneFilter = { namespace: DEFAULT_NAMESPACE };
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
	const { entityId, ...rest } = memory;
	return {
		...rest,
		scope: entityScope(entityId),
		tags: [...memory.tags],
		embedding: [...memory.embedding],
	};
}

function assertVectorType(value: string | null): VectorType {
	if (value === null || !VECTOR_TYPES.has(value)) {
		throw new MnemocyteError(
			'mnemocyte_meta.vector_type must be "vector" or "halfvec". Apply the bundled migrations through 0003_schema_v2.sql.',
			"MIGRATION",
		);
	}
	// Checked against VECTOR_TYPES above; the value is interpolated as a cast.
	return value as VectorType;
}

/** Ids that are not UUIDs cannot match a row, so they are never sent. */
function uuidsOnly(ids: readonly string[]): string[] {
	return ids.filter(isUuid);
}

function compatibilityKey(embedder: Embedder): string {
	return `${embedder.dimensions}:${embedder.model}`;
}

export function createPostgresStore(client: SqlExecutor): MemoryStore {
	// Keyed by model and dimensions, not by store: one store value shared by
	// clients with different embedders checks each embedder.
	const compatibilityChecks = new Map<string, Promise<void>>();
	let vectorTypePromise: Promise<VectorType> | undefined;

	function ensureEmbeddingCompatibility(embedder: Embedder): Promise<void> {
		const key = compatibilityKey(embedder);
		let check = compatibilityChecks.get(key);
		if (!check) {
			check = validateEmbeddingCompatibility(embedder).catch(
				(error: unknown) => {
					compatibilityChecks.delete(key);
					throw error;
				},
			);
			compatibilityChecks.set(key, check);
		}
		return check;
	}

	/** The installation's vector column type, read once from `mnemocyte_meta`. */
	function getVectorType(): Promise<VectorType> {
		if (!vectorTypePromise) {
			vectorTypePromise = getInstallationVectorType(client)
				.then(assertVectorType)
				.catch((error: unknown) => {
					vectorTypePromise = undefined;
					throw error;
				});
		}
		return vectorTypePromise;
	}

	async function validateEmbeddingCompatibility(
		embedder: Embedder,
	): Promise<void> {
		let meta: Awaited<ReturnType<typeof getInstallationMeta>>;
		try {
			meta = await getInstallationMeta(client);
		} catch (error) {
			if (
				hasPostgresErrorCode(error, "42P01") ||
				hasPostgresErrorCode(error, "42703")
			) {
				throw new MnemocyteError(
					"Postgres embedding metadata is missing or outdated. Apply the bundled migrations through 0003_schema_v2.sql, or render a fresh dimension-specific initial migration, before using embedding-dependent operations.",
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
		const vectorType = assertVectorType(meta.vectorType);
		vectorTypePromise ??= Promise.resolve(vectorType);
		if (meta.embeddingDimensions !== embedder.dimensions) {
			throw new MnemocyteError(
				`embedder.dimensions (${embedder.dimensions}) must match mnemocyte_meta.embedding_dimensions (${meta.embeddingDimensions}). Render and apply a migration for the selected embedding dimension, or configure an embedder that matches this installation.`,
				"CONFIG",
			);
		}
		let installationModel = meta.embeddingModel;
		if (installationModel === null) {
			try {
				const storedModels = await getStoredEmbeddingModels(client);
				if (storedModels.length > 1) {
					throw new MnemocyteError(
						"mnemocyte_meta.embedding_model is unset, but stored memories contain multiple embedding_model values. Re-embed or remove the mixed historical rows, then explicitly record the installation model before using embedding-dependent operations.",
						"MIGRATION",
					);
				}
				const inferredModel = storedModels[0] ?? embedder.model;
				const recorded = await recordInstallationEmbeddingModel(
					client,
					inferredModel,
				);
				if (recorded) {
					installationModel = recorded.embeddingModel;
				} else {
					const concurrentlyRecorded = await getInstallationMeta(client);
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
	}

	return {
		backend: "postgres",
		async ensureSchema() {},
		migrate(input) {
			return runPostgresMigrations(client, input);
		},
		ensureEmbeddingCompatibility,
		async insertMemories(memories) {
			return runPostgresOperation(async () => {
				const rows = await insertMemoryRows(
					client,
					memories.map(toMemoryRow),
					await getVectorType(),
				);
				return rows.map(rowToMemory);
			});
		},
		async vectorSearch(input: StoreVectorSearchInput) {
			return runPostgresOperation(async () => {
				const { entityId, ...filters } = input;
				const rows = await vectorSearchQuery(client, {
					...filters,
					scope: entityScope(entityId),
					vectorType: await getVectorType(),
				});
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
				const { entityId, ...filters } = input;
				const rows = await lexicalSearchQuery(client, {
					...filters,
					scope: entityScope(entityId),
				});
				return rows.map(
					(row) =>
						({
							memory: rowToMemory(row),
							lexicalScore: row.lexicalScore,
						}) satisfies StoreLexicalCandidate,
				);
			});
		},
		async markMemoriesAccessed(entityId, memoryIds) {
			return runPostgresOperation(() =>
				markMemoriesAccessed(
					client,
					entityScope(entityId),
					uuidsOnly(memoryIds),
				),
			);
		},
		async deleteMemory(entityId, memoryId) {
			return runPostgresDeleteOperation(async () => {
				if (!isUuid(memoryId)) {
					return false;
				}
				const result = await deleteMemoryQuery(
					client,
					entityScope(entityId),
					memoryId,
				);
				if (result.hasDependents) {
					throw memoryHasDependentsError();
				}
				return result.deletedCount > 0;
			});
		},
		async deleteMemoriesForEntity(entityId) {
			return runPostgresDeleteOperation(async () => {
				const result = await deleteMemoriesForEntityQuery(
					client,
					entityScope(entityId),
				);
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
							client,
							filter,
							options?.signal,
						),
						deletedCount: 0,
						dryRun: true,
						deletedByEntity: [],
					};
				}
				const result = await pruneMemories(client, filter, options?.signal);
				if (result.hasDependents) {
					throw memoryHasDependentsError();
				}
				return {
					matchedCount: result.matchedCount,
					deletedCount: result.deletedCount,
					dryRun: false,
					deletedByEntity: result.deletedByEntity,
				};
			});
		},
		async findDuplicatePairs(input, options) {
			return runPostgresOperation(async () => {
				const rows = await findDuplicatePairsQuery(
					client,
					{
						scope: entityScope(input.entityId),
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
					await insertEvent(client, {
						id: event.id,
						scope: entityScope(event.entityId),
						description: event.description,
						metadata: cloneJsonObject(event.metadata),
						timestamp: event.timestamp,
					});
				}
			});
		},
		async listAuditLog(input, options) {
			return runPostgresOperation(async () => {
				for (const cursor of [input.beforeCursor, input.afterCursor]) {
					if (cursor !== undefined && !isUuid(cursor.id)) {
						throw new MnemocyteError(
							"Audit log cursor id must be an event id returned by listAuditLog.",
							"VALIDATION",
						);
					}
				}
				const rows = await listEvents(
					client,
					{
						scope: entityScope(input.entityId),
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
					options?.signal,
				);
				return rows.map(rowToAuditEvent);
			});
		},
		async getMemory(entityId, memoryId, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				if (!isUuid(memoryId)) {
					return null;
				}
				const row = await getMemoryById(
					client,
					entityScope(entityId),
					memoryId,
					options?.signal,
				);
				return row ? rowToMemory(row) : null;
			});
		},
		async loadConsolidationTargets(entityId, ids, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				return loadConsolidationTargets(
					client,
					entityScope(entityId),
					uuidsOnly(ids),
					options?.signal,
				);
			});
		},
		async consolidate(
			input: StoreConsolidateInput,
			options,
		): Promise<StoreConsolidateResult> {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				const supersededIds = uuidsOnly(input.supersededIds);
				const result = await consolidateMemories(
					client,
					{
						scope: entityScope(input.entityId),
						survivorId: input.survivorId,
						supersededIds,
						mergeTags: input.mergeTags,
						now: input.now,
						...(input.auditEnabled
							? { auditEventIds: supersededIds.map(() => createEventId()) }
							: {}),
					},
					options?.signal,
				);
				if (!result.survivorActive) {
					throw new MnemocyteError(
						"Consolidation survivor changed before mutation.",
						"CONFLICT",
					);
				}
				if (result.hasConflict) {
					throw new MnemocyteError(
						"Superseded memory already belongs to a different survivor.",
						"CONFLICT",
					);
				}
				return { supersededIds: result.supersededIds };
			});
		},
		async stats(input, now) {
			return runPostgresOperation(async () => {
				if (input?.entityId) {
					const counts = await getEntityMemoryStatsCounts(
						client,
						entityScope(input.entityId),
						now,
					);
					return {
						entityId: input.entityId,
						...counts,
					} satisfies EntityStats;
				}
				return (await getGlobalMemoryStatsCounts(
					client,
					DEFAULT_NAMESPACE,
					now,
				)) satisfies GlobalStats;
			});
		},
		// The caller owns the database client, so there is nothing to release.
		async close() {},
	};
}

export function createPostgresClient(
	config: MnemocyteConfig,
	client: SqlExecutor,
): MnemocyteClient {
	return createMemoryClient(config, createPostgresStore(client));
}
