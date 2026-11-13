import { MnemocyteError } from "../errors.js";
import type {
	AuditEvent,
	AuditLogCursor,
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

/** A selector for one entity, as `deleteScope` and audit listings take. */
export interface StoreEntitySelector extends StoreSelector {
	readonly namespace: string;
	readonly entityId: string;
}

export interface StoreMemoryFilter {
	readonly visibility: StoreVisibility;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly before?: Date;
	readonly after?: Date;
	readonly includeSuperseded?: boolean;
	readonly includeExpired?: boolean;
}

export interface StoreVectorSearchInput extends StoreMemoryFilter {
	readonly embedding: readonly number[];
	readonly limit: number;
	readonly minVectorScore?: number;
}

export interface StoreLexicalSearchInput extends StoreMemoryFilter {
	readonly query: string;
	readonly limit: number;
}

/** Position of the last row of a `list` page. */
export interface StoreListPosition {
	readonly createdAt: Date;
	readonly id: string;
}

export interface StoreListInput extends StoreMemoryFilter {
	readonly limit: number;
	/** Return rows strictly after this position in `(createdAt, id)` descending order. */
	readonly position?: StoreListPosition;
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

export interface StoreDuplicateInput {
	readonly visibility: StoreVisibility;
	readonly threshold: number;
	readonly limit: number;
	/** Nearest neighbors compared per memory. */
	readonly neighbors: number;
	readonly kinds?: readonly MemoryKind[];
	readonly tags?: readonly string[];
	readonly includeSuperseded?: boolean;
	readonly includeExpired?: boolean;
}

export interface StoreDuplicatePair {
	a: Memory;
	b: Memory;
	similarity: number;
}

export interface StoreAuditLogInput {
	readonly selector: StoreEntitySelector;
	readonly limit: number;
	readonly before?: Date;
	readonly after?: Date;
	readonly beforeCursor?: AuditLogCursor;
	readonly afterCursor?: AuditLogCursor;
}

export interface StoreDeleteInput {
	readonly visibility: StoreVisibility;
	readonly memoryId: string;
	readonly dependents: DependentsPolicy;
	/** `updatedAt` of restored dependents and the audit events' timestamp. */
	readonly now: Date;
	/** Records one `memory.deleted` per deleted memory in the same write. */
	readonly audit: boolean;
}

export interface StoreDeleteResult {
	/** The memory, then the dependents deleted with it (`"delete"`). */
	readonly deletedIds: readonly string[];
	/** Dependents made active again (`"restore"`). */
	readonly restoredIds: readonly string[];
}

export interface StoreConsolidationTarget {
	id: string;
	tags: readonly string[];
	supersededBy: string | null;
}

export interface StoreConsolidateInput {
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

export interface StoreOperationOptions {
	signal?: AbortSignal;
}

export interface StoreInsertOptions extends StoreOperationOptions {
	/**
	 * Records `memory.created` or `memory.updated` per row in the same write,
	 * timestamped with the row's `updatedAt`.
	 */
	audit?: boolean;
}

export interface StorePruneInput extends ValidatedPruneFilter {
	/** Expiry reference and the audit events' timestamp. */
	readonly now: Date;
	/** Records one `memory.pruned` per affected entity in the same write. */
	readonly audit: boolean;
}

/** Audit events a `pruneAuditLog` deletes, already validated. */
export interface StoreAuditPruneInput {
	readonly selector: StoreSelector;
	/** Events strictly before this time are selected. */
	readonly before: Date;
	/** Most events one statement deletes. */
	readonly batchSize: number;
	readonly dryRun: boolean;
}

export interface StoreMigrateInput {
	readonly dimensions?: number;
	readonly createExtension?: boolean;
	readonly dryRun?: boolean;
	readonly signal?: AbortSignal;
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
		throw new MnemocyteError(
			"prune requires at least one selector besides its scope (expired, superseded, createdBefore, notAccessedSince, kinds, tags, or maxImportance). Use deleteScope to delete a whole scope.",
			"VALIDATION",
		);
	}
}

/**
 * Internal storage adapter boundary used by the shared client orchestration.
 * Not exported from the package.
 *
 * Every method that reads or writes memories takes a scope: a
 * {@link StoreVisibility} for reads and writes by id, a {@link StoreSelector}
 * for bulk operations.
 *
 * Deleting a referenced consolidation survivor through `deleteMemory` or a
 * non-dry-run `prune` must reject with `"CONFLICT"` before deleting anything.
 * `deleteScope` rejects only when a dependent outside the selection remains.
 * The dependency check and mutation must be one atomic operation.
 *
 * Unless a method documents a stronger boundary, cancellation support and its
 * mechanism are implementation-defined.
 */
export interface MemoryStore {
	readonly backend: MnemocyteBackend;

	/**
	 * Applies the store's pending schema migrations. This is the only method
	 * that changes schema, and it runs only when the caller asks for it through
	 * `migrate()`. A store without persistent schema resolves with nothing
	 * applied.
	 */
	migrate(input: StoreMigrateInput): Promise<MigrateResult>;
	/**
	 * Rejects with `"MIGRATION"` or `"CONFIG"` when the embedder does not match
	 * the installation. A store without persistent installation state resolves
	 * without work.
	 */
	ensureEmbeddingCompatibility(embedder: Embedder): Promise<void>;

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
	insertMemories(
		memories: readonly StoredMemory[],
		options?: StoreInsertOptions,
	): Promise<Memory[]>;
	/**
	 * Up to `input.limit` candidates that pass the filter and
	 * `minVectorScore`, by decreasing vector similarity. Every `vectorScore`
	 * is finite and clamped to `[0, 1]`. With an approximate index, inclusion
	 * and order may differ from an exhaustive scan.
	 */
	vectorSearch(input: StoreVectorSearchInput): Promise<StoreVectorCandidate[]>;
	/**
	 * Up to `input.limit` candidates that pass the filter and have a positive,
	 * backend-defined lexical score, by decreasing score.
	 */
	lexicalSearch(
		input: StoreLexicalSearchInput,
	): Promise<StoreLexicalCandidate[]>;
	/**
	 * Up to `input.limit` memories that pass the filter, newest first by
	 * `(createdAt, id)`, after `input.position` when given.
	 */
	listMemories(
		input: StoreListInput,
		options?: StoreOperationOptions,
	): Promise<Memory[]>;
	/**
	 * Increments `accessCount` and sets `lastAccessedAt` once for each
	 * requested memory that is still visible; others are skipped. Never changes
	 * `updatedAt`. The ids must be distinct.
	 */
	markMemoriesAccessed(
		visibility: StoreVisibility,
		memoryIds: readonly string[],
	): Promise<void>;

	/** The visible memory with this id, or `null`. */
	getMemory(
		visibility: StoreVisibility,
		memoryId: string,
		options?: StoreOperationOptions,
	): Promise<Memory | null>;
	/** The memory with this key in exactly this scope, or `null`. */
	getMemoryByKey(
		scope: StoreScope,
		key: string,
		options?: StoreOperationOptions,
	): Promise<Memory | null>;
	/**
	 * Applies the patch to the visible memory with this id in one atomic write
	 * and returns it, or `null` when no such memory exists. Sets `updatedAt`.
	 * Rejects with `"CONFLICT"` when the new key is already used in the
	 * memory's scope. The audit event, when requested, is written in the
	 * same atomic write.
	 */
	updateMemory(input: StoreUpdateInput): Promise<Memory | null>;
	/**
	 * Deletes the visible memory with this id in one atomic write, or returns
	 * `null` when there is none. Its dependents (memories whose
	 * `supersededBy` points at it) follow `dependents`: `"reject"` throws
	 * `"CONFLICT"` when there is any; `"restore"` clears their
	 * `supersededBy` and `supersededAt`; `"delete"` deletes them and,
	 * transitively, their own dependents. With `"restore"` a direct
	 * dependent, and with `"delete"` any deleted one, that is not visible
	 * throws `"CONFLICT"`. Nothing changes on a conflict. Audit events, when
	 * requested, are written atomically with the delete.
	 */
	deleteMemory(
		input: StoreDeleteInput,
		options?: StoreOperationOptions,
	): Promise<StoreDeleteResult | null>;
	/**
	 * Deletes every selected memory and the selected audit events, atomically,
	 * and returns the number of memories deleted. Rejects with `"CONFLICT"`
	 * and deletes nothing when a memory outside the selection references a
	 * selected one through `supersededBy`.
	 */
	deleteScope(
		selector: StoreEntitySelector,
		options?: StoreOperationOptions,
	): Promise<number>;
	/**
	 * Deletes the matching memories, or counts them on a dry run. Audit
	 * events, when requested, are written atomically with the delete.
	 */
	prune(
		input: StorePruneInput,
		options?: StoreOperationOptions,
	): Promise<PruneResult>;
	/**
	 * Unordered pairs of visible memories meeting the similarity threshold
	 * where one is among the other's `neighbors` nearest (approximate on an
	 * HNSW index), by decreasing similarity, then `a.id`, then `b.id`, up to
	 * the limit. `a.id` is the smaller id. Similarities are clamped to
	 * `[0, 1]`.
	 */
	findDuplicatePairs(
		input: StoreDuplicateInput,
		options?: StoreOperationOptions,
	): Promise<StoreDuplicatePair[]>;

	/**
	 * Selected events in strict descending `(timestamp, id)` order, up to the
	 * limit. `before` / `after` are strict timestamp filters; the cursors are
	 * strict tuple filters on `(timestamp, id)`.
	 */
	listAuditLog(
		input: StoreAuditLogInput,
		options?: StoreOperationOptions,
	): Promise<AuditEvent[]>;
	/**
	 * Deletes the selected events strictly before `before`, at most
	 * `batchSize` per statement, or counts them on a dry run. Batches commit
	 * one by one; the signal is checked before each, so an abort keeps the
	 * batches already deleted.
	 */
	pruneAuditLog(
		input: StoreAuditPruneInput,
		options?: StoreOperationOptions,
	): Promise<PruneAuditLogResult>;

	/** Shared validation supplies distinct IDs before this preflight lookup. */
	loadConsolidationTargets(
		visibility: StoreVisibility,
		ids: readonly string[],
		options?: StoreOperationOptions,
	): Promise<StoreConsolidationTarget[]>;
	/**
	 * Applies one atomic consolidation after re-reading and protecting the
	 * survivor and requested losers. Throws `"CONFLICT"` before mutation when
	 * the survivor is missing or superseded, or when any requested loser points
	 * to a different survivor. Tag merging starts from the protected survivor's
	 * mutation-time tags.
	 */
	consolidate(
		input: StoreConsolidateInput,
		options?: StoreOperationOptions,
	): Promise<StoreConsolidateResult>;

	/**
	 * Counts of the selected memories evaluated against `now`. Active memories
	 * are neither expired nor superseded; expired and superseded counts may
	 * overlap. `entityCount` counts distinct `(namespace, entityId)` pairs.
	 */
	stats(selector: StoreSelector, now: Date): Promise<MemoryStats>;
}
