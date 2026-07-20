import { MnemocyteError } from "../errors.js";
import type {
	AuditEvent,
	Embedder,
	EntityStats,
	FindDuplicatesInput,
	GlobalStats,
	ImportanceLevel,
	ListAuditLogInput,
	Memory,
	MemoryType,
	MnemocyteBackend,
	PruneResult,
	RecallInput,
} from "../types.js";
import type { StoredMemory } from "./records.js";

export interface StoreVectorSearchInput extends Omit<RecallInput, "minScore"> {
	embedding: readonly number[];
	limit: number;
	minVectorScore?: number;
}

export interface StoreLexicalSearchInput extends RecallInput {
	limit: number;
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

export interface StoreDuplicatePair {
	a: Memory;
	b: Memory;
	similarity: number;
}

export interface StoreAccessUpdate {
	id: string;
	lastAccessedAt: Date;
	accessCount: number;
	updatedAt: Date;
}

export interface StorePruneEntityDeletion {
	entityId: string;
	deletedCount: number;
}

export interface StorePruneResult extends PruneResult {
	deletedByEntity: readonly StorePruneEntityDeletion[];
}

export interface StoreConsolidationTarget {
	id: string;
	tags: readonly string[];
	supersededBy: string | null;
}

export interface StoreConsolidateInput {
	entityId: string;
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

export interface ValidatedPruneFilter {
	readonly entityId?: string;
	readonly expired?: true;
	readonly superseded?: true;
	readonly createdBefore?: Date;
	readonly notAccessedSince?: Date;
	readonly types?: readonly MemoryType[];
	readonly tags?: readonly string[];
	readonly maxImportance?: ImportanceLevel;
	readonly dryRun: boolean;
}

export function hasPruneSelector(filter: ValidatedPruneFilter): boolean {
	return (
		filter.entityId !== undefined ||
		filter.expired === true ||
		filter.superseded === true ||
		filter.createdBefore !== undefined ||
		filter.notAccessedSince !== undefined ||
		(filter.types !== undefined && filter.types.length > 0) ||
		(filter.tags !== undefined && filter.tags.length > 0) ||
		filter.maxImportance !== undefined
	);
}

export function assertPruneFilterHasSelector(
	filter: ValidatedPruneFilter,
): void {
	if (!hasPruneSelector(filter)) {
		throw new MnemocyteError(
			"prune requires at least one selector (entityId, expired, superseded, createdBefore, notAccessedSince, types, tags, or maxImportance).",
			"VALIDATION",
		);
	}
}

/**
 * Internal storage adapter boundary used by the shared client orchestration.
 *
 * This is intentionally not exported from the public package root in 0.3.x.
 * The public adapter surface is reserved for the later `drizzleStore(db)` line.
 *
 * Every method is unconditional. There is intentionally no capability-flag
 * surface, and adapters do not declare capabilities before shared orchestration
 * calls a method.
 *
 * Deleting a referenced consolidation survivor through `deleteMemory`,
 * `deleteMemoriesForEntity`, or a non-dry-run `prune` must reject with
 * `"CONFLICT"` before deleting anything. The dependency check and mutation must
 * be one atomic, non-interleavable operation; a check followed by a later write
 * with an interleaving gap does not satisfy the contract.
 *
 * Unless a method documents a stronger boundary, cancellation support and its
 * mechanism are implementation-defined. Adapters may use cooperative checks,
 * active statement cancellation, or no mid-operation cancellation while still
 * honoring the method's documented postconditions.
 */
export interface MemoryStore {
	readonly backend: MnemocyteBackend;

	/**
	 * Completes the adapter's base-schema readiness hook.
	 *
	 * The built-in stores currently resolve without work and rely on explicit
	 * schema management. An implementation may verify externally managed schema
	 * state here, but this hook does not authorize hidden schema creation or
	 * migration.
	 */
	ensureSchema(): Promise<void>;
	/**
	 * Enforces the embedding compatibility check meaningful to this store's
	 * persistence model before embedding-dependent work proceeds.
	 *
	 * The hook is unconditional and needs no capability flag. A store with no
	 * persistent installation state may legitimately resolve without work. The
	 * built-in Postgres store validates installation model and dimensions and may
	 * reject with `"MIGRATION"` or `"CONFIG"`; the in-memory store is a no-op.
	 */
	ensureEmbeddingCompatibility(embedder: Embedder): Promise<void>;

	/**
	 * Takes ownership of freshly prepared rows and returns exactly one detached
	 * public record for every prepared input ID. Callers must not mutate or reuse
	 * rows after passing them here.
	 *
	 * The store has no return-order obligation. Shared orchestration treats order
	 * as untrusted, rejects missing or duplicate results and any returned ID
	 * outside the prepared set, then restores prepared-input order.
	 */
	insertMemories(memories: readonly StoredMemory[]): Promise<Memory[]>;
	/**
	 * Returns up to `input.limit` detached candidates that satisfy the shared
	 * recall filters and `minVectorScore`, ordered by decreasing vector
	 * similarity. Every `vectorScore` is finite and clamped to `[0, 1]`.
	 *
	 * An implementation may scan or use an index. When an approximate index is
	 * available, candidate inclusion, ranking, and performance are index- and
	 * planner-dependent and are not guaranteed to match an exhaustive scan.
	 */
	vectorSearch(input: StoreVectorSearchInput): Promise<StoreVectorCandidate[]>;
	/**
	 * Returns up to `input.limit` detached candidates that satisfy the shared
	 * recall filters and have a positive implementation-defined lexical score,
	 * ordered by decreasing score.
	 *
	 * Lexical parsing and relevance scoring are backend-defined. Implementations
	 * may therefore differ in mechanism, returned candidates, and ranking, not
	 * only in latency.
	 */
	lexicalSearch(
		input: StoreLexicalSearchInput,
	): Promise<StoreLexicalCandidate[]>;
	/**
	 * Returns available embeddings for the requested IDs, keyed by memory ID.
	 * Missing memories and memories without an embedding are omitted. Returned
	 * vectors are detached from stored state, and input or map iteration order is
	 * not part of the contract.
	 */
	getMemoryEmbeddings(
		memoryIds: readonly string[],
	): Promise<Map<string, number[]>>;
	/**
	 * Increments access state exactly once for each requested stored memory and
	 * returns one record per ID containing its post-update `accessCount`,
	 * `lastAccessedAt`, and `updatedAt`. Return order is untrusted and normalized
	 * by shared orchestration.
	 *
	 * The input IDs must be distinct. Duplicate-ID behavior is backend-specific,
	 * and callers must not rely on any particular deduplication or increment
	 * behavior when this precondition is violated.
	 */
	markMemoriesAccessed(
		memoryIds: readonly string[],
	): Promise<StoreAccessUpdate[]>;

	/**
	 * Deletes the memory only when both entity and memory ID match, returning
	 * `false` when they do not and `true` after deletion.
	 *
	 * If any memory references the target through `supersededBy`, rejects with
	 * `"CONFLICT"` without deleting it. Dependency detection and deletion must be
	 * atomic and non-interleavable.
	 */
	deleteMemory(entityId: string, memoryId: string): Promise<boolean>;
	/**
	 * Deletes every memory for the entity and returns the number deleted.
	 *
	 * If any memory references a selected target through `supersededBy`, rejects
	 * the entire operation with `"CONFLICT"` before deleting anything, including
	 * when the dependent is itself selected. Dependency detection and the batch
	 * deletion must be atomic and non-interleavable.
	 */
	deleteMemoriesForEntity(entityId: string): Promise<number>;
	prune(
		input: ValidatedPruneFilter,
		options?: StoreOperationOptions,
	): Promise<StorePruneResult>;
	/**
	 * Compares qualifying memories pairwise and returns up to the requested limit
	 * of unordered pairs meeting the similarity threshold, ordered by decreasing
	 * similarity. Similarities are clamped to `[0, 1]`; pair orientation and
	 * equal-score order are not guaranteed.
	 *
	 * This contract neither implies nor requires indexed nearest-neighbor pair
	 * generation. A database planner may still use ordinary indexes while
	 * filtering or executing a pairwise join.
	 */
	findDuplicatePairs(
		input: FindDuplicatesInput,
		options?: StoreOperationOptions,
	): Promise<StoreDuplicatePair[]>;

	/**
	 * Persists independent copies of audit events supplied by shared core.
	 *
	 * Ordinary audit writes are best-effort at the shared caller. Rejection does
	 * not promise batch atomicity: failure behavior is implementation-defined,
	 * and some stores may retain a partial batch after the promise rejects.
	 */
	addAuditEvents(events: readonly AuditEvent[]): Promise<void>;
	/**
	 * Returns detached events for the requested entity in strict descending
	 * `(timestamp, id)` order, subject to the requested limit.
	 *
	 * Event IDs must be stable and timestamps comparable. Plain `before` and
	 * `after` values are strict timestamp filters. Composite cursors use strict
	 * tuple filtering on the same `(timestamp, id)` tuple used for ordering, so
	 * equal-timestamp events can be paged without requiring a transaction.
	 * Cancellation may be cooperative or active and is implementation-defined.
	 */
	listAuditLog(
		input: ListAuditLogInput,
		options?: StoreOperationOptions,
	): Promise<AuditEvent[]>;

	/**
	 * Returns a detached memory only when both entity and memory ID match;
	 * otherwise returns `null`.
	 */
	getMemory(
		entityId: string,
		memoryId: string,
		options?: StoreOperationOptions,
	): Promise<Memory | null>;
	/** Shared validation supplies distinct IDs before this preflight lookup. */
	loadConsolidationTargets(
		entityId: string,
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
	 * Returns entity-scoped or global counts evaluated against the supplied
	 * `now`. `memoryCount` includes every selected memory; active memories are
	 * neither expired nor superseded. Expired and superseded counts are
	 * independent and may overlap. Global `entityCount` counts distinct entities
	 * across all stored memories, and an empty scope returns zero counts.
	 */
	stats(
		input: { entityId?: string } | undefined,
		now: Date,
	): Promise<EntityStats | GlobalStats>;
	/**
	 * Releases only resources and transient state owned by this store instance.
	 *
	 * The in-memory store destroys its owned memory and audit state. The built-in
	 * Postgres store closes the connection handle it created while leaving
	 * persisted rows intact. An adapter wrapping a caller-supplied connection must
	 * not close that connection or any other resource it does not own.
	 */
	close(): Promise<void>;
}
