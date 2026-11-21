import type { LibsqlExecutor } from "../db/libsql/executor.js";
import {
	inspectLibsqlInstallation,
	readLibsqlTokenizer,
	runLibsqlMigrations,
	setLibsqlTextSearchConfig,
	unrecognizedTokenizerError,
} from "../db/libsql/migrations.js";
import {
	consolidateLibsqlMemories,
	countLibsqlEventsBefore,
	countLibsqlPruneMatches,
	deleteLibsqlEventsBatch,
	deleteLibsqlMemory,
	deleteLibsqlScope,
	getLibsqlMemoriesByIds,
	getLibsqlMemoryByKey,
	getLibsqlMeta,
	getLibsqlStats,
	getLibsqlStoredModels,
	insertLibsqlMemories,
	isLibsqlScopeKeyViolation,
	type LibsqlEventPosition,
	type LibsqlPruneFilter,
	libsqlLexicalSearch,
	libsqlVectorSearch,
	listLibsqlDuplicateCandidates,
	listLibsqlEvents,
	listLibsqlMemories,
	markLibsqlMemoriesAccessed,
	pruneLibsqlMemories,
	recordLibsqlModel,
	updateLibsqlMemory,
} from "../db/libsql/queries.js";
import { isMnemocyteError, MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import { toVectorScore } from "../retrieval/scorer.js";
import type { Embedder, ImportanceLevel } from "../types.js";
import { LIBSQL_CAPABILITIES } from "./capabilities.js";
import { IMPORTANCE_RANK } from "./defaults.js";
import { hiddenDependentsError, memoryHasDependentsError } from "./deletion.js";
import {
	exactDuplicatePage,
	exactDuplicatePairs,
	toStorePair,
} from "./duplicates.js";
import { rowToAuditEvent, rowToMemory } from "./postgres-records.js";
import { createEventId, isUuid } from "./records.js";
import {
	assertPruneFilterHasSelector,
	type MemoryStore,
	type ValidatedPruneFilter,
} from "./store.js";

const LIBSQL_GUIDE_URL =
	"https://github.com/Meenic/mnemocyte/blob/main/docs/guide/libsql.md";
const INSTALL_GUIDE_URL = `${LIBSQL_GUIDE_URL}#install-the-schema`;
const MAX_DRIVER_DETAIL_LENGTH = 200;

const IMPORTANCE_LEVELS: readonly ImportanceLevel[] = [
	"low",
	"normal",
	"high",
	"critical",
];

/** The driver's message, without libSQL's `CODE: ` prefix. */
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

/** A missing Mnemocyte table or column: SQLite says `no such …`. */
function isMissingSchema(error: unknown): boolean {
	const detail = driverDetail(error) ?? "";
	return /no such (table|column)/i.test(detail);
}

function isBusy(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string" &&
		error.code.startsWith("SQLITE_BUSY")
	);
}

function missingSchemaError(error: unknown): MnemocyteError {
	const detail = driverDetail(error);
	return new MnemocyteError({
		message: `Mnemocyte's tables are missing or out of date in this libSQL database${detail ? ` (${detail})` : ""}. Run mnemocyte migrate to create or upgrade them: ${INSTALL_GUIDE_URL}`,
		code: "MIGRATION",
		reason: "SCHEMA_MISSING",
		cause: error,
	});
}

function missingInstallationRowError(): MnemocyteError {
	return new MnemocyteError({
		message: `mnemocyte_meta has no "installation" row, so the embedder cannot be checked against this database. migrate() writes it only when it creates the schema; insert it again as shown in ${LIBSQL_GUIDE_URL}#one-embedding-model-per-database`,
		code: "MIGRATION",
		reason: "INSTALLATION_INVALID",
	});
}

/** Driver errors as {@link MnemocyteError}. */
export function normalizeLibsqlError(error: unknown): MnemocyteError {
	if (isMnemocyteError(error)) {
		return error;
	}
	if (isMissingSchema(error)) {
		return missingSchemaError(error);
	}
	if (isBusy(error)) {
		return new MnemocyteError({
			message:
				"The libSQL database is locked by another write (SQLITE_BUSY). On a local file, another connection or process holds the write lock; retry the call.",
			code: "DB",
			cause: error,
		});
	}
	return new MnemocyteError({
		message: "libSQL operation failed.",
		code: "DB",
		cause: error,
	});
}

async function run<T>(operation: () => Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw normalizeLibsqlError(error);
	}
}

function compatibilityKey(embedder: Embedder): string {
	return `${embedder.dimensions}:${embedder.model}`;
}

/** Canonical UUIDs in lower case; other ids cannot match a row. */
function ids(values: readonly string[]): string[] {
	return values.filter(isUuid).map((id) => id.toLowerCase());
}

function toPruneFilter(input: ValidatedPruneFilter): LibsqlPruneFilter {
	const filter: LibsqlPruneFilter = { selector: input.selector };
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
		const max = IMPORTANCE_RANK[input.maxImportance];
		filter.maxImportanceLevels = IMPORTANCE_LEVELS.filter(
			(level) => IMPORTANCE_RANK[level] <= max,
		);
	}
	return filter;
}

/**
 * The libSQL {@link MemoryStore}: every query is plain SQLite plus libSQL's
 * `vector32` and `vector_distance_cos`, and FTS5. Writes that need several
 * statements run as one `batch(…, "write")` (`BEGIN IMMEDIATE`) whose first
 * statement reads what the others check; no store method holds an
 * interactive transaction.
 */
export function createLibsqlStore(db: LibsqlExecutor): MemoryStore {
	const compatibilityChecks = new Map<string, Promise<void>>();
	let tokenizerCheck: Promise<void> | undefined;

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

	async function validateEmbeddingCompatibility(
		embedder: Embedder,
	): Promise<void> {
		const meta = await run(() => getLibsqlMeta(db));
		if (meta === null) {
			throw missingInstallationRowError();
		}
		if (meta.vectorType !== "F32_BLOB") {
			throw new MnemocyteError({
				message: `mnemocyte_meta.vector_type is ${JSON.stringify(meta.vectorType)}; it must be "F32_BLOB".`,
				code: "MIGRATION",
				reason: "INSTALLATION_INVALID",
			});
		}
		if (meta.dimensions !== embedder.dimensions) {
			throw new MnemocyteError({
				message: `embedder.dimensions (${embedder.dimensions}) does not match this installation's ${meta.dimensions}-dimension embedding column. Configure an embedder that returns ${meta.dimensions} dimensions, or install Mnemocyte in a fresh database; migrate() does not change the dimension of an existing installation.`,
				code: "CONFIG",
				reason: "DIMENSIONS_MISMATCH",
			});
		}
		let model = meta.model;
		if (model === null) {
			const stored = await run(() => getLibsqlStoredModels(db));
			if (stored.length > 1) {
				throw new MnemocyteError({
					message:
						"mnemocyte_meta.embedding_model is unset, but stored memories contain multiple embedding_model values. Re-embed or remove the mixed rows, then record the installation model before using embedding-dependent operations.",
					code: "MIGRATION",
					reason: "MIXED_MODELS",
				});
			}
			const inferred = stored[0] ?? embedder.model;
			const recorded = await run(() => recordLibsqlModel(db, inferred));
			model = recorded
				? inferred
				: ((await run(() => getLibsqlMeta(db)))?.model ?? null);
			if (model === null) {
				throw new MnemocyteError({
					message:
						"mnemocyte_meta.embedding_model could not be recorded. Verify the installation row and retry.",
					code: "MIGRATION",
					reason: "INSTALLATION_INVALID",
				});
			}
		}
		if (model !== embedder.model) {
			throw new MnemocyteError({
				message: `embedder.model ("${embedder.model}") must match mnemocyte_meta.embedding_model ("${model}"). Configure the recorded model, or re-embed existing memories and update the installation row.`,
				code: "CONFIG",
				reason: "MODEL_MISMATCH",
			});
		}
	}

	/**
	 * Once per store, before the first keyword search: a tokenizer this
	 * library did not install is reported instead of searched with.
	 */
	function ensureTokenizer(): Promise<void> {
		tokenizerCheck ??= run(async () => {
			const found = await readLibsqlTokenizer(db);
			if (found.kind === "unrecognized") {
				throw unrecognizedTokenizerError(found.tokenize);
			}
			if (found.kind === "missing") {
				throw missingSchemaError(undefined);
			}
		}).catch((error: unknown) => {
			tokenizerCheck = undefined;
			throw error;
		});
		return tokenizerCheck;
	}

	return {
		backend: "libsql",
		capabilities: LIBSQL_CAPABILITIES,
		migrate(input) {
			return runLibsqlMigrations(db, input);
		},
		async setTextSearchConfig(input) {
			const result = await setLibsqlTextSearchConfig(db, input);
			tokenizerCheck = undefined;
			return result;
		},
		inspectInstallation(options) {
			return run(() => inspectLibsqlInstallation(db, options?.signal));
		},
		ensureEmbeddingCompatibility({ embedder }) {
			return ensureEmbeddingCompatibility(embedder);
		},
		async insert({ memories, audit, signal }) {
			return run(async () => {
				throwIfAborted(signal);
				const rows = await insertLibsqlMemories(
					db,
					memories.map((memory) => ({
						...memory,
						tags: [...memory.tags],
						embedding: [...memory.embedding],
					})),
					audit === true ? memories.map(() => createEventId()) : undefined,
					signal,
				);
				return rows.map(rowToMemory);
			});
		},
		async searchCandidates({ vector, lexical, ...filter }) {
			return run(async () => {
				const now = new Date();
				const [vectorList, lexicalList] = await Promise.all([
					vector === undefined
						? []
						: libsqlVectorSearch(
								db,
								{ ...filter, embedding: vector.embedding, limit: vector.limit },
								now,
							).then((rows) => {
								const minScore = vector.minScore ?? 0;
								// Rows come by increasing distance, so the rows at or
								// above `minScore` are a prefix.
								return rows
									.map((row) => ({
										memory: rowToMemory(row),
										vectorScore: toVectorScore(1 - row.vectorDistance),
									}))
									.filter((candidate) => candidate.vectorScore >= minScore);
							}),
					lexical === undefined
						? []
						: ensureTokenizer()
								.then(() =>
									libsqlLexicalSearch(
										db,
										{ ...filter, query: lexical.query, limit: lexical.limit },
										now,
									),
								)
								.then((rows) =>
									rows.map((row) => ({
										memory: rowToMemory(row),
										lexicalScore: row.lexicalScore,
									})),
								),
				]);
				return { vector: vectorList, lexical: lexicalList };
			});
		},
		async get(input) {
			return run(async () => {
				throwIfAborted(input.signal);
				if ("key" in input) {
					const row = await getLibsqlMemoryByKey(
						db,
						input.scope,
						input.key,
						input.signal,
					);
					return row ? [rowToMemory(row)] : [];
				}
				const rows = await getLibsqlMemoriesByIds(
					db,
					input.visibility,
					ids(input.ids),
					input.signal,
				);
				return rows.map(rowToMemory);
			});
		},
		async list({ signal, ...input }) {
			return run(async () => {
				const rows = await listLibsqlMemories(db, input, new Date(), signal);
				return rows.map(rowToMemory);
			});
		},
		async update(input) {
			try {
				if (!isUuid(input.id)) {
					return null;
				}
				const row = await updateLibsqlMemory(db, {
					visibility: input.visibility,
					id: input.id.toLowerCase(),
					now: input.now,
					...input.patch,
					...(input.audit === undefined
						? {}
						: {
								audit: { eventId: createEventId(), fields: input.audit.fields },
							}),
				});
				return row ? rowToMemory(row) : null;
			} catch (error) {
				if (isLibsqlScopeKeyViolation(error)) {
					throw new MnemocyteError({
						message: "Another memory in this scope already uses that key.",
						code: "CONFLICT",
						reason: "KEY_IN_USE",
						cause: error,
					});
				}
				throw normalizeLibsqlError(error);
			}
		},
		async markAccessed({ visibility, ids: requested }) {
			return run(() =>
				markLibsqlMemoriesAccessed(db, visibility, ids(requested), new Date()),
			);
		},
		async delete(input) {
			return run(async () => {
				throwIfAborted(input.signal);
				switch (input.target) {
					case "memory": {
						if (!isUuid(input.memoryId)) {
							return { target: "memory", found: false };
						}
						const memoryId = input.memoryId.toLowerCase();
						const result = await deleteLibsqlMemory(
							db,
							{
								visibility: input.visibility,
								memoryId,
								dependents: input.dependents,
								now: input.now,
								audit: input.audit,
							},
							input.signal,
						);
						if (!result.found) {
							return { target: "memory", found: false };
						}
						if (result.hasDependents) {
							throw memoryHasDependentsError();
						}
						if (result.hiddenDependents) {
							throw hiddenDependentsError();
						}
						return {
							target: "memory",
							found: true,
							deletedIds: [
								memoryId,
								...result.deletedIds.filter((id) => id !== memoryId),
							],
							restoredIds: result.restoredIds,
						};
					}
					case "scope": {
						const result = await deleteLibsqlScope(
							db,
							input.selector,
							input.signal,
						);
						if (result.hasDependents) {
							throw memoryHasDependentsError();
						}
						return { target: "scope", deletedCount: result.deletedCount };
					}
					case "filter": {
						assertPruneFilterHasSelector(input);
						const filter = toPruneFilter(input);
						if (input.dryRun) {
							return {
								target: "filter",
								matchedCount: await countLibsqlPruneMatches(
									db,
									filter,
									input.now,
									input.signal,
								),
								deletedCount: 0,
								dryRun: true,
							};
						}
						const result = await pruneLibsqlMemories(
							db,
							filter,
							input.now,
							input.audit,
							input.signal,
						);
						if (result.hasDependents) {
							throw memoryHasDependentsError();
						}
						return {
							target: "filter",
							matchedCount: result.matchedCount,
							deletedCount: result.deletedCount,
							dryRun: false,
						};
					}
				}
			});
		},
		async consolidate(input) {
			return run(async () => {
				throwIfAborted(input.signal);
				if (!isUuid(input.survivorId)) {
					throw new MnemocyteError({
						message: "Consolidation survivor changed before mutation.",
						code: "CONFLICT",
						reason: "CONSOLIDATION_CHANGED",
					});
				}
				const supersededIds = ids(input.supersededIds);
				const result = await consolidateLibsqlMemories(
					db,
					{
						visibility: input.visibility,
						survivorId: input.survivorId.toLowerCase(),
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
		async findDuplicates(input) {
			return run(async () => {
				const { mode: _mode, signal, ...filter } = input;
				const candidates = (
					await listLibsqlDuplicateCandidates(db, filter, new Date(), signal)
				).map(({ row, embedding }) => ({ ...rowToMemory(row), embedding }));
				if (input.mode === "top") {
					return {
						mode: "top",
						pairs: exactDuplicatePairs(candidates, input, signal).map(
							toStorePair,
						),
					};
				}
				const page = exactDuplicatePage(candidates, input, signal);
				return { mode: "page", ...page, pairs: page.pairs.map(toStorePair) };
			});
		},
		async listAudit({ signal, ...input }) {
			return run(async () => {
				const rows = await listLibsqlEvents(db, input, signal);
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
						matchedCount: await countLibsqlEventsBefore(db, filter, signal),
						deletedCount: 0,
						dryRun: true,
					};
				}
				// One statement per batch, each committing on its own; a batch
				// that deletes fewer than `batchSize` events was the last.
				let deletedCount = 0;
				let after: LibsqlEventPosition | null = null;
				for (;;) {
					throwIfAborted(signal);
					const batch = await deleteLibsqlEventsBatch(
						db,
						filter,
						input.batchSize,
						after,
						signal,
					);
					deletedCount += batch.deletedCount;
					if (batch.deletedCount < input.batchSize || batch.last === null) {
						break;
					}
					after = batch.last;
				}
				return { matchedCount: deletedCount, deletedCount, dryRun: false };
			});
		},
		async stats({ selector, now, signal }) {
			return run(() => getLibsqlStats(db, selector, now, signal));
		},
	};
}
