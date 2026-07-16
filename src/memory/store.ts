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

export interface StoreConsolidationTarget {
	id: string;
	tags: readonly string[];
	supersededBy: string | null;
}

export interface StoreConsolidateInput {
	entityId: string;
	survivorId: string;
	survivorTags: readonly string[];
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
 */
export interface MemoryStore {
	readonly backend: MnemocyteBackend;

	ensureSchema(): Promise<void>;
	ensureEmbeddingCompatibility(embedder: Embedder): Promise<void>;

	/**
	 * Takes ownership of freshly prepared rows and returns exactly one detached
	 * public record for every input ID. Return order is not trusted; shared
	 * orchestration validates the ID set and restores input order. Missing,
	 * duplicate, or unknown returned IDs are storage-contract violations.
	 * Callers must not mutate or reuse rows after passing them here.
	 */
	insertMemories(memories: readonly StoredMemory[]): Promise<Memory[]>;
	vectorSearch(input: StoreVectorSearchInput): Promise<StoreVectorCandidate[]>;
	lexicalSearch(
		input: StoreLexicalSearchInput,
	): Promise<StoreLexicalCandidate[]>;
	getMemoryEmbeddings(
		memoryIds: readonly string[],
	): Promise<Map<string, number[]>>;
	/**
	 * Returns exactly one post-update access record for every input ID. Return
	 * order is not trusted and is normalized by shared orchestration.
	 */
	markMemoriesAccessed(
		memoryIds: readonly string[],
	): Promise<StoreAccessUpdate[]>;

	/** Throws `"CONFLICT"` when the selected memory has dependents. */
	deleteMemory(entityId: string, memoryId: string): Promise<boolean>;
	/** Throws `"CONFLICT"` before deleting when any selected memory has dependents. */
	deleteMemoriesForEntity(entityId: string): Promise<number>;
	prune(
		input: ValidatedPruneFilter,
		options?: StoreOperationOptions,
	): Promise<PruneResult>;
	findDuplicatePairs(
		input: FindDuplicatesInput,
		options?: StoreOperationOptions,
	): Promise<StoreDuplicatePair[]>;

	/** Persists independent copies of audit events supplied by shared core. */
	addAuditEvents(events: readonly AuditEvent[]): Promise<void>;
	/** Returns detached audit events safe to expose through the public client. */
	listAuditLog(
		input: ListAuditLogInput,
		options?: StoreOperationOptions,
	): Promise<AuditEvent[]>;

	getMemory(
		entityId: string,
		memoryId: string,
		options?: StoreOperationOptions,
	): Promise<Memory | null>;
	loadConsolidationTargets(
		entityId: string,
		ids: readonly string[],
		options?: StoreOperationOptions,
	): Promise<StoreConsolidationTarget[]>;
	consolidate(
		input: StoreConsolidateInput,
		options?: StoreOperationOptions,
	): Promise<StoreConsolidateResult>;

	stats(
		input: { entityId?: string } | undefined,
		now: Date,
	): Promise<EntityStats | GlobalStats>;
	close(): Promise<void>;
}
