import type { JsonObject } from "../types.js";

type RawTimestamp = Date | string;

/** A `mnemocyte_memories` row without its embedding. */
export interface MemoryRow {
	id: string;
	entityId: string;
	content: string;
	type: string;
	importance: string;
	tags: string[];
	source: string | null;
	metadata: JsonObject;
	confidence: number;
	embeddingModel: string;
	embeddingDimensions: number;
	supersededBy: string | null;
	supersededAt: Date | null;
	expiresAt: Date | null;
	lastAccessedAt: Date | null;
	accessCount: number;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * A memory row as the driver returns it. Metadata is selected as text and
 * timestamps may be `Date` or ISO strings, depending on parsers the caller
 * (or Drizzle) installed on the client.
 */
export type RawMemoryRow = Omit<
	MemoryRow,
	| "metadata"
	| "supersededAt"
	| "expiresAt"
	| "lastAccessedAt"
	| "createdAt"
	| "updatedAt"
> & {
	metadata: string;
	supersededAt: RawTimestamp | null;
	expiresAt: RawTimestamp | null;
	lastAccessedAt: RawTimestamp | null;
	createdAt: RawTimestamp;
	updatedAt: RawTimestamp;
};

export interface EventRow {
	id: string;
	entityId: string;
	description: string;
	metadata: JsonObject;
	timestamp: Date;
}

export type RawEventRow = Omit<EventRow, "metadata" | "timestamp"> & {
	metadata: string;
	timestamp: RawTimestamp;
};

export interface MetaRow {
	key: string;
	embeddingDimensions: number;
	embeddingModel: string | null;
}

/** Column, result key and optional cast, in `MemoryRow` order. */
const MEMORY_COLUMNS = [
	["id", "id", undefined],
	["entity_id", "entityId", undefined],
	["content", "content", undefined],
	["type", "type", undefined],
	["importance", "importance", undefined],
	["tags", "tags", undefined],
	["source", "source", undefined],
	["metadata", "metadata", "text"],
	["confidence", "confidence", undefined],
	["embedding_model", "embeddingModel", undefined],
	["embedding_dimensions", "embeddingDimensions", undefined],
	["superseded_by", "supersededBy", undefined],
	["superseded_at", "supersededAt", undefined],
	["expires_at", "expiresAt", undefined],
	["last_accessed_at", "lastAccessedAt", undefined],
	["access_count", "accessCount", undefined],
	["created_at", "createdAt", undefined],
	["updated_at", "updatedAt", undefined],
] as const satisfies ReadonlyArray<
	readonly [string, keyof RawMemoryRow, string | undefined]
>;

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The `SELECT` list for a memory row. With `prefix`, result keys become
 * `aId`, `aEntityId`, … so two rows can share one result row.
 */
export function selectMemoryColumns(
	options: { table?: string; prefix?: string } = {},
): string {
	return MEMORY_COLUMNS.map(([column, key, cast]) => {
		const qualified = options.table ? `${options.table}.${column}` : column;
		const expression = cast ? `${qualified}::${cast}` : qualified;
		const alias = options.prefix ? `${options.prefix}${capitalize(key)}` : key;
		return `${expression} AS "${alias}"`;
	}).join(", ");
}

/** Pick the columns that {@link selectMemoryColumns} prefixed with `prefix`. */
export function extractPrefixedMemoryRow(
	row: Record<string, unknown>,
	prefix: string,
): RawMemoryRow {
	const picked: Record<string, unknown> = {};
	for (const [, key] of MEMORY_COLUMNS) {
		picked[key] = row[`${prefix}${capitalize(key)}`];
	}
	// The keys and value types are exactly what selectMemoryColumns selected.
	return picked as unknown as RawMemoryRow;
}

export const EVENT_COLUMNS = `id, entity_id AS "entityId", description, metadata::text AS metadata, timestamp`;

export const META_COLUMNS = `key, embedding_dimensions AS "embeddingDimensions", embedding_model AS "embeddingModel"`;

export function toDate(value: RawTimestamp): Date {
	return value instanceof Date ? value : new Date(value);
}

export function toNullableDate(value: RawTimestamp | null): Date | null {
	return value === null ? null : toDate(value);
}

function parseJsonObject(value: string): JsonObject {
	// The column is `jsonb NOT NULL` and only this library writes it as an
	// object; the store clones and validates it again in `rowToMemory`.
	return JSON.parse(value) as JsonObject;
}

export function toMemoryRow(raw: RawMemoryRow): MemoryRow {
	return {
		...raw,
		metadata: parseJsonObject(raw.metadata),
		supersededAt: toNullableDate(raw.supersededAt),
		expiresAt: toNullableDate(raw.expiresAt),
		lastAccessedAt: toNullableDate(raw.lastAccessedAt),
		createdAt: toDate(raw.createdAt),
		updatedAt: toDate(raw.updatedAt),
	};
}

export function toEventRow(raw: RawEventRow): EventRow {
	return {
		...raw,
		metadata: parseJsonObject(raw.metadata),
		timestamp: toDate(raw.timestamp),
	};
}
