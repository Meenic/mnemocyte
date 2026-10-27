import type { Memory } from "../types.js";
import { cloneJsonObject } from "./json.js";

export interface StoredMemory extends Memory {
	embedding: number[];
}

export function normalizeTags(tags: readonly string[] | undefined): string[] {
	if (!tags) {
		return [];
	}
	return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a UUID in its canonical hyphenated form. */
export function isUuid(value: string): boolean {
	return UUID_PATTERN.test(value);
}

/**
 * A UUIDv7 (RFC 9562): 48 bits of Unix milliseconds, then random bits, so ids
 * sort roughly by creation time and btree inserts stay near the right edge.
 * Generated here because Postgres only has `uuidv7()` from version 18.
 */
export function createUuidV7(now: number = Date.now()): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const high = Math.floor(now / 2 ** 16);
	const low = now % 2 ** 16;
	bytes[0] = (high >>> 24) & 0xff;
	bytes[1] = (high >>> 16) & 0xff;
	bytes[2] = (high >>> 8) & 0xff;
	bytes[3] = high & 0xff;
	bytes[4] = (low >>> 8) & 0xff;
	bytes[5] = low & 0xff;
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Generate a unique memory id (a UUIDv7). */
export function createId(): string {
	return createUuidV7();
}

/** Generate a unique audit-event id (a UUIDv7). */
export function createEventId(): string {
	return createUuidV7();
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
		metadata: cloneJsonObject(memory.metadata),
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
