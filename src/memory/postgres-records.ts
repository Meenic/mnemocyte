import type { EventRow, MemoryRow } from "../db/rows.js";
import type {
	AuditEvent,
	ImportanceLevel,
	Memory,
	MemoryKind,
} from "../types.js";
import { cloneJsonObject } from "./json.js";

export function rowToMemory(row: MemoryRow): Memory {
	return {
		id: row.id,
		scope: {
			namespace: row.namespace,
			entityId: row.entityId,
			agentId: row.agentId,
			sessionId: row.sessionId,
		},
		key: row.key,
		content: row.content,
		// `kind` and `importance` are plain text columns; only validated values
		// are written to them.
		kind: row.kind as MemoryKind,
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

export function rowToAuditEvent(row: EventRow): AuditEvent {
	return {
		id: row.id,
		scope: {
			namespace: row.namespace,
			entityId: row.entityId,
			agentId: row.agentId,
			sessionId: row.sessionId,
		},
		description: row.description,
		metadata: cloneJsonObject(row.metadata),
		timestamp: row.timestamp,
	};
}
