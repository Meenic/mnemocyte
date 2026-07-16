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

export interface StoreVectorSearchInput extends RecallInput {
	embedding: readonly number[];
	limit: number;
	minScore?: number;
}

export interface StoreLexicalSearchInput extends RecallInput {
	limit: number;
}

export interface StoreVectorCandidate {
	memory: Memory;
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

	insertMemories(memories: readonly StoredMemory[]): Promise<Memory[]>;
	vectorSearch(input: StoreVectorSearchInput): Promise<StoreVectorCandidate[]>;
	lexicalSearch(
		input: StoreLexicalSearchInput,
	): Promise<StoreLexicalCandidate[]>;
	getMemoryEmbeddings(
		memoryIds: readonly string[],
	): Promise<Map<string, number[]>>;
	markMemoriesAccessed(memoryIds: readonly string[]): Promise<void>;

	deleteMemory(entityId: string, memoryId: string): Promise<boolean>;
	deleteMemoriesForEntity(entityId: string): Promise<number>;
	prune(
		input: ValidatedPruneFilter,
		options?: StoreOperationOptions,
	): Promise<PruneResult>;
	findDuplicatePairs(
		input: FindDuplicatesInput,
		options?: StoreOperationOptions,
	): Promise<StoreDuplicatePair[]>;

	addAuditEvents(events: readonly AuditEvent[]): Promise<void>;
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
