import type { MemoryRow } from "../db/schema.js";
import type { ImportanceLevel, Memory, MemoryType } from "../types.js";

type MemoryRowTimestamp = Date | string;

type MemoryLikeRow = Omit<
	MemoryRow,
	| "embedding"
	| "supersededAt"
	| "expiresAt"
	| "lastAccessedAt"
	| "createdAt"
	| "updatedAt"
> & {
	supersededAt: MemoryRowTimestamp | null;
	expiresAt: MemoryRowTimestamp | null;
	lastAccessedAt: MemoryRowTimestamp | null;
	createdAt: MemoryRowTimestamp;
	updatedAt: MemoryRowTimestamp;
};

function toDate(value: MemoryRowTimestamp): Date {
	return value instanceof Date ? value : new Date(value);
}

function toNullableDate(value: MemoryRowTimestamp | null): Date | null {
	return value === null ? null : toDate(value);
}

export function rowToMemory(row: MemoryLikeRow): Memory {
	return {
		id: row.id,
		entityId: row.entityId,
		content: row.content,
		type: row.type as MemoryType,
		importance: row.importance as ImportanceLevel,
		tags: row.tags,
		source: row.source,
		metadata: row.metadata as Record<string, unknown>,
		confidence: row.confidence,
		embeddingModel: row.embeddingModel,
		embeddingDimensions: row.embeddingDimensions,
		supersededBy: row.supersededBy,
		supersededAt: toNullableDate(row.supersededAt),
		expiresAt: toNullableDate(row.expiresAt),
		lastAccessedAt: toNullableDate(row.lastAccessedAt),
		accessCount: row.accessCount,
		createdAt: toDate(row.createdAt),
		updatedAt: toDate(row.updatedAt),
	};
}
