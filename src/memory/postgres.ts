import { assertSqlExecutor } from "../db/atomic.js";
import { postgresConstraintName, postgresErrorCode } from "../db/errors.js";
import { runPostgresMigrations } from "../db/migrations/runner.js";
import { listEvents } from "../db/queries/events.js";
import {
	consolidateMemories,
	countPruneMatches,
	deleteMemory as deleteMemoryQuery,
	deleteScope as deleteScopeQuery,
	findDuplicatePairs as findDuplicatePairsQuery,
	getMemoryById,
	getMemoryByKey as getMemoryByKeyQuery,
	getMemoryStatsCounts,
	insertMemories as insertMemoryRows,
	isScopeKeyViolation,
	lexicalSearch as lexicalSearchQuery,
	listMemories as listMemoriesQuery,
	loadConsolidationTargets,
	markMemoriesAccessed,
	type NewMemoryRow,
	type PruneFilter,
	pruneMemories,
	updateMemory as updateMemoryQuery,
	vectorSearch as vectorSearchQuery,
} from "../db/queries/memories.js";
import {
	getInstallationMeta,
	getInstallationVectorType,
	getPgvectorVersion,
	getStoredEmbeddingModels,
	recordInstallationEmbeddingModel,
} from "../db/queries/meta.js";
import type { VectorType } from "../db/rows.js";
import { MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import { toVectorScore } from "../retrieval/scorer.js";
import type { SqlExecutor } from "../sql/executor.js";
import type { Embedder, ImportanceLevel, MemoryConfig } from "../types.js";
import { type CoreMemoryClient, createMemoryClient } from "./client-core.js";
import { IMPORTANCE_RANK } from "./defaults.js";
import { hiddenDependentsError, memoryHasDependentsError } from "./deletion.js";
import { rowToAuditEvent, rowToMemory } from "./postgres-records.js";
import { createEventId, isUuid, type StoredMemory } from "./records.js";
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

/** Missing table, column, object or function: the schema is behind. */
const MIGRATION_ERROR_CODES = new Set(["42P01", "42703", "42704", "42883"]);
/** The fix the missing-schema error names; `feat/cli` changes it. */
const MIGRATE_COMMAND = "migrate({ memory })";
const POSTGRES_GUIDE_URL =
	"https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md";
const INSTALL_GUIDE_URL = `${POSTGRES_GUIDE_URL}#install-the-schema`;
const INSTALLATION_GUIDE_URL = `${POSTGRES_GUIDE_URL}#one-embedding-model-per-installation`;
/** Driver messages are one line; this only guards against a runaway one. */
const MAX_DRIVER_DETAIL_LENGTH = 200;
const CONSOLIDATION_SURVIVOR_FOREIGN_KEY =
	"mnemocyte_memories_superseded_by_mnemocyte_memories_id_fk";
const VECTOR_TYPES: ReadonlySet<string> = new Set(["vector", "halfvec"]);

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
	return postgresConstraintName(error) === name;
}

/** The driver's own message, such as `relation "…" does not exist`. */
function driverDetail(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("message" in error)) {
		return undefined;
	}
	const { message } = error;
	if (typeof message !== "string") {
		return undefined;
	}
	const detail = message.trim().replace(/\s+/g, " ");
	if (detail === "") {
		return undefined;
	}
	return detail.length > MAX_DRIVER_DETAIL_LENGTH
		? `${detail.slice(0, MAX_DRIVER_DETAIL_LENGTH)}…`
		: detail;
}

/**
 * A Mnemocyte table or column the query needs does not exist. The message
 * names the fix and repeats the driver's text, because many log pipelines
 * drop `cause`.
 */
function missingSchemaError(error: unknown): MnemocyteError {
	const detail = driverDetail(error);
	return new MnemocyteError(
		`Mnemocyte's tables are missing or out of date in this database${detail ? ` (${detail})` : ""}. Run ${MIGRATE_COMMAND} to create or upgrade them: ${INSTALL_GUIDE_URL}`,
		"MIGRATION",
		error,
	);
}

/**
 * `migrate()` writes the row only when it creates the schema, so it is not
 * the fix for a deleted one.
 */
function missingInstallationRowError(): MnemocyteError {
	return new MnemocyteError(
		`mnemocyte_meta has no "installation" row, so the embedder cannot be checked against this database. migrate() writes the row only when it creates the schema and does not restore a deleted one; insert it again as shown in ${INSTALLATION_GUIDE_URL}`,
		"MIGRATION",
	);
}

function normalizePostgresError(error: unknown): MnemocyteError {
	if (error instanceof MnemocyteError) {
		return error;
	}
	const code = postgresErrorCode(error);
	if (code && MIGRATION_ERROR_CODES.has(code)) {
		return missingSchemaError(error);
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
	const filter: PruneFilter = { selector: input.selector };
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
	if (input.kinds !== undefined && input.kinds.length > 0) {
		filter.kinds = input.kinds;
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

function assertVectorType(value: string | null): VectorType {
	// `getInstallationVectorType` returns null when the row is missing; the
	// column itself is NOT NULL.
	if (value === null) {
		throw missingInstallationRowError();
	}
	if (!VECTOR_TYPES.has(value)) {
		throw new MnemocyteError(
			`mnemocyte_meta.vector_type is ${JSON.stringify(value)}; it must be "vector" or "halfvec".`,
			"MIGRATION",
		);
	}
	// Checked against VECTOR_TYPES above; the value is interpolated as a cast.
	return value as VectorType;
}

/** Iterative HNSW scans (`hnsw.iterative_scan`) arrived in pgvector 0.8.0. */
const MIN_PGVECTOR_VERSION: readonly [number, number] = [0, 8];

export function assertPgvectorVersion(version: string | null): void {
	if (version === null) {
		throw new MnemocyteError(
			"pgvector is not installed in this database. Run CREATE EXTENSION vector as a role that may create extensions.",
			"MIGRATION",
		);
	}
	const [major = Number.NaN, minor = Number.NaN] = version
		.split(".")
		.map((part) => Number.parseInt(part, 10));
	const [minMajor, minMinor] = MIN_PGVECTOR_VERSION;
	if (
		!Number.isInteger(major) ||
		!Number.isInteger(minor) ||
		major < minMajor ||
		(major === minMajor && minor < minMinor)
	) {
		throw new MnemocyteError(
			`Mnemocyte needs pgvector ${minMajor}.${minMinor}.0 or later for filtered vector search; this database has ${version}. Upgrade the pgvector package on the server, then run ALTER EXTENSION vector UPDATE.`,
			"MIGRATION",
		);
	}
}

/** Ids that are not UUIDs cannot match a row, so they are never sent. */
function uuidsOnly(ids: readonly string[]): string[] {
	return ids.filter(isUuid);
}

function compatibilityKey(embedder: Embedder): string {
	return `${embedder.dimensions}:${embedder.model}`;
}

export function createPostgresStore(client: SqlExecutor): MemoryStore {
	assertSqlExecutor(client);
	// Keyed by model and dimensions, not by store: one store value shared by
	// clients with different embedders checks each embedder.
	const compatibilityChecks = new Map<string, Promise<void>>();
	let vectorTypePromise: Promise<VectorType> | undefined;
	let pgvectorCheck: Promise<void> | undefined;

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

	/** Checked once per store, before the first vector search. */
	function ensurePgvectorVersion(): Promise<void> {
		if (!pgvectorCheck) {
			pgvectorCheck = getPgvectorVersion(client)
				.then(assertPgvectorVersion)
				.catch((error: unknown) => {
					pgvectorCheck = undefined;
					throw error;
				});
		}
		return pgvectorCheck;
	}

	async function validateEmbeddingCompatibility(
		embedder: Embedder,
	): Promise<void> {
		let meta: Awaited<ReturnType<typeof getInstallationMeta>>;
		try {
			meta = await getInstallationMeta(client);
		} catch (error) {
			// A missing table or column (an older schema) gets the migrate hint.
			throw normalizePostgresError(error);
		}
		if (!meta) {
			throw missingInstallationRowError();
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
		migrate(input) {
			return runPostgresMigrations(client, input);
		},
		ensureEmbeddingCompatibility,
		async insertMemories(memories, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				const rows = await insertMemoryRows(
					client,
					memories.map(toMemoryRow),
					await getVectorType(),
					options?.signal,
					options?.audit === true
						? memories.map(() => createEventId())
						: undefined,
				);
				return rows.map(rowToMemory);
			});
		},
		async vectorSearch(input: StoreVectorSearchInput) {
			return runPostgresOperation(async () => {
				const { minVectorScore = 0, ...filters } = input;
				const [vectorType] = await Promise.all([
					getVectorType(),
					ensurePgvectorVersion(),
				]);
				const rows = await vectorSearchQuery(client, {
					...filters,
					vectorType,
				});
				// Rows come in increasing distance, so the scores decrease and the
				// rows at or above `minVectorScore` are a prefix: filtering after
				// the LIMIT keeps the same rows as filtering before it.
				return rows
					.map(
						(row) =>
							({
								memory: rowToMemory(row),
								vectorScore: toVectorScore(1 - row.vectorDistance),
							}) satisfies StoreVectorCandidate,
					)
					.filter((candidate) => candidate.vectorScore >= minVectorScore);
			});
		},
		async lexicalSearch(input: StoreLexicalSearchInput) {
			return runPostgresOperation(async () => {
				const rows = await lexicalSearchQuery(client, input);
				return rows.map(
					(row) =>
						({
							memory: rowToMemory(row),
							lexicalScore: row.lexicalScore,
						}) satisfies StoreLexicalCandidate,
				);
			});
		},
		async listMemories(input, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				const rows = await listMemoriesQuery(client, input, options?.signal);
				return rows.map(rowToMemory);
			});
		},
		async markMemoriesAccessed(visibility, memoryIds) {
			return runPostgresOperation(() =>
				markMemoriesAccessed(client, visibility, uuidsOnly(memoryIds)),
			);
		},
		async getMemory(visibility, memoryId, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				if (!isUuid(memoryId)) {
					return null;
				}
				const row = await getMemoryById(
					client,
					visibility,
					memoryId,
					options?.signal,
				);
				return row ? rowToMemory(row) : null;
			});
		},
		async getMemoryByKey(scope, key, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				const row = await getMemoryByKeyQuery(
					client,
					scope,
					key,
					options?.signal,
				);
				return row ? rowToMemory(row) : null;
			});
		},
		async updateMemory(input) {
			try {
				if (!isUuid(input.id)) {
					return null;
				}
				const { patch } = input;
				const row = await updateMemoryQuery(client, {
					visibility: input.visibility,
					id: input.id,
					now: input.now,
					vectorType:
						patch.embedding === undefined ? "vector" : await getVectorType(),
					...patch,
					...(input.audit === undefined
						? {}
						: {
								audit: {
									eventId: createEventId(),
									fields: input.audit.fields,
								},
							}),
				});
				return row ? rowToMemory(row) : null;
			} catch (error) {
				if (isScopeKeyViolation(error)) {
					throw new MnemocyteError(
						"Another memory in this scope already uses that key.",
						"CONFLICT",
						error,
					);
				}
				throw normalizePostgresError(error);
			}
		},
		async deleteMemory(input, options) {
			return runPostgresDeleteOperation(async () => {
				throwIfAborted(options?.signal);
				if (!isUuid(input.memoryId)) {
					return null;
				}
				const result = await deleteMemoryQuery(client, input, options?.signal);
				if (!result.found) {
					return null;
				}
				if (result.hasDependents) {
					throw memoryHasDependentsError();
				}
				if (result.hiddenDependents) {
					throw hiddenDependentsError();
				}
				return {
					deletedIds: [
						input.memoryId,
						...result.deletedIds.filter((id) => id !== input.memoryId),
					],
					restoredIds: result.restoredIds,
				};
			});
		},
		async deleteScope(selector, options) {
			return runPostgresDeleteOperation(async () => {
				throwIfAborted(options?.signal);
				const result = await deleteScopeQuery(
					client,
					selector,
					options?.signal,
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
					};
				}
				const result = await pruneMemories(
					client,
					filter,
					input.audit ? { now: input.now } : undefined,
					options?.signal,
				);
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
					client,
					input,
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
				const rows = await listEvents(client, input, options?.signal);
				return rows.map(rowToAuditEvent);
			});
		},
		async loadConsolidationTargets(visibility, ids, options) {
			return runPostgresOperation(async () => {
				throwIfAborted(options?.signal);
				return loadConsolidationTargets(
					client,
					visibility,
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
						visibility: input.visibility,
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
		async stats(selector, now) {
			return runPostgresOperation(() =>
				getMemoryStatsCounts(client, selector, now),
			);
		},
	};
}

export function createPostgresClient(
	config: MemoryConfig,
	client: SqlExecutor,
): CoreMemoryClient {
	return createMemoryClient(config, createPostgresStore(client));
}
