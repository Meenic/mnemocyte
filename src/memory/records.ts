import type { Memory } from "../types.js";

export interface StoredMemory extends Memory {
	embedding: number[];
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
	if (!tags) {
		return [];
	}
	return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function createId(): string {
	return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Generate a unique audit-event id (`evt_*`). */
export function createEventId(): string {
	return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function cloneMemory(memory: Memory): Memory {
	return {
		id: memory.id,
		entityId: memory.entityId,
		content: memory.content,
		type: memory.type,
		importance: memory.importance,
		tags: [...memory.tags],
		source: memory.source,
		metadata: { ...memory.metadata },
		confidence: memory.confidence,
		embeddingModel: memory.embeddingModel,
		embeddingDimensions: memory.embeddingDimensions,
		supersededBy: memory.supersededBy,
		supersededAt: memory.supersededAt ? new Date(memory.supersededAt) : null,
		expiresAt: memory.expiresAt ? new Date(memory.expiresAt) : null,
		lastAccessedAt: memory.lastAccessedAt
			? new Date(memory.lastAccessedAt)
			: null,
		accessCount: memory.accessCount,
		createdAt: new Date(memory.createdAt),
		updatedAt: new Date(memory.updatedAt),
	};
}
