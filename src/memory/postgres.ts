import { assertSqlExecutor } from "../db/atomic.js";
import { postgresConstraintName, postgresErrorCode } from "../db/errors.js";
import { inspectPostgresInstallation } from "../db/migrations/inspect.js";
import { runPostgresMigrations } from "../db/migrations/runner.js";
import { setPostgresTextSearchConfig } from "../db/migrations/text-search.js";
import { assertPgvectorVersion } from "../db/pgvector.js";
import {
	countEventsBefore,
	deleteEventsBatch,
	type EventPosition,
	listEvents,
} from "../db/queries/events.js";
import {
	consolidateMemories,
	countPruneMatches,
	deleteMemory as deleteMemoryQuery,
	deleteScope as deleteScopeQuery,
	findDuplicatePage as findDuplicatePageQuery,
	findDuplicatePairs as findDuplicatePairsQuery,
	getMemoriesByIds,
	getMemoryByKey as getMemoryByKeyQuery,
	getMemoryStatsCounts,
	insertMemories as insertMemoryRows,
	isScopeKeyViolation,
	lexicalSearch as lexicalSearchQuery,
	listMemories as listMemoriesQuery,
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
import type { MemoryRow, VectorType } from "../db/rows.js";
import { postgresTables } from "../db/tables.js";
import {
	readInstalledTextSearchConfig,
	unrecognizedTextSearchError,
} from "../db/text-search.js";
import { isMnemocyteError, MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import { toVectorScore } from "../retrieval/scorer.js";
import type { SqlExecutor } from "../sql/executor.js";
import type {
	Embedder,
	ImportanceLevel,
	MemoryConfig,
	PruneResult,
} from "../types.js";
import { POSTGRES_CAPABILITIES } from "./capabilities.js";
import { type CoreMemoryClient, createMemoryClient } from "./client-core.js";
import { IMPORTANCE_RANK } from "./defaults.js";
import { hiddenDependentsError, memoryHasDependentsError } from "./deletion.js";
import { rowToAuditEvent, rowToMemory } from "./postgres-records.js";
import { createEventId, isUuid, type StoredMemory } from "./records.js";
import {
	assertPruneFilterHasSelector,
	type MemoryStore,
	type StoreDeletedMemory,
	type StoreDeleteFilterInput,
	type StoreDeleteMemoryInput,
	type StoreDeleteResult,
	type StoreDeleteScopeInput,
	type StoreDuplicatePage,
	type StoreDuplicatePageInput,
	type StoreDuplicatePair,
	type StoreDuplicateResult,
	type StoreDuplicateTop,
	type StoreDuplicateTopInput,
	type StoreLexicalCandidate,
	type StoreLexicalQuery,
	type StoreMemoryFilter,
	type StoreVectorCandidate,
	type StoreVectorQuery,
	type ValidatedPruneFilter,
} from "./store.js";

const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = [
	"low",
	"normal",
	"high",
	"critical",
];

/**
 * Missing table, column, object or function: the schema is behind. `3F000`
 * is a missing schema, for a `schemaName` that was never migrated.
 */
const MIGRATION_ERROR_CODES = new Set([
	"42P01",
	"42703",
	"42704",
	"42883",
	"3F000",
]);
/**
 * The fix the missing-schema error names. No runner prefix: the store does
 * not know the project's package manager, and `npx` fails in a pnpm one.
 */
const MIGRATE_COMMAND = "mnemocyte migrate";
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
function missingSchemaError(
	error: unknown,
	schema: string | null,
): MnemocyteError {
	const detail = driverDetail(error);
	const where = schema === null ? "this database" : `the "${schema}" schema`;
	return new MnemocyteError({
		message: `Mnemocyte's tables are missing or out of date in ${where}${detail ? ` (${detail})` : ""}. Run ${MIGRATE_COMMAND} to create or upgrade them: ${INSTALL_GUIDE_URL}`,
		code: "MIGRATION",
		reason: "SCHEMA_MISSING",
		cause: error,
	});
}

/**
 * `migrate()` writes the row only when it creates the schema, so it is not
 * the fix for a deleted one.
 */
function missingInstallationRowError(): MnemocyteError {
	return new MnemocyteError({
		message: `mnemocyte_meta has no "installation" row, so the embedder cannot be checked against this database. migrate() writes the row only when it creates the schema and does not restore a deleted one; insert it again as shown in ${INSTALLATION_GUIDE_URL}`,
		code: "MIGRATION",
		reason: "INSTALLATION_INVALID",
	});
}

function normalizePostgresError(
	error: unknown,
	schema: string | null,
): MnemocyteError {
	if (isMnemocyteError(error)) {
		return error;
	}
	const code = postgresErrorCode(error);
	if (code && MIGRATION_ERROR_CODES.has(code)) {
		return missingSchemaError(error, schema);
	}
	return new MnemocyteError({
		message: "Postgres operation failed.",
		code: "DB",
		cause: error,
	});
}

async function runPostgresOperation<T>(
	operation: () => Promise<T>,
	schema: string | null,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw normalizePostgresError(error, schema);
	}
}

async function runPostgresDeleteOperation<T>(
	operation: () => Promise<T>,
	schema: string | null,
): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		if (isMnemocyteError(error)) {
			throw error;
		}
		if (
			hasPostgresErrorCode(error, "23503") &&
			hasPostgresConstraintName(error, CONSOLIDATION_SURVIVOR_FOREIGN_KEY)
		) {
			throw memoryHasDependentsError(error);
		}
		throw normalizePostgresError(error, schema);
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
		throw new MnemocyteError({
			message: `mnemocyte_meta.vector_type is ${JSON.stringify(value)}; it must be "vector" or "halfvec".`,
			code: "MIGRATION",
			reason: "INSTALLATION_INVALID",
		});
	}
	// Checked against VECTOR_TYPES above; the value is interpolated as a cast.
	return value as VectorType;
}

export { assertPgvectorVersion };

/** Ids that are not UUIDs cannot match a row, so they are never sent. */
function uuidsOnly(ids: readonly string[]): string[] {
	return ids.filter(isUuid);
}

function compatibilityKey(embedder: Embedder): string {
	return `${embedder.dimensions}:${embedder.model}`;
}

/** Options for {@link createPostgresStore}, already validated. */
export interface PostgresStoreSettings {
	/** The schema of the tables; omitted, they resolve through `search_path`. */
	readonly schemaName?: string;
}

export function createPostgresStore(
	client: SqlExecutor,
	settings: PostgresStoreSettings = {},
): MemoryStore {
	assertSqlExecutor(client);
	const tables = postgresTables(settings.schemaName ?? null);
	const missingSchema = (error: unknown): MnemocyteError =>
		missingSchemaError(error, tables.schema);
	const normalize = (error: unknown): MnemocyteError =>
		normalizePostgresError(error, tables.schema);
	const run = <T>(operation: () => Promise<T>): Promise<T> =>
		runPostgresOperation(operation, tables.schema);
	const runDelete = <T>(operation: () => Promise<T>): Promise<T> =>
		runPostgresDeleteOperation(operation, tables.schema);
	// Keyed by model and dimensions, not by store: one store value shared by
	// clients with different embedders checks each embedder.
	const compatibilityChecks = new Map<string, Promise<void>>();
	let vectorTypePromise: Promise<VectorType> | undefined;
	let pgvectorCheck: Promise<void> | undefined;
	let textSearchConfigPromise: Promise<string> | undefined;

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
			vectorTypePromise = getInstallationVectorType(client, tables)
				.then(assertVectorType)
				.catch((error: unknown) => {
					vectorTypePromise = undefined;
					throw error;
				});
		}
		return vectorTypePromise;
	}

	/**
	 * The text search configuration of `content_tsv`, read once per store
	 * from the column's generated expression before the first keyword
	 * search, so the query parses with the configuration the rows were
	 * indexed with. A change made by another process while this one runs is
	 * not seen until it restarts; a change through this store updates it.
	 */
	function getTextSearchConfig(): Promise<string> {
		if (!textSearchConfigPromise) {
			textSearchConfigPromise = readInstalledTextSearchConfig(
				client,
				{},
				tables,
			)
				.then((found) => {
					if (found.kind === "unrecognized") {
						throw unrecognizedTextSearchError(found.expression);
					}
					if (found.kind === "missing") {
						// No content_tsv: a schema before 0003, which the keyword
						// query would fail on with 42703 too.
						throw missingSchema(undefined);
					}
					return found.name;
				})
				.catch((error: unknown) => {
					textSearchConfigPromise = undefined;
					throw error;
				});
		}
		return textSearchConfigPromise;
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
			meta = await getInstallationMeta(client, tables);
		} catch (error) {
			// A missing table or column (an older schema) gets the migrate hint.
			throw normalize(error);
		}
		if (!meta) {
			throw missingInstallationRowError();
		}
		const vectorType = assertVectorType(meta.vectorType);
		vectorTypePromise ??= Promise.resolve(vectorType);
		if (meta.embeddingDimensions !== embedder.dimensions) {
			throw new MnemocyteError({
				message: `embedder.dimensions (${embedder.dimensions}) does not match this installation's ${meta.embeddingDimensions}-dimension embedding column. Configure an embedder that returns ${meta.embeddingDimensions} dimensions (many embedding models take a dimensions option), or install Mnemocyte in a fresh database for ${embedder.dimensions}-dimension embeddings; migrate() does not change the dimension of an existing installation.`,
				code: "CONFIG",
				reason: "DIMENSIONS_MISMATCH",
			});
		}
		let installationModel = meta.embeddingModel;
		if (installationModel === null) {
			try {
				const storedModels = await getStoredEmbeddingModels(client, tables);
				if (storedModels.length > 1) {
					throw new MnemocyteError({
						message:
							"mnemocyte_meta.embedding_model is unset, but stored memories contain multiple embedding_model values. Re-embed or remove the mixed historical rows, then explicitly record the installation model before using embedding-dependent operations.",
						code: "MIGRATION",
						reason: "MIXED_MODELS",
					});
				}
				const inferredModel = storedModels[0] ?? embedder.model;
				const recorded = await recordInstallationEmbeddingModel(
					client,
					tables,
					inferredModel,
				);
				if (recorded) {
					installationModel = recorded.embeddingModel;
				} else {
					const concurrentlyRecorded = await getInstallationMeta(
						client,
						tables,
					);
					installationModel = concurrentlyRecorded?.embeddingModel ?? null;
				}
			} catch (error) {
				throw normalize(error);
			}
			if (installationModel === null) {
				throw new MnemocyteError({
					message:
						"mnemocyte_meta.embedding_model could not be recorded. Verify the installation metadata row and retry.",
					code: "MIGRATION",
					reason: "INSTALLATION_INVALID",
				});
			}
		}
		if (installationModel !== embedder.model) {
			throw new MnemocyteError({
				message: `embedder.model ("${embedder.model}") must match mnemocyte_meta.embedding_model ("${installationModel}"). Configure the recorded model, or explicitly re-embed existing memories and update the installation metadata.`,
				code: "CONFIG",
				reason: "MODEL_MISMATCH",
			});
		}
	}

	async function vectorCandidates(
		filter: StoreMemoryFilter,
		query: StoreVectorQuery,
	): Promise<StoreVectorCandidate[]> {
		const minScore = query.minScore ?? 0;
		const [vectorType] = await Promise.all([
			getVectorType(),
			ensurePgvectorVersion(),
		]);
		const rows = await vectorSearchQuery(client, tables, {
			...filter,
			embedding: query.embedding,
			limit: query.limit,
			vectorType,
		});
		// Rows come in increasing distance, so the scores decrease and the
		// rows at or above `minScore` are a prefix: filtering after the
		// LIMIT keeps the same rows as filtering before it.
		return rows
			.map(
				(row) =>
					({
						memory: rowToMemory(row),
						vectorScore: toVectorScore(1 - row.vectorDistance),
					}) satisfies StoreVectorCandidate,
			)
			.filter((candidate) => candidate.vectorScore >= minScore);
	}

	async function lexicalCandidates(
		filter: StoreMemoryFilter,
		query: StoreLexicalQuery,
	): Promise<StoreLexicalCandidate[]> {
		const rows = await lexicalSearchQuery(client, tables, {
			...filter,
			query: query.query,
			limit: query.limit,
			textSearchConfig: await getTextSearchConfig(),
		});
		return rows.map(
			(row) =>
				({
					memory: rowToMemory(row),
					lexicalScore: row.lexicalScore,
				}) satisfies StoreLexicalCandidate,
		);
	}

	async function deleteMemory({
		signal,
		target: _target,
		...input
	}: StoreDeleteMemoryInput): Promise<StoreDeletedMemory | null> {
		throwIfAborted(signal);
		if (!isUuid(input.memoryId)) {
			return null;
		}
		const result = await deleteMemoryQuery(client, tables, input, signal);
		if (!result.found) {
			return null;
		}
		if (result.hasDependents) {
			throw memoryHasDependentsError();
		}
		if (result.hiddenDependents) {
			throw hiddenDependentsError();
		}
		// `isUuid` accepts either case. Postgres returns `uuid` in lower
		// case, and the `"reject"` path echoes the input, so compare in
		// lower case to list the memory once, as `Memory.id` spells it.
		const memoryId = input.memoryId.toLowerCase();
		return {
			target: "memory",
			found: true,
			deletedIds: [
				memoryId,
				...result.deletedIds.filter((id) => id.toLowerCase() !== memoryId),
			],
			restoredIds: result.restoredIds,
		};
	}

	async function deleteScope({
		selector,
		signal,
	}: StoreDeleteScopeInput): Promise<number> {
		throwIfAborted(signal);
		const result = await deleteScopeQuery(client, tables, selector, signal);
		if (result.hasDependents) {
			throw memoryHasDependentsError();
		}
		return result.deletedCount;
	}

	async function prune(input: StoreDeleteFilterInput): Promise<PruneResult> {
		throwIfAborted(input.signal);
		assertPruneFilterHasSelector(input);
		const filter = toPruneFilter(input);
		const dryRun = input.dryRun === true;
		if (dryRun) {
			return {
				matchedCount: await countPruneMatches(
					client,
					tables,
					filter,
					input.signal,
				),
				deletedCount: 0,
				dryRun: true,
			};
		}
		const result = await pruneMemories(
			client,
			tables,
			filter,
			input.audit ? { now: input.now } : undefined,
			input.signal,
		);
		if (result.hasDependents) {
			throw memoryHasDependentsError();
		}
		return {
			matchedCount: result.matchedCount,
			deletedCount: result.deletedCount,
			dryRun: false,
		};
	}

	function toStorePair(row: {
		a: MemoryRow;
		b: MemoryRow;
		similarity: number;
	}): StoreDuplicatePair {
		return {
			a: rowToMemory(row.a),
			b: rowToMemory(row.b),
			similarity: Math.max(0, Math.min(1, row.similarity)),
		};
	}

	async function findDuplicatePairs({
		mode: _mode,
		signal,
		...input
	}: StoreDuplicateTopInput): Promise<StoreDuplicateTop> {
		const rows = await findDuplicatePairsQuery(client, tables, input, signal);
		return { mode: "top", pairs: rows.map(toStorePair) };
	}

	async function findDuplicatePage({
		mode: _mode,
		signal,
		...input
	}: StoreDuplicatePageInput): Promise<StoreDuplicatePage> {
		const page = await findDuplicatePageQuery(client, tables, input, signal);
		return {
			mode: "page",
			pairs: page.pairs.map(toStorePair),
			compared: page.compared,
			lastId: page.lastId,
		};
	}

	return {
		backend: "postgres",
		capabilities: POSTGRES_CAPABILITIES,
		...(tables.schema === null ? {} : { schemaName: tables.schema }),
		migrate(input) {
			return runPostgresMigrations(client, { ...input, tables });
		},
		async setTextSearchConfig(input) {
			const result = await setPostgresTextSearchConfig(client, {
				...input,
				tables,
			});
			if (result.changed && input.dryRun !== true && result.current !== null) {
				textSearchConfigPromise = Promise.resolve(result.current);
			}
			return result;
		},
		inspectInstallation(options) {
			return inspectPostgresInstallation(client, options, tables);
		},
		ensureEmbeddingCompatibility({ embedder }) {
			return ensureEmbeddingCompatibility(embedder);
		},
		async insert({ memories, audit, signal }) {
			return run(async () => {
				throwIfAborted(signal);
				const rows = await insertMemoryRows(
					client,
					tables,
					memories.map(toMemoryRow),
					await getVectorType(),
					signal,
					audit === true ? memories.map(() => createEventId()) : undefined,
				);
				return rows.map(rowToMemory);
			});
		},
		async searchCandidates({ vector, lexical, ...filter }) {
			return run(async () => {
				const [vectorList, lexicalList] = await Promise.all([
					vector === undefined ? [] : vectorCandidates(filter, vector),
					lexical === undefined ? [] : lexicalCandidates(filter, lexical),
				]);
				return { vector: vectorList, lexical: lexicalList };
			});
		},
		async list({ signal, ...input }) {
			return run(async () => {
				throwIfAborted(signal);
				const rows = await listMemoriesQuery(client, tables, input, signal);
				return rows.map(rowToMemory);
			});
		},
		async markAccessed({ visibility, ids }) {
			return run(() =>
				markMemoriesAccessed(client, tables, visibility, uuidsOnly(ids)),
			);
		},
		async get(input) {
			return run(async () => {
				throwIfAborted(input.signal);
				if ("key" in input) {
					const row = await getMemoryByKeyQuery(
						client,
						tables,
						input.scope,
						input.key,
						input.signal,
					);
					return row ? [rowToMemory(row)] : [];
				}
				const rows = await getMemoriesByIds(
					client,
					tables,
					input.visibility,
					uuidsOnly(input.ids),
					input.signal,
				);
				return rows.map(rowToMemory);
			});
		},
		async update(input) {
			try {
				if (!isUuid(input.id)) {
					return null;
				}
				const { patch } = input;
				const row = await updateMemoryQuery(client, tables, {
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
					throw new MnemocyteError({
						message: "Another memory in this scope already uses that key.",
						code: "CONFLICT",
						reason: "KEY_IN_USE",
						cause: error,
					});
				}
				throw normalize(error);
			}
		},
		async delete(input): Promise<StoreDeleteResult> {
			return runDelete(async () => {
				switch (input.target) {
					case "memory":
						return (
							(await deleteMemory(input)) ?? { target: "memory", found: false }
						);
					case "scope":
						return { target: "scope", deletedCount: await deleteScope(input) };
					case "filter":
						return { target: "filter", ...(await prune(input)) };
				}
			});
		},
		async findDuplicates(input) {
			return run<StoreDuplicateResult>(() =>
				input.mode === "top"
					? findDuplicatePairs(input)
					: findDuplicatePage(input),
			);
		},
		async listAudit({ signal, ...input }) {
			return run(async () => {
				// `memory_id` is a uuid: no event is about an id that is not one.
				if (input.memoryId !== undefined && !isUuid(input.memoryId)) {
					throwIfAborted(signal);
					return [];
				}
				const rows = await listEvents(client, tables, input, signal);
				return rows.map(({ row, position }) => ({
					event: rowToAuditEvent(row),
					position,
				}));
			});
		},
		async pruneAudit({ signal, ...input }) {
			return run(async () => {
				throwIfAborted(signal);
				const filter = { selector: input.selector, before: input.before };
				if (input.dryRun) {
					return {
						matchedCount: await countEventsBefore(
							client,
							tables,
							filter,
							signal,
						),
						deletedCount: 0,
						dryRun: true,
					};
				}
				// One statement per batch, each committing on its own, so a large
				// backlog never holds one long transaction. Each batch starts
				// after the last event of the one before; a batch that selects
				// fewer than `batchSize` events was the last one.
				let deletedCount = 0;
				let after: EventPosition | null = null;
				for (;;) {
					throwIfAborted(signal);
					const batch = await deleteEventsBatch(
						client,
						tables,
						filter,
						input.batchSize,
						after,
						signal,
					);
					deletedCount += batch.deletedCount;
					if (batch.selectedCount < input.batchSize || batch.last === null) {
						break;
					}
					after = batch.last;
				}
				return { matchedCount: deletedCount, deletedCount, dryRun: false };
			});
		},
		async consolidate(input) {
			return run(async () => {
				throwIfAborted(input.signal);
				const supersededIds = uuidsOnly(input.supersededIds);
				const result = await consolidateMemories(
					client,
					tables,
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
					input.signal,
				);
				if (!result.survivorActive) {
					throw new MnemocyteError({
						message: "Consolidation survivor changed before mutation.",
						code: "CONFLICT",
						reason: "CONSOLIDATION_CHANGED",
					});
				}
				if (result.hasConflict) {
					throw new MnemocyteError({
						message:
							"Superseded memory already belongs to a different survivor.",
						code: "CONFLICT",
						reason: "CONSOLIDATION_CHANGED",
					});
				}
				return { supersededIds: result.supersededIds };
			});
		},
		async stats({ selector, now, signal }) {
			return run(() =>
				getMemoryStatsCounts(client, tables, selector, now, signal),
			);
		},
	};
}

export function createPostgresClient(
	config: MemoryConfig,
	client: SqlExecutor,
	settings: PostgresStoreSettings = {},
): CoreMemoryClient {
	return createMemoryClient(config, createPostgresStore(client, settings));
}
