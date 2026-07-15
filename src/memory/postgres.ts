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
	markMemoriesSuperseded,
	markMemoryAccessed,
	type PruneFilter,
	pruneMemories,
	setMemoryTags,
	vectorSearch as vectorSearchQuery,
} from "../db/queries/memories.js";
import { getInstallationMeta } from "../db/queries/meta.js";
import type { EventRow, NewMemoryRow } from "../db/schema.js";
import { MnemocyteError } from "../errors.js";
import type {
	AuditEvent,
	Embedder,
	EntityStats,
	GlobalStats,
	ImportanceLevel,
	Memory,
	MnemocyteClient,
	MnemocyteConfig,
	PruneInput,
} from "../types.js";
import { createMemoryClient } from "./client-core.js";
import {
	createEventId,
	DEFAULT_AUDIT_LOG_LIMIT,
	DEFAULT_DUPLICATE_LIMIT,
	DEFAULT_DUPLICATE_THRESHOLD,
	IMPORTANCE_RANK,
	rowToMemory,
	type StoredMemory,
} from "./shared.js";
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

const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = [
	"low",
	"normal",
	"high",
	"critical",
];

const MIGRATION_ERROR_CODES = new Set(["42P01", "42703", "42704", "42883"]);

function rowToAuditEvent(row: EventRow): AuditEvent {
	return {
		id: row.id,
		entityId: row.entityId,
		description: row.description,
		metadata: row.metadata as Record<string, unknown>,
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

function toMemoryRow(memory: StoredMemory): NewMemoryRow {
	return {
		...memory,
		tags: [...memory.tags],
		metadata: { ...memory.metadata },
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
			if (hasPostgresErrorCode(error, "42P01")) {
				throw new MnemocyteError(
					"mnemocyte_meta is missing. Apply the v0.2.0 migration or render a dimension-specific initial migration before using the Postgres backend.",
					"MIGRATION",
					error,
				);
			}
			throw normalizePostgresError(error);
		}
		if (!meta) {
			throw new MnemocyteError(
				'mnemocyte_meta is missing the "installation" row. Apply the v0.2.0 migration or render a dimension-specific initial migration before using the Postgres backend.',
				"MIGRATION",
			);
		}
		if (meta.embeddingDimensions !== embedder.dimensions) {
			throw new MnemocyteError(
				`embedder.dimensions (${embedder.dimensions}) must match mnemocyte_meta.embedding_dimensions (${meta.embeddingDimensions}). Render and apply a migration for the selected embedding dimension, or configure an embedder that matches this installation.`,
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
				markMemoryAccessed(handle.db, memoryIds),
			);
		},
		async deleteMemory(entityId, memoryId) {
			return runPostgresOperation(() =>
				deleteMemoryQuery(handle.db, entityId, memoryId),
			);
		},
		async deleteMemoriesForEntity(entityId) {
			return runPostgresOperation(() =>
				deleteMemoriesForEntityQuery(handle.db, entityId),
			);
		},
		async prune(input) {
			return runPostgresOperation(async () => {
				const filter = toPruneFilter(input);
				const dryRun = input.dryRun === true;
				if (dryRun) {
					return {
						matchedCount: await countPruneMatches(handle.db, filter),
						deletedCount: 0,
						dryRun: true,
					};
				}
				const deletedCount = await pruneMemories(handle.db, filter);
				return {
					matchedCount: deletedCount,
					deletedCount,
					dryRun: false,
				};
			});
		},
		async findDuplicatePairs(input) {
			return runPostgresOperation(async () => {
				const rows = await findDuplicatePairsQuery(handle.db, {
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
				});
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
						metadata: event.metadata,
						timestamp: event.timestamp,
					});
				}
			});
		},
		async listAuditLog(input) {
			return runPostgresOperation(async () => {
				const rows = await listEvents(handle.db, {
					entityId: input.entityId,
					limit: input.limit ?? DEFAULT_AUDIT_LOG_LIMIT,
					...(input.before === undefined ? {} : { before: input.before }),
					...(input.after === undefined ? {} : { after: input.after }),
				});
				return rows.map(rowToAuditEvent);
			});
		},
		async getMemory(entityId, memoryId) {
			return runPostgresOperation(async () => {
				const row = await getMemoryById(handle.db, entityId, memoryId);
				return row ? rowToMemory(row) : null;
			});
		},
		async loadConsolidationTargets(entityId, ids) {
			return runPostgresOperation(() =>
				loadConsolidationTargets(handle.db, entityId, ids),
			);
		},
		async consolidate(
			input: StoreConsolidateInput,
		): Promise<StoreConsolidateResult> {
			return runPostgresOperation(async () => {
				const newSupersededIds = await handle.db.transaction(async (tx) => {
					const updated = await markMemoriesSuperseded(tx, {
						survivorId: input.survivorId,
						entityId: input.entityId,
						ids: input.supersededIds,
						now: input.now,
					});
					const ids = updated.map((row) => row.id);
					if (input.auditEnabled) {
						for (const id of ids) {
							await insertEvent(tx, {
								id: createEventId(),
								entityId: input.entityId,
								description: "memory.superseded",
								metadata: { memoryId: id, supersededBy: input.survivorId },
								timestamp: input.now,
							});
						}
					}
					if (input.mergeTags && updated.length > 0) {
						const mergedTags = new Set(input.survivorTags);
						for (const row of updated) {
							for (const tag of row.tags) {
								mergedTags.add(tag);
							}
						}
						if (mergedTags.size !== input.survivorTags.length) {
							await setMemoryTags(tx, {
								entityId: input.entityId,
								memoryId: input.survivorId,
								tags: [...mergedTags],
								now: input.now,
							});
						}
					}
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
