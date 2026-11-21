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
	PruneAuditLogResult,
	PruneResult,
} from "../types.js";

// The public store contract, version 1, exported from `mnemocyte/store`.
// The core's internal `MemoryStore` (store.ts) is this contract plus what
// only the first-party backends have; the types here are the declarations,
// and store.ts aliases them under their internal `Store…` names.

/**
 * What a read or a write by id can see: memories of the scope's namespace
 * and entity whose `agentId` and `sessionId` match the scope's or are null
 * (shared). A null field in the scope matches only null memories.
 * `exactAgent` and `exactSession` leave out the shared memories for that
 * field.
 */
export interface MemoryStoreV1Visibility {
	readonly scope: MemoryRecordScope;
	readonly exactAgent: boolean;
	readonly exactSession: boolean;
}

/**
 * Memories selected by a bulk operation: every field that is set must match
 * exactly, and a missing field matches any value. A null `namespace`
 * selects every namespace (`allNamespaces: true`).
 */
export interface MemoryStoreV1Selector {
	readonly namespace: string | null;
	readonly entityId?: string;
	readonly agentId?: string;
	readonly sessionId?: string;
}

/** A selector for one entity, as a `"scope"` delete takes. */
export interface MemoryStoreV1EntitySelector extends MemoryStoreV1Selector {
	readonly namespace: string;
	readonly entityId: string;
}

/**
 * What a backend does differently, declared as data. The core reads it to
 * choose its fusion inputs (no lexical list with `lexicalSearch: "none"`)
 * and to check `migrate()` dimensions, and the contract suite reads it to
 * set its expectations; nothing else branches on it.
 */
export interface MemoryStoreV1Capabilities {
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
	/**
	 * The largest embedding the backend can store and search; a positive
	 * integer or `Number.POSITIVE_INFINITY`.
	 */
	readonly maxDimensions: number;
}

/** Options a store call may carry. */
export interface MemoryStoreV1CallOptions {
	/** Set only when the caller passed one. */
	signal?: AbortSignal;
}

/** A memory as the store keeps it: the record plus its embedding. */
export interface MemoryStoreV1Row extends Memory {
	embedding: number[];
}

/** The filter of `searchCandidates` and `list`. */
export interface MemoryStoreV1Filter {
	readonly visibility: MemoryStoreV1Visibility;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly createdBefore?: Date;
	readonly createdAfter?: Date;
	readonly includeSuperseded?: boolean;
	readonly includeExpired?: boolean;
}

/** The vector list of a {@link MemoryStoreV1.searchCandidates} call. */
export interface MemoryStoreV1VectorQuery {
	readonly embedding: readonly number[];
	readonly limit: number;
	readonly minScore?: number;
}

/** The lexical list of a {@link MemoryStoreV1.searchCandidates} call. */
export interface MemoryStoreV1LexicalQuery {
	readonly query: string;
	readonly limit: number;
}

/** One filter, and the lists to fill with it; a list left out stays empty. */
export interface MemoryStoreV1SearchInput extends MemoryStoreV1Filter {
	readonly vector?: MemoryStoreV1VectorQuery;
	readonly lexical?: MemoryStoreV1LexicalQuery;
}

export interface MemoryStoreV1VectorCandidate {
	memory: Memory;
	/** Finite cosine component clamped to the inclusive range `[0, 1]`. */
	vectorScore: number;
}

export interface MemoryStoreV1LexicalCandidate {
	memory: Memory;
	/** Positive and backend-defined; only its order within one list matters. */
	lexicalScore: number;
}

export interface MemoryStoreV1SearchCandidates {
	vector: MemoryStoreV1VectorCandidate[];
	lexical: MemoryStoreV1LexicalCandidate[];
}

/** Memories by id, as far as `visibility` sees them. */
export interface MemoryStoreV1GetByIdsInput extends MemoryStoreV1CallOptions {
	readonly visibility: MemoryStoreV1Visibility;
	readonly ids: readonly string[];
}

/** The memory with this key in exactly this scope. */
export interface MemoryStoreV1GetByKeyInput extends MemoryStoreV1CallOptions {
	readonly scope: MemoryRecordScope;
	readonly key: string;
}

export type MemoryStoreV1GetInput =
	| MemoryStoreV1GetByIdsInput
	| MemoryStoreV1GetByKeyInput;

/** Position of the last memory of a `list` page. */
export interface MemoryStoreV1ListPosition {
	readonly createdAt: Date;
	readonly id: string;
}

export interface MemoryStoreV1ListInput
	extends MemoryStoreV1Filter,
		MemoryStoreV1CallOptions {
	readonly limit: number;
	/** Return memories strictly after this position in `(createdAt, id)` descending order. */
	readonly position?: MemoryStoreV1ListPosition;
}

export interface MemoryStoreV1InsertInput extends MemoryStoreV1CallOptions {
	readonly memories: readonly MemoryStoreV1Row[];
	/**
	 * Records `memory.created` or `memory.updated` per row in the same write,
	 * timestamped with the row's `updatedAt`.
	 */
	readonly audit?: boolean;
}

/** Fields an update replaces. A new `embedding` comes with its model. */
export interface MemoryStoreV1Patch {
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

export interface MemoryStoreV1UpdateInput {
	readonly visibility: MemoryStoreV1Visibility;
	readonly id: string;
	readonly patch: MemoryStoreV1Patch;
	readonly now: Date;
	/**
	 * Records `memory.updated` in the same write, listing these fields, when
	 * set.
	 */
	readonly audit?: { readonly fields: readonly string[] };
}

export interface MemoryStoreV1MarkAccessedInput {
	readonly visibility: MemoryStoreV1Visibility;
	/** Distinct ids. */
	readonly ids: readonly string[];
}

/** One memory by id, and its dependents by `dependents`. */
export interface MemoryStoreV1DeleteMemoryInput
	extends MemoryStoreV1CallOptions {
	readonly target: "memory";
	readonly visibility: MemoryStoreV1Visibility;
	readonly memoryId: string;
	readonly dependents: DependentsPolicy;
	/** `updatedAt` of restored dependents and the audit events' timestamp. */
	readonly now: Date;
	/** Records one `memory.deleted` per deleted memory in the same write. */
	readonly audit: boolean;
}

/** Every memory and audit event of one entity, or of part of it. */
export interface MemoryStoreV1DeleteScopeInput
	extends MemoryStoreV1CallOptions {
	readonly target: "scope";
	readonly selector: MemoryStoreV1EntitySelector;
}

/**
 * What a `prune` deletes, already validated: at least one field besides
 * `selector` is set.
 */
export interface MemoryStoreV1PruneFilter {
	readonly selector: MemoryStoreV1Selector;
	readonly expired?: true;
	readonly superseded?: true;
	readonly createdBefore?: Date;
	readonly notAccessedSince?: Date;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly maxImportance?: ImportanceLevel;
	readonly dryRun: boolean;
}

/** The memories a `prune` filter matches. */
export interface MemoryStoreV1DeleteFilterInput
	extends MemoryStoreV1PruneFilter,
		MemoryStoreV1CallOptions {
	readonly target: "filter";
	/** Expiry reference and the audit events' timestamp. */
	readonly now: Date;
	/** Records one `memory.pruned` per affected entity in the same write. */
	readonly audit: boolean;
}

export type MemoryStoreV1DeleteInput =
	| MemoryStoreV1DeleteMemoryInput
	| MemoryStoreV1DeleteScopeInput
	| MemoryStoreV1DeleteFilterInput;

/** A `"memory"` delete that found the memory. */
export interface MemoryStoreV1DeletedMemory {
	readonly target: "memory";
	readonly found: true;
	/** The memory, then the dependents deleted with it (`"delete"`). */
	readonly deletedIds: readonly string[];
	/** Dependents made active again (`"restore"`). */
	readonly restoredIds: readonly string[];
}

/** The result of a delete, tagged with the input's `target`. */
export type MemoryStoreV1DeleteResult =
	| MemoryStoreV1DeletedMemory
	| { readonly target: "memory"; readonly found: false }
	| { readonly target: "scope"; readonly deletedCount: number }
	| ({ readonly target: "filter" } & PruneResult);

/** The filter of a duplicate search. */
export interface MemoryStoreV1DuplicateFilter extends MemoryStoreV1CallOptions {
	readonly visibility: MemoryStoreV1Visibility;
	readonly threshold: number;
	/** Nearest neighbors compared per memory. */
	readonly neighbors: number;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly includeSuperseded?: boolean;
	readonly includeExpired?: boolean;
}

/** The most similar pairs, up to `limit`. */
export interface MemoryStoreV1DuplicateTopInput
	extends MemoryStoreV1DuplicateFilter {
	readonly mode: "top";
	readonly limit: number;
}

/** One page of a run over every memory, by id. */
export interface MemoryStoreV1DuplicatePageInput
	extends MemoryStoreV1DuplicateFilter {
	readonly mode: "page";
	/** Memories whose neighbors the page compares. */
	readonly batchSize: number;
	/** Compare only memories whose id is greater than this one. */
	readonly afterId?: string;
}

export type MemoryStoreV1DuplicateInput =
	| MemoryStoreV1DuplicateTopInput
	| MemoryStoreV1DuplicatePageInput;

export interface MemoryStoreV1DuplicatePair {
	a: Memory;
	b: Memory;
	similarity: number;
}

export interface MemoryStoreV1DuplicateTop {
	readonly mode: "top";
	pairs: MemoryStoreV1DuplicatePair[];
}

export interface MemoryStoreV1DuplicatePage {
	readonly mode: "page";
	/** The pairs the page owns, ordered like a `"top"` result. */
	pairs: MemoryStoreV1DuplicatePair[];
	/** Memories whose neighbors the page compared. */
	compared: number;
	/** The greatest id the page compared, or `null` when it compared none. */
	lastId: string | null;
}

/** The result of a duplicate search, tagged with the input's `mode`. */
export type MemoryStoreV1DuplicateResult =
	| MemoryStoreV1DuplicateTop
	| MemoryStoreV1DuplicatePage;

/**
 * Where an audit page stops: an event's `(timestamp, id)`, with the
 * timestamp as UTC ISO 8601 text with six fraction digits
 * (`2026-11-14T09:30:00.123456Z`), the precision Postgres stores. A store
 * that keeps milliseconds writes `000` for the last three.
 */
export interface MemoryStoreV1AuditPosition {
	readonly timestamp: string;
	readonly id: string;
}

export interface MemoryStoreV1AuditLogInput extends MemoryStoreV1CallOptions {
	readonly selector: MemoryStoreV1Selector;
	readonly limit: number;
	readonly before?: Date;
	readonly after?: Date;
	/** Only events whose `metadata.memoryId` is this id. */
	readonly memoryId?: string;
	/** Return events strictly after this position in `(timestamp, id)` descending order. */
	readonly position?: MemoryStoreV1AuditPosition;
}

/** An event of an audit page and its position. */
export interface MemoryStoreV1AuditLogEntry {
	readonly event: AuditEvent;
	readonly position: MemoryStoreV1AuditPosition;
}

/** Audit events a `pruneAuditLog` deletes, already validated. */
export interface MemoryStoreV1AuditPruneInput extends MemoryStoreV1CallOptions {
	readonly selector: MemoryStoreV1Selector;
	/** Events strictly before this time are selected. */
	readonly before: Date;
	/** Most events one statement deletes. */
	readonly batchSize: number;
	readonly dryRun: boolean;
}

export interface MemoryStoreV1ConsolidateInput
	extends MemoryStoreV1CallOptions {
	readonly visibility: MemoryStoreV1Visibility;
	readonly survivorId: string;
	readonly supersededIds: readonly string[];
	readonly mergeTags: boolean;
	readonly now: Date;
	readonly auditEnabled: boolean;
}

export interface MemoryStoreV1ConsolidateResult {
	supersededIds: readonly string[];
}

export interface MemoryStoreV1StatsInput extends MemoryStoreV1CallOptions {
	readonly selector: MemoryStoreV1Selector;
	/** What `expired` is evaluated against. */
	readonly now: Date;
}

/** What `migrate()` passes on, after checking it. */
export interface MemoryStoreV1MigrateInput {
	/** The embedding dimensions, when the caller gave or implied them. */
	readonly dimensions?: number;
	/** Postgres's text search configuration; other stores may ignore it. */
	readonly textSearchConfig?: string;
	/** Postgres's `CREATE EXTENSION vector`; other stores may ignore it. */
	readonly createExtension?: boolean;
	/** Report what would change without changing anything. */
	readonly dryRun?: boolean;
	readonly signal?: AbortSignal;
}

export interface MemoryStoreV1EmbedderInput {
	readonly embedder: Embedder;
}

/**
 * A storage backend for Mnemocyte, version 1 of the contract. Pass one to
 * `createMemory` through `defineMemoryStore({ store })`, and run the suite
 * from `mnemocyte/store/test` against it.
 *
 * The core validates every input before a store sees it and embeds outside
 * any store call. Of the results, it checks what it can match against the
 * input (the rows `insert` returns, the `target` and `mode` tags, duplicate
 * pages) and trusts the rest, such as which memories `get` and `list`
 * return, to the store. A store keeps rows and answers the queries below;
 * scoring, fusion, context and the public client's checks stay in the core.
 *
 * Every method takes one input object. Every method that reads or writes
 * memories takes a scope: a {@link MemoryStoreV1Visibility} for reads and
 * writes by id, a {@link MemoryStoreV1Selector} for bulk operations.
 * Optional input fields are left out, never set to `undefined`.
 *
 * Deleting a referenced consolidation survivor through a `"memory"` delete
 * or a non-dry-run `"filter"` delete must reject with `"CONFLICT"`
 * (`"HAS_DEPENDENTS"`) before deleting anything. A `"scope"` delete rejects
 * only when a dependent outside the selection remains. The dependency
 * check and mutation must be one atomic operation.
 *
 * Errors are `MnemocyteError`s from `mnemocyte`: `"CONFLICT"` with the
 * reason named on each method, `"ABORTED"` when a signal stops a call, and
 * `"DB"`, with the driver's error as `cause`, for other failures, as the
 * first-party backends throw them.
 *
 * Unless a method documents a stronger boundary, cancellation support and
 * its mechanism are implementation-defined.
 */
export interface MemoryStoreV1 {
	/** The contract version: `"v1"`. */
	readonly specificationVersion: "v1";
	/**
	 * A short name for messages and the CLI, such as `"acme-kv"`. The core
	 * reports the backend as `"custom"`.
	 */
	readonly name: string;
	/** What the backend does differently; see {@link MemoryStoreV1Capabilities}. */
	readonly capabilities: MemoryStoreV1Capabilities;

	/**
	 * Applies the store's pending schema changes, through `migrate()` and the
	 * CLI's `migrate`. The only method allowed to change schema. Optional:
	 * without it the core reports nothing applied, and the CLI says the
	 * store manages its own schema.
	 */
	migrate?(input: MemoryStoreV1MigrateInput): Promise<MigrateResult>;
	/**
	 * Rejects with `"MIGRATION"` or `"CONFIG"` when the embedder does not
	 * match what the store holds (its model or dimensions). Called before
	 * each write and search that embeds, and before duplicate searches.
	 * Optional: without it every embedder is accepted, so a store that
	 * keeps data across processes should implement it.
	 */
	ensureEmbeddingCompatibility?(
		input: MemoryStoreV1EmbedderInput,
	): Promise<void>;

	/**
	 * Inserts fresh rows, or for a row with a `key` already used in its exact
	 * scope, replaces that memory's content fields (keeping its id, creation
	 * time, access counts and consolidation link). Returns one detached record
	 * per input row: the inserted row, or the updated existing row with its
	 * own id. Keys are distinct within the call.
	 *
	 * Order is untrusted: the core matches results to inputs by id, or by
	 * key for keyed rows.
	 *
	 * All or nothing: when any row fails, none is written. A backend may
	 * split the rows into several statements, but they commit together, and
	 * so do their audit events.
	 */
	insert(input: MemoryStoreV1InsertInput): Promise<Memory[]>;
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
	searchCandidates(
		input: MemoryStoreV1SearchInput,
	): Promise<MemoryStoreV1SearchCandidates>;
	/**
	 * The visible memories with these ids, in no particular order, or the
	 * memory with this key in exactly this scope. Ids nobody can see, or that
	 * do not exist, are left out.
	 */
	get(input: MemoryStoreV1GetInput): Promise<Memory[]>;
	/**
	 * Up to `input.limit` memories that pass the filter, newest first by
	 * `(createdAt, id)`, after `input.position` when given.
	 */
	list(input: MemoryStoreV1ListInput): Promise<Memory[]>;
	/**
	 * Applies the patch to the visible memory with this id in one atomic write
	 * and returns it, or `null` when no such memory exists. Sets `updatedAt`.
	 * Rejects with `"CONFLICT"` (`"KEY_IN_USE"`) when the new key is already
	 * used in the memory's scope. The audit event, when requested, is written
	 * in the same atomic write.
	 */
	update(input: MemoryStoreV1UpdateInput): Promise<Memory | null>;
	/**
	 * Increments `accessCount` and sets `lastAccessedAt` once for each
	 * requested memory that is still visible; others are skipped. Never changes
	 * `updatedAt`.
	 */
	markAccessed(input: MemoryStoreV1MarkAccessedInput): Promise<void>;
	/**
	 * Deletes, atomically, and returns a result tagged with `input.target`:
	 *
	 * - `"memory"`: the visible memory with this id, or `found: false` when
	 *   there is none. Its dependents (memories whose `supersededBy` points
	 *   at it) follow `dependents`: `"reject"` throws `"CONFLICT"`
	 *   (`"HAS_DEPENDENTS"`) when there is any; `"restore"` clears their
	 *   `supersededBy` and `supersededAt`; `"delete"` deletes them and,
	 *   transitively, their own dependents. With `"restore"` a direct
	 *   dependent, and with `"delete"` any deleted one, that is not visible
	 *   throws `"CONFLICT"` (`"HIDDEN_DEPENDENTS"`). Nothing changes on a
	 *   conflict.
	 * - `"scope"`: every selected memory and the selected audit events, with
	 *   the number of memories deleted. Rejects with `"CONFLICT"` and deletes
	 *   nothing when a memory outside the selection references a selected one
	 *   through `supersededBy`.
	 * - `"filter"`: the matching memories, or only their count on a dry run.
	 *
	 * Audit events, when requested, are written atomically with the delete.
	 */
	delete(input: MemoryStoreV1DeleteInput): Promise<MemoryStoreV1DeleteResult>;
	/**
	 * Applies one atomic consolidation after re-reading and protecting the
	 * survivor and requested losers. Throws `"CONFLICT"`
	 * (`"CONSOLIDATION_CHANGED"`) before mutation when the survivor is
	 * missing or superseded, or when any requested loser points to a
	 * different survivor. Tag merging starts from the protected survivor's
	 * mutation-time tags.
	 */
	consolidate(
		input: MemoryStoreV1ConsolidateInput,
	): Promise<MemoryStoreV1ConsolidateResult>;
	/**
	 * Pairs of visible memories meeting the similarity threshold where one is
	 * among the other's `neighbors` nearest (approximate on an index),
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
	findDuplicates(
		input: MemoryStoreV1DuplicateInput,
	): Promise<MemoryStoreV1DuplicateResult>;

	/**
	 * Selected events in strict descending `(timestamp, id)` order, up to the
	 * limit, each with its position. `before` / `after` are strict timestamp
	 * filters; `position` is a strict tuple filter on `(timestamp, id)` at
	 * the store's full timestamp precision.
	 */
	listAudit(
		input: MemoryStoreV1AuditLogInput,
	): Promise<MemoryStoreV1AuditLogEntry[]>;
	/**
	 * Deletes the selected events strictly before `before`, at most
	 * `batchSize` per statement, or counts them on a dry run. Batches commit
	 * one by one; the signal is checked before each, so an abort keeps the
	 * batches already deleted.
	 */
	pruneAudit(input: MemoryStoreV1AuditPruneInput): Promise<PruneAuditLogResult>;

	/**
	 * Counts of the selected memories evaluated against `now`. Active memories
	 * are neither expired nor superseded; expired and superseded counts may
	 * overlap. `entityCount` counts distinct `(namespace, entityId)` pairs.
	 */
	stats(input: MemoryStoreV1StatsInput): Promise<MemoryStats>;
}
