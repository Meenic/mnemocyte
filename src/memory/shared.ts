import type { MemoryRow } from "../db/schema.js";
import { MnemocyteError } from "../errors.js";
import { withResilience } from "../resilience.js";
import type {
	BuildContextInput,
	ConsolidateInput,
	Embedder,
	FindDuplicatesInput,
	ImportanceLevel,
	ListAuditLogInput,
	Memory,
	MemoryType,
	ProviderResilienceConfig,
	PruneInput,
	RecallInput,
	RememberInput,
} from "../types.js";

export const DEFAULT_LIMIT = 10;
export const DEFAULT_MIN_SCORE = 0;
export const DEFAULT_TYPE: MemoryType = "fact";
export const DEFAULT_IMPORTANCE: ImportanceLevel = "normal";

/**
 * Ordering of {@link ImportanceLevel} from least to most important. Used
 * by `prune({ maxImportance })` to compare a memory's importance against
 * the caller-supplied ceiling.
 */
export const IMPORTANCE_RANK: Record<ImportanceLevel, number> = {
	low: 0,
	normal: 1,
	high: 2,
	critical: 3,
};

export interface StoredMemory extends Memory {
	embedding: number[];
}

export function assertNonEmptyString(
	value: unknown,
	field: string,
	code: "CONFIG" | "VALIDATION" = "VALIDATION",
): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new MnemocyteError(`${field} must be a non-empty string.`, code);
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
	assertNonEmptyString(embedder.model, "embedder.model", "CONFIG");
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

/** Generate a unique audit-event id (`evt_*`). */
export function createEventId(): string {
	return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isExpired(memory: Memory, now: Date): boolean {
	return (
		memory.expiresAt !== null && memory.expiresAt.getTime() <= now.getTime()
	);
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

function validateEmbedding(
	embedding: readonly number[],
	dimensions: number,
): void {
	if (embedding.length !== dimensions) {
		throw new MnemocyteError(
			"Embedder returned an embedding with unexpected dimensions.",
			"EMBEDDING",
		);
	}
	if (embedding.some((component) => !Number.isFinite(component))) {
		throw new MnemocyteError(
			"Embedder returned an embedding with non-finite values.",
			"EMBEDDING",
		);
	}
}

export async function embedOne(
	embedder: Embedder,
	text: string,
	options: {
		signal?: AbortSignal;
		resilience?: ProviderResilienceConfig;
	} = {},
): Promise<number[]> {
	let embeddings: number[][];
	try {
		embeddings = await withResilience(
			(signal) =>
				signal === undefined
					? embedder.embed([text])
					: embedder.embed([text], { signal }),
			{
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.resilience === undefined
					? {}
					: { resilience: options.resilience }),
			},
		);
	} catch (error) {
		if (
			error instanceof MnemocyteError &&
			(error.code === "TIMEOUT" || error.code === "ABORTED")
		) {
			throw error;
		}
		throw new MnemocyteError("Failed to embed text.", "EMBEDDING", error);
	}
	const embedding = embeddings[0];
	if (!embedding) {
		throw new MnemocyteError("Embedder returned no embedding.", "EMBEDDING");
	}
	validateEmbedding(embedding, embedder.dimensions);
	return embedding;
}

export async function embedMany(
	embedder: Embedder,
	texts: readonly string[],
	options: {
		signal?: AbortSignal;
		resilience?: ProviderResilienceConfig;
	} = {},
): Promise<number[][]> {
	if (texts.length === 0) {
		return [];
	}
	let embeddings: number[][];
	try {
		embeddings = await withResilience(
			(signal) =>
				signal === undefined
					? embedder.embed(texts)
					: embedder.embed(texts, { signal }),
			{
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.resilience === undefined
					? {}
					: { resilience: options.resilience }),
			},
		);
	} catch (error) {
		if (
			error instanceof MnemocyteError &&
			(error.code === "TIMEOUT" || error.code === "ABORTED")
		) {
			throw error;
		}
		throw new MnemocyteError("Failed to embed texts.", "EMBEDDING", error);
	}
	if (embeddings.length !== texts.length) {
		throw new MnemocyteError(
			`Embedder returned ${embeddings.length} embeddings for ${texts.length} texts.`,
			"EMBEDDING",
		);
	}
	for (const embedding of embeddings) {
		validateEmbedding(embedding, embedder.dimensions);
	}
	return embeddings;
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

export function contextInputToRecallInput(
	input: BuildContextInput,
): RecallInput {
	return {
		entityId: input.entityId,
		query: input.query,
		...(input.limit === undefined ? {} : { limit: input.limit }),
		...(input.minScore === undefined ? {} : { minScore: input.minScore }),
		...(input.types === undefined ? {} : { types: input.types }),
		...(input.tags === undefined ? {} : { tags: input.tags }),
		...(input.includeSuperseded === undefined
			? {}
			: { includeSuperseded: input.includeSuperseded }),
		...(input.includeExpired === undefined
			? {}
			: { includeExpired: input.includeExpired }),
	};
}

/**
 * Validate a {@link PruneInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} when no selector is supplied. Mnemocyte
 * deliberately rejects `prune({})` to avoid surprise full-table deletes.
 */
export function validatePruneInput(input: PruneInput): void {
	if (input.entityId !== undefined) {
		assertNonEmptyString(input.entityId, "entityId");
	}
	const hasSelector =
		input.entityId !== undefined ||
		input.expired === true ||
		input.superseded === true ||
		input.createdBefore !== undefined ||
		input.notAccessedSince !== undefined ||
		(input.types !== undefined && input.types.length > 0) ||
		(input.tags !== undefined && input.tags.length > 0) ||
		input.maxImportance !== undefined;
	if (!hasSelector) {
		throw new MnemocyteError(
			"prune requires at least one selector (entityId, expired, superseded, createdBefore, notAccessedSince, types, tags, or maxImportance).",
			"VALIDATION",
		);
	}
}

/**
 * Test whether `memory` matches a {@link PruneInput}. All specified
 * selectors are AND-combined; unspecified selectors do not restrict.
 *
 * `now` is supplied by the caller so callers can share a consistent
 * timestamp across a batch.
 */
export function matchesPruneFilter(
	memory: Memory,
	input: PruneInput,
	now: Date,
): boolean {
	if (input.entityId !== undefined && memory.entityId !== input.entityId) {
		return false;
	}
	if (input.expired === true && !isExpired(memory, now)) {
		return false;
	}
	if (input.superseded === true && memory.supersededBy === null) {
		return false;
	}
	if (
		input.createdBefore !== undefined &&
		memory.createdAt.getTime() >= input.createdBefore.getTime()
	) {
		return false;
	}
	if (input.notAccessedSince !== undefined) {
		const last = memory.lastAccessedAt;
		if (last !== null && last.getTime() >= input.notAccessedSince.getTime()) {
			return false;
		}
	}
	if (input.types !== undefined && !input.types.includes(memory.type)) {
		return false;
	}
	if (
		input.tags !== undefined &&
		input.tags.length > 0 &&
		!input.tags.every((tag) => memory.tags.includes(tag))
	) {
		return false;
	}
	if (
		input.maxImportance !== undefined &&
		IMPORTANCE_RANK[memory.importance] > IMPORTANCE_RANK[input.maxImportance]
	) {
		return false;
	}
	return true;
}

/** Default cosine-similarity threshold for {@link FindDuplicatesInput}. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;
/** Default cap on the number of duplicate pairs returned. */
export const DEFAULT_DUPLICATE_LIMIT = 100;

/**
 * Validate a {@link FindDuplicatesInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} for malformed `threshold` / `limit` values.
 */
export function validateFindDuplicatesInput(input: FindDuplicatesInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	if (input.threshold !== undefined) {
		if (
			!Number.isFinite(input.threshold) ||
			input.threshold < 0 ||
			input.threshold > 1
		) {
			throw new MnemocyteError(
				"threshold must be a number between 0 and 1.",
				"VALIDATION",
			);
		}
	}
	if (input.limit !== undefined) {
		assertLimit(input.limit);
	}
}

/**
 * Return `true` when a memory should participate in a duplicate scan,
 * given the filters on `input` and a shared `now` timestamp.
 */
export function matchesDuplicateFilter(
	memory: Memory,
	input: FindDuplicatesInput,
	now: Date,
): boolean {
	if (memory.entityId !== input.entityId) {
		return false;
	}
	if (input.includeSuperseded !== true && memory.supersededBy !== null) {
		return false;
	}
	if (input.includeExpired !== true && isExpired(memory, now)) {
		return false;
	}
	if (input.types !== undefined && !input.types.includes(memory.type)) {
		return false;
	}
	if (
		input.tags !== undefined &&
		input.tags.length > 0 &&
		!input.tags.every((tag) => memory.tags.includes(tag))
	) {
		return false;
	}
	return true;
}

/** Default cap on audit-log entries returned per `listAuditLog`. */
export const DEFAULT_AUDIT_LOG_LIMIT = 50;

/**
 * Validate a {@link ConsolidateInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} for malformed inputs (empty `supersededIds`
 * or a `survivorId` appearing in `supersededIds`).
 */
export function validateConsolidateInput(input: ConsolidateInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	assertNonEmptyString(input.survivorId, "survivorId");
	if (input.supersededIds.length === 0) {
		throw new MnemocyteError(
			"supersededIds must contain at least one memory id.",
			"VALIDATION",
		);
	}
	if (input.supersededIds.includes(input.survivorId)) {
		throw new MnemocyteError(
			"survivorId must not appear in supersededIds.",
			"VALIDATION",
		);
	}
	for (const id of input.supersededIds) {
		assertNonEmptyString(id, "supersededIds[*]");
	}
}

/**
 * Validate a {@link ListAuditLogInput} and throw a `"VALIDATION"`
 * {@link MnemocyteError} when malformed.
 */
export function validateListAuditLogInput(input: ListAuditLogInput): void {
	assertNonEmptyString(input.entityId, "entityId");
	if (input.limit !== undefined) {
		assertLimit(input.limit);
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
