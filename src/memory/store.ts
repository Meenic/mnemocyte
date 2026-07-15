import type {
	AuditEvent,
	Embedder,
	EntityStats,
	FindDuplicatesInput,
	GlobalStats,
	ListAuditLogInput,
	Memory,
	MnemocyteBackend,
	PruneInput,
	PruneResult,
	RecallInput,
} from "../types.js";
import type { StoredMemory } from "./shared.js";

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
	prune(input: PruneInput): Promise<PruneResult>;
	findDuplicatePairs(input: FindDuplicatesInput): Promise<StoreDuplicatePair[]>;

	addAuditEvents(events: readonly AuditEvent[]): Promise<void>;
	listAuditLog(input: ListAuditLogInput): Promise<AuditEvent[]>;

	getMemory(entityId: string, memoryId: string): Promise<Memory | null>;
	loadConsolidationTargets(
		entityId: string,
		ids: readonly string[],
	): Promise<StoreConsolidationTarget[]>;
	consolidate(input: StoreConsolidateInput): Promise<StoreConsolidateResult>;

	stats(
		input: { entityId?: string } | undefined,
		now: Date,
	): Promise<EntityStats | GlobalStats>;
	close(): Promise<void>;
}
