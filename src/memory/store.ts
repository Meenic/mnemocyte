import type { InstallationReport } from "../db/migrations/inspect.js";
import { MnemocyteError } from "../errors.js";
import type {
	AuditEvent,
	DependentsPolicy,
	Embedder,
	ImportanceLevel,
	JsonObject,
	Memory,
	MemoryKind,
	MemoryRecordScope,
	MemoryStats,
	MigrateResult,
	MnemocyteBackend,
	PruneAuditLogResult,
	PruneResult,
	TextSearchConfigResult,
} from "../types.js";
import type { StoredMemory } from "./records.js";

/**
 * Where a memory lives. `agentId` and `sessionId` are null for memories shared
 * by every agent or outside any session.
 */
export type StoreScope = MemoryRecordScope;

/**
 * What a read or a write by id can see: rows of the scope's namespace and
 * entity whose agent and session match the scope's or are null (shared). A
 * null field in the scope matches only null rows. `exactAgent` and
 * `exactSession` drop the shared rows for that field.
 */
export interface StoreVisibility {
	readonly scope: StoreScope;
	readonly exactAgent: boolean;
	readonly exactSession: boolean;
}

/**
 * Rows selected by a bulk operation: every field that is set must match
 * exactly, and a missing field matches any value. A null `namespace` selects
 * every namespace (`allNamespaces: true`).
 */
export interface StoreSelector {
	readonly namespace: string | null;
	readonly entityId?: string;
	readonly agentId?: string;
	readonly sessionId?: string;
}

/** A selector for one entity, as a `"scope"` delete takes. */
export interface StoreEntitySelector extends StoreSelector {
	readonly namespace: string;
	readonly entityId: string;
}

/**
 * What a backend does differently, declared as data. The core reads it to
 * choose its fusion inputs (no lexical list with `lexicalSearch: "none"`),
 * and the shared tests read it to set their expectations; nothing else
 * branches on it.
 */
export interface StoreCapabilities {
	/** `"exact"` compares the query with every row; `"approximate"` uses an index. */
	readonly vectorSearch: "exact" | "approximate";
	/**
	 * When filters apply to a vector search: before it (`"prefilter"`), after
	 * an index scan that can then return fewer than the limit
	 * (`"postfilter"`), or during a scan that continues until the limit is met
	 * or a scan cap is reached (`"iterative"`; pgvector's
	 * `hnsw.max_scan_tuples`).
	 */
	readonly filteredVectorSearch: "prefilter" | "postfilter" | "iterative";
	/**
	 * How keyword candidates are scored; `"overlap"` is the share of query
	 * terms a memory contains. `"none"` means no keyword search.
	 */
	readonly lexicalSearch: "bm25" | "ts_rank" | "overlap" | "none";
	/**
	 * What concurrent writes wait on: the rows they change, or the whole
	 * database (one write at a time).
	 */
	readonly locking: "row" | "database";
	/** The largest embedding the backend can store and search. */
	readonly maxDimensions: number;
}

export interface StoreOperationOptions {
	signal?: AbortSignal;
}

export interface StoreMemoryFilter {
	readonly visibility: StoreVisibility;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly createdBefore?: Date;
	readonly createdAfter?: Date;
	readonly includeSuperseded?: boolean;
	readonly includeExpired?: boolean;
}

/** The vector list of a {@link MemoryStore.searchCandidates} call. */
export interface StoreVectorQuery {
	readonly embedding: readonly number[];
	readonly limit: number;
	readonly minScore?: number;
}

/** The lexical list of a {@link MemoryStore.searchCandidates} call. */
export interface StoreLexicalQuery {
	readonly query: string;
	readonly limit: number;
}

/** One filter, and the lists to fill with it; a list left out stays empty. */
export interface StoreSearchInput extends StoreMemoryFilter {
	readonly vector?: StoreVectorQuery;
	readonly lexical?: StoreLexicalQuery;
}

export interface StoreVectorCandidate {
	memory: Memory;
	/** Finite cosine component clamped to the inclusive range `[0, 1]`. */
	vectorScore: number;
}

export interface StoreLexicalCandidate {
	memory: Memory;
	lexicalScore: number;
}

export interface StoreSearchCandidates {
	vector: StoreVectorCandidate[];
	lexical: StoreLexicalCandidate[];
}

/** Memories by id, as far as `visibility` sees them. */
export interface StoreGetByIdsInput extends StoreOperationOptions {
	readonly visibility: StoreVisibility;
	readonly ids: readonly string[];
}

/** The memory with this key in exactly this scope. */
export interface StoreGetByKeyInput extends StoreOperationOptions {
	readonly scope: StoreScope;
	readonly key: string;
}

export type StoreGetInput = StoreGetByIdsInput | StoreGetByKeyInput;

/** Position of the last row of a `list` page. */
export interface StoreListPosition {
	readonly createdAt: Date;
	readonly id: string;
}

export interface StoreListInput
	extends StoreMemoryFilter,
		StoreOperationOptions {
	readonly limit: number;
	/** Return rows strictly after this position in `(createdAt, id)` descending order. */
	readonly position?: StoreListPosition;
}

export interface StoreInsertInput extends StoreOperationOptions {
	readonly memories: readonly StoredMemory[];
	/**
	 * Records `memory.created` or `memory.updated` per row in the same write,
	 * timestamped with the row's `updatedAt`.
	 */
	readonly audit?: boolean;
}

/** Fields an update replaces. A new `embedding` comes with its model. */
export interface StoreMemoryPatch {
	readonly content?: string;
	readonly embedding?: readonly number[];
	readonly embeddingModel?: string;
	readonly embeddingDimensions?: number;
	readonly key?: string | null;
	readonly kind?: MemoryKind;
	readonly importance?: ImportanceLevel;
	readonly tags?: readonly string[];
	readonly source?: string | null;
	readonly metadata?: JsonObject;
	readonly confidence?: number;
	readonly expiresAt?: Date | null;
}

export interface StoreUpdateInput {
	readonly visibility: StoreVisibility;
	readonly id: string;
	readonly patch: StoreMemoryPatch;
	readonly now: Date;
	/**
	 * Records `memory.updated` in the same write, listing these fields, when
	 * set.
	 */
	readonly audit?: { readonly fields: readonly string[] };
}

export interface StoreMarkAccessedInput {
	readonly visibility: StoreVisibility;
	/** Distinct ids. */
	readonly ids: readonly string[];
}

/** One memory by id, and its dependents by `dependents`. */
export interface StoreDeleteMemoryInput extends StoreOperationOptions {
	readonly target: "memory";
	readonly visibility: StoreVisibility;
	readonly memoryId: string;
	readonly dependents: DependentsPolicy;
	/** `updatedAt` of restored dependents and the audit events' timestamp. */
	readonly now: Date;
	/** Records one `memory.deleted` per deleted memory in the same write. */
	readonly audit: boolean;
}

/** Every memory and audit event of one entity, or of part of it. */
export interface StoreDeleteScopeInput extends StoreOperationOptions {
	readonly target: "scope";
	readonly selector: StoreEntitySelector;
}

/** The memories a `prune` filter matches, already validated. */
export interface StoreDeleteFilterInput
	extends ValidatedPruneFilter,
		StoreOperationOptions {
	readonly target: "filter";
	/** Expiry reference and the audit events' timestamp. */
	readonly now: Date;
	/** Records one `memory.pruned` per affected entity in the same write. */
	readonly audit: boolean;
}

export type StoreDeleteInput =
	| StoreDeleteMemoryInput
	| StoreDeleteScopeInput
	| StoreDeleteFilterInput;

/** A `"memory"` delete that found the memory. */
export interface StoreDeletedMemory {
	readonly target: "memory";
	readonly found: true;
	/** The memory, then the dependents deleted with it (`"delete"`). */
	readonly deletedIds: readonly string[];
	/** Dependents made active again (`"restore"`). */
	readonly restoredIds: readonly string[];
}

/** The result of a delete, tagged with the input's `target`. */
export type StoreDeleteResult =
	| StoreDeletedMemory
	| { readonly target: "memory"; readonly found: false }
	| { readonly target: "scope"; readonly deletedCount: number }
	| ({ readonly target: "filter" } & PruneResult);

export interface StoreDuplicateFilter extends StoreOperationOptions {
	readonly visibility: StoreVisibility;
	readonly threshold: number;
	/** Nearest neighbors compared per memory. */
	readonly neighbors: number;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly includeSuperseded?: boolean;
	readonly includeExpired?: boolean;
}

/** The most similar pairs, up to `limit`. */
export interface StoreDuplicateTopInput extends StoreDuplicateFilter {
	readonly mode: "top";
	readonly limit: number;
}

/** One page of a run over every memory, by id. */
export interface StoreDuplicatePageInput extends StoreDuplicateFilter {
	readonly mode: "page";
	/** Memories whose neighbors the page compares. */
	readonly batchSize: number;
	/** Compare only memories whose id is greater than this one. */
	readonly afterId?: string;
}

export type StoreDuplicateInput =
	| StoreDuplicateTopInput
	| StoreDuplicatePageInput;

export interface StoreDuplicatePair {
	a: Memory;
	b: Memory;
	similarity: number;
}

export interface StoreDuplicateTop {
	readonly mode: "top";
	pairs: StoreDuplicatePair[];
}

export interface StoreDuplicatePage {
	readonly mode: "page";
	/** The pairs the page owns, ordered like a `"top"` result. */
	pairs: StoreDuplicatePair[];
	/** Memories whose neighbors the page compared. */
	compared: number;
	/** The greatest id the page compared, or `null` when it compared none. */
	lastId: string | null;
}

/** The result of a duplicate search, tagged with the input's `mode`. */
export type StoreDuplicateResult = StoreDuplicateTop | StoreDuplicatePage;

/**
 * Where an audit page stops: an event's `(timestamp, id)`, with the
 * timestamp as UTC ISO 8601 text with six fraction digits
 * (`2026-11-14T09:30:00.123456Z`), the precision Postgres stores.
 */
export interface StoreAuditPosition {
	readonly timestamp: string;
	readonly id: string;
}

export interface StoreAuditLogInput extends StoreOperationOptions {
	readonly selector: StoreSelector;
	readonly limit: number;
	readonly before?: Date;
	readonly after?: Date;
	/** Only events whose `metadata.memoryId` is this id. */
	readonly memoryId?: string;
	/** Return events strictly after this position in `(timestamp, id)` descending order. */
	readonly position?: StoreAuditPosition;
}

/** An event of an audit page and its position. */
export interface StoreAuditLogEntry {
	readonly event: AuditEvent;
	readonly position: StoreAuditPosition;
}

/** Audit events a `pruneAuditLog` deletes, already validated. */
export interface StoreAuditPruneInput extends StoreOperationOptions {
	readonly selector: StoreSelector;
	/** Events strictly before this time are selected. */
	readonly before: Date;
	/** Most events one statement deletes. */
	readonly batchSize: number;
	readonly dryRun: boolean;
}

export interface StoreConsolidateInput extends StoreOperationOptions {
	visibility: StoreVisibility;
	survivorId: string;
	supersededIds: readonly string[];
	mergeTags: boolean;
	now: Date;
	auditEnabled: boolean;
}

export interface StoreConsolidateResult {
	supersededIds: readonly string[];
}

export interface StoreStatsInput extends StoreOperationOptions {
	readonly selector: StoreSelector;
	/** What `expired` is evaluated against. */
	readonly now: Date;
}

export interface StoreMigrateInput {
	readonly dimensions?: number;
	readonly textSearchConfig?: string;
	readonly createExtension?: boolean;
	readonly dryRun?: boolean;
	readonly signal?: AbortSignal;
}

export interface StoreTextSearchConfigInput {
	readonly textSearchConfig: string;
	readonly dryRun?: boolean;
	readonly signal?: AbortSignal;
}

export interface StoreEmbedderInput {
	readonly embedder: Embedder;
}

export interface ValidatedPruneFilter {
	readonly selector: StoreSelector;
	readonly expired?: true;
	readonly superseded?: true;
	readonly createdBefore?: Date;
	readonly notAccessedSince?: Date;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly maxImportance?: ImportanceLevel;
	readonly dryRun: boolean;
}

/** Whether the filter has a selector besides its scope. */
export function hasPruneSelector(filter: ValidatedPruneFilter): boolean {
	return (
		filter.expired === true ||
		filter.superseded === true ||
		filter.createdBefore !== undefined ||
		filter.notAccessedSince !== undefined ||
		(filter.kinds !== undefined && filter.kinds.length > 0) ||
		(filter.tags !== undefined && filter.tags.length > 0) ||
		filter.maxImportance !== undefined
	);
}

export function assertPruneFilterHasSelector(
	filter: ValidatedPruneFilter,
): void {
	if (!hasPruneSelector(filter)) {
		throw new MnemocyteError({
			message:
				"prune requires at least one selector besides its scope (expired, superseded, createdBefore, notAccessedSince, kinds, tags, or maxImportance). Use deleteScope to delete a whole scope.",
			code: "VALIDATION",
		});
	}
}

/**
 * Internal storage adapter boundary used by the shared client orchestration.
 * Not exported from the package.
 *
 * Every method takes one input object. Every method that reads or writes
 * memories takes a scope: a {@link StoreVisibility} for reads and writes by
 * id, a {@link StoreSelector} for bulk operations.
 *
 * Deleting a referenced consolidation survivor through a `"memory"` delete
 * or a non-dry-run `"filter"` delete must reject with `"CONFLICT"` before
 * deleting anything. A `"scope"` delete rejects only when a dependent
 * outside the selection remains. The dependency check and mutation must be
 * one atomic operation.
 *
 * Unless a method documents a stronger boundary, cancellation support and its
 * mechanism are implementation-defined.
 */
export interface MemoryStore {
	readonly backend: MnemocyteBackend;
	/** What the backend does differently; see {@link StoreCapabilities}. */
	readonly capabilities: StoreCapabilities;
	/**
	 * The Postgres schema of the tables when the store was given one
	 * (`schemaName`); left out when they resolve through `search_path`. The
	 * CLI reads it from the memory file's store. A store from an older copy
	 * of the package has none.
	 */
	readonly schemaName?: string;

	/**
	 * Applies the store's pending schema migrations. This is the only method
	 * that changes schema, and it runs only when the caller asks for it through
	 * `migrate()`. A store without persistent schema resolves with nothing
	 * applied.
	 */
	migrate(input: StoreMigrateInput): Promise<MigrateResult>;
	/**
	 * Changes the text search configuration of keyword search, through
	 * `setTextSearchConfig()`. On Postgres this rewrites the memories table.
	 * A store without one resolves with `null` names and `changed: false`.
	 */
	setTextSearchConfig(
		input: StoreTextSearchConfigInput,
	): Promise<TextSearchConfigResult>;
	/**
	 * What is installed, read without changing anything: the report behind
	 * the CLI's `check`. A store without persistent schema resolves with
	 * `null`.
	 */
	inspectInstallation(
		input?: StoreOperationOptions,
	): Promise<InstallationReport | null>;
	/**
	 * Rejects with `"MIGRATION"` or `"CONFIG"` when the embedder does not match
	 * the installation. A store without persistent installation state resolves
	 * without work.
	 */
	ensureEmbeddingCompatibility(input: StoreEmbedderInput): Promise<void>;

	/**
	 * Inserts fresh rows, or for a row with a `key` already used in its exact
	 * scope, replaces that memory's content fields (keeping its id, creation
	 * time, access counts and consolidation link). Returns one detached record
	 * per input row: the inserted row, or the updated existing row with its
	 * own id. Keys must be distinct within the call.
	 *
	 * Order is untrusted: shared code matches results to inputs by id, or by
	 * key for keyed rows.
	 *
	 * All or nothing: when any row fails, none is written. A backend may
	 * split the rows into several statements, but they commit together, and
	 * so do their audit events.
	 */
	insert(input: StoreInsertInput): Promise<Memory[]>;
	/**
	 * The candidate lists of a search, with the same filter. `vector` holds
	 * up to `vector.limit` candidates that pass the filter and
	 * `vector.minScore`, by decreasing vector similarity; every `vectorScore`
	 * is finite and clamped to `[0, 1]`, and with an approximate index,
	 * inclusion and order may differ from an exhaustive scan. `lexical` holds
	 * up to `lexical.limit` candidates that pass the filter and have a
	 * positive, backend-defined lexical score, by decreasing score. A list
	 * whose query is left out comes back empty without being searched.
	 */
	searchCandidates(input: StoreSearchInput): Promise<StoreSearchCandidates>;
	/**
	 * The visible memories with these ids, in no particular order, or the
	 * memory with this key in exactly this scope. Ids nobody can see, or that
	 * do not exist, are left out.
	 */
	get(input: StoreGetInput): Promise<Memory[]>;
	/**
	 * Up to `input.limit` memories that pass the filter, newest first by
	 * `(createdAt, id)`, after `input.position` when given.
	 */
	list(input: StoreListInput): Promise<Memory[]>;
	/**
	 * Applies the patch to the visible memory with this id in one atomic write
	 * and returns it, or `null` when no such memory exists. Sets `updatedAt`.
	 * Rejects with `"CONFLICT"` when the new key is already used in the
	 * memory's scope. The audit event, when requested, is written in the
	 * same atomic write.
	 */
	update(input: StoreUpdateInput): Promise<Memory | null>;
	/**
	 * Increments `accessCount` and sets `lastAccessedAt` once for each
	 * requested memory that is still visible; others are skipped. Never changes
	 * `updatedAt`.
	 */
	markAccessed(input: StoreMarkAccessedInput): Promise<void>;
	/**
	 * Deletes, atomically, and returns a result tagged with `input.target`:
	 *
	 * - `"memory"`: the visible memory with this id, or `found: false` when
	 *   there is none. Its dependents (memories whose `supersededBy` points
	 *   at it) follow `dependents`: `"reject"` throws `"CONFLICT"` when there
	 *   is any; `"restore"` clears their `supersededBy` and `supersededAt`;
	 *   `"delete"` deletes them and, transitively, their own dependents. With
	 *   `"restore"` a direct dependent, and with `"delete"` any deleted one,
	 *   that is not visible throws `"CONFLICT"`. Nothing changes on a
	 *   conflict.
	 * - `"scope"`: every selected memory and the selected audit events, with
	 *   the number of memories deleted. Rejects with `"CONFLICT"` and deletes
	 *   nothing when a memory outside the selection references a selected one
	 *   through `supersededBy`.
	 * - `"filter"`: the matching memories, or only their count on a dry run.
	 *
	 * Audit events, when requested, are written atomically with the delete.
	 */
	delete(input: StoreDeleteInput): Promise<StoreDeleteResult>;
	/**
	 * Applies one atomic consolidation after re-reading and protecting the
	 * survivor and requested losers. Throws `"CONFLICT"` before mutation when
	 * the survivor is missing or superseded, or when any requested loser points
	 * to a different survivor. Tag merging starts from the protected survivor's
	 * mutation-time tags.
	 */
	consolidate(input: StoreConsolidateInput): Promise<StoreConsolidateResult>;
	/**
	 * Pairs of visible memories meeting the similarity threshold where one is
	 * among the other's `neighbors` nearest (approximate on an HNSW index),
	 * tagged with `input.mode`. `a.id` is the smaller id, and similarities
	 * are clamped to `[0, 1]`.
	 *
	 * - `"top"`: unordered pairs by decreasing similarity, then `a.id`, then
	 *   `b.id`, up to the limit.
	 * - `"page"`: the first `batchSize` memories that pass the filters with an
	 *   id greater than `afterId`, in id order, each compared with every
	 *   memory that passes them. A pair found from memory `x` is returned when
	 *   `x` has the smaller id, or when the smaller id's own `neighbors`
	 *   nearest do not include `x`; either way it belongs to exactly one page
	 *   of a run, the page of the memory whose neighbors contain the other
	 *   (the smaller id's when both do). No limit.
	 */
	findDuplicates(input: StoreDuplicateInput): Promise<StoreDuplicateResult>;

	/**
	 * Selected events in strict descending `(timestamp, id)` order, up to the
	 * limit, each with its position. `before` / `after` are strict timestamp
	 * filters; `position` is a strict tuple filter on `(timestamp, id)` at
	 * the store's full timestamp precision.
	 */
	listAudit(input: StoreAuditLogInput): Promise<StoreAuditLogEntry[]>;
	/**
	 * Deletes the selected events strictly before `before`, at most
	 * `batchSize` per statement, or counts them on a dry run. Batches commit
	 * one by one; the signal is checked before each, so an abort keeps the
	 * batches already deleted.
	 */
	pruneAudit(input: StoreAuditPruneInput): Promise<PruneAuditLogResult>;

	/**
	 * Counts of the selected memories evaluated against `now`. Active memories
	 * are neither expired nor superseded; expired and superseded counts may
	 * overlap. `entityCount` counts distinct `(namespace, entityId)` pairs.
	 */
	stats(input: StoreStatsInput): Promise<MemoryStats>;
}
