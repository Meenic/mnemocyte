import type { MemoryRow } from "../db/schema.js";
import { MnemocyteError } from "../errors.js";
import type {
	Embedder,
	ImportanceLevel,
	Memory,
	MemoryType,
	RecallInput,
	RememberInput,
} from "../types.js";

export const DEFAULT_LIMIT = 10;
export const DEFAULT_MIN_SCORE = 0;
export const DEFAULT_TYPE: MemoryType = "fact";
export const DEFAULT_IMPORTANCE: ImportanceLevel = "normal";

export interface StoredMemory extends Memory {
	embedding: number[];
}

export function assertNonEmptyString(value: string, field: string): void {
	if (value.trim().length === 0) {
		throw new MnemocyteError(
			`${field} must be a non-empty string.`,
			"VALIDATION",
		);
	}
}

export function assertLimit(value: number): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new MnemocyteError("limit must be a positive integer.", "VALIDATION");
	}
}

export function assertMinScore(value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new MnemocyteError(
			"minScore must be a number between 0 and 1.",
			"VALIDATION",
		);
	}
}

export function assertEmbedder(embedder: Embedder): void {
	if (!embedder || typeof embedder.embed !== "function") {
		throw new MnemocyteError(
			"embedder with an embed function is required.",
			"CONFIG",
		);
	}
	assertNonEmptyString(embedder.model, "embedder.model");
	if (!Number.isInteger(embedder.dimensions) || embedder.dimensions < 1) {
		throw new MnemocyteError(
			"embedder.dimensions must be a positive integer.",
			"CONFIG",
		);
	}
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

export function isExpired(memory: Memory, now: Date): boolean {
	return (
		memory.expiresAt !== null && memory.expiresAt.getTime() <= now.getTime()
	);
}

export function cloneMemory(memory: Memory): Memory {
	return {
		...memory,
		tags: [...memory.tags],
		metadata: { ...memory.metadata },
		expiresAt: memory.expiresAt ? new Date(memory.expiresAt) : null,
		lastAccessedAt: memory.lastAccessedAt
			? new Date(memory.lastAccessedAt)
			: null,
		createdAt: new Date(memory.createdAt),
		updatedAt: new Date(memory.updatedAt),
	};
}

export function rowToMemory(row: MemoryRow): Memory {
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
		expiresAt: row.expiresAt,
		lastAccessedAt: row.lastAccessedAt,
		accessCount: row.accessCount,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export async function embedOne(
	embedder: Embedder,
	text: string,
): Promise<number[]> {
	let embeddings: number[][];
	try {
		embeddings = await embedder.embed([text]);
	} catch (error) {
		throw new MnemocyteError("Failed to embed text.", "EMBEDDING", error);
	}
	const embedding = embeddings[0];
	if (!embedding) {
		throw new MnemocyteError("Embedder returned no embedding.", "EMBEDDING");
	}
	if (embedding.length !== embedder.dimensions) {
		throw new MnemocyteError(
			"Embedder returned an embedding with unexpected dimensions.",
			"EMBEDDING",
		);
	}
	return embedding;
}

export function validateRememberInput(input: RememberInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	assertNonEmptyString(input.content, "content");
	if (
		input.confidence !== undefined &&
		(!Number.isFinite(input.confidence) ||
			input.confidence < 0 ||
			input.confidence > 1)
	) {
		throw new MnemocyteError(
			"confidence must be a number between 0 and 1.",
			"VALIDATION",
		);
	}
}

export function validateRecallInput(input: RecallInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	assertNonEmptyString(input.query, "query");
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
	if (input.minScore !== undefined) {
		assertMinScore(input.minScore);
	}
}

export function matchesRecallFilter(
	memory: Memory,
	input: RecallInput,
	now: Date,
): boolean {
	if (memory.entityId !== input.entityId) {
		return false;
	}
	if (!input.includeSuperseded && memory.supersededBy !== null) {
		return false;
	}
	if (!input.includeExpired && isExpired(memory, now)) {
		return false;
	}
	if (input.types && !input.types.includes(memory.type)) {
		return false;
	}
	if (input.tags && !input.tags.every((tag) => memory.tags.includes(tag))) {
		return false;
	}
	if (input.before && memory.createdAt >= input.before) {
		return false;
	}
	if (input.after && memory.createdAt <= input.after) {
		return false;
	}
	return true;
}
