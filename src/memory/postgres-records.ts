import type { MemoryRow } from "../db/rows.js";
import type { ImportanceLevel, Memory, MemoryType } from "../types.js";
import { cloneJsonObject } from "./json.js";

export function rowToMemory(row: MemoryRow): Memory {
	return {
		id: row.id,
		entityId: row.entityId,
		content: row.content,
		type: row.type as MemoryType,
		importance: row.importance as ImportanceLevel,
		tags: row.tags,
		source: row.source,
		metadata: cloneJsonObject(row.metadata),
		confidence: row.confidence,
		embeddingModel: row.embeddingModel,
		embeddingDimensions: row.embeddingDimensions,
		supersededBy: row.supersededBy,
		supersededAt: row.supersededAt,
		expiresAt: row.expiresAt,
		lastAccessedAt: row.lastAccessedAt,
		accessCount: row.accessCount,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
