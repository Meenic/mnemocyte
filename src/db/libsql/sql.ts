import type { JsonObject } from "../../types.js";
import type { EventRow, MemoryRow } from "../rows.js";
import type { LibsqlRow, LibsqlValue } from "./executor.js";

/**
 * Collects positional parameters while a statement is assembled. SQLite
 * binds `?NNN` by number, so a placeholder can repeat and appear in any
 * order; `$n` would be a named parameter numbered by first appearance.
 */
export interface LibsqlParams {
	readonly values: LibsqlValue[];
	/** Add one value and return its `?n` placeholder. */
	add(value: LibsqlValue): string;
	/** `?1, ?2, …` for an `IN (…)` list. */
	list(values: readonly LibsqlValue[]): string;
	/** A timestamp as Unix milliseconds, the precision of the columns. */
	time(value: Date): string;
	/** A nullable timestamp. */
	nullableTime(value: Date | null): string;
	/** A JSON text parameter. */
	json(value: unknown): string;
	/**
	 * `vector32(?n)` over the vector as a blob of little-endian float32s,
	 * the layout of an `F32_BLOB` (4 bytes per dimension). A blob costs
	 * libSQL no parsing: JSON text was parsed again for every row a search
	 * compared, which doubled its time.
	 */
	vector(values: readonly number[]): string;
}

export function createLibsqlParams(): LibsqlParams {
	const values: LibsqlValue[] = [];
	const params: LibsqlParams = {
		values,
		add(value) {
			values.push(value);
			return `?${values.length}`;
		},
		list(items) {
			return items.map((item) => params.add(item)).join(", ");
		},
		time(value) {
			return params.add(value.getTime());
		},
		nullableTime(value) {
			return value === null ? params.add(null) : params.time(value);
		},
		json(value) {
			return params.add(JSON.stringify(value));
		},
		vector(values) {
			return `vector32(${params.add(Float32Array.from(values).buffer)})`;
		},
	};
	return params;
}

/**
 * A lower-case UUIDv7 built in SQL, for statements that cannot know how many
 * ids they need (the audit events of a delete or prune): the 48-bit Unix
 * milliseconds of `millis` (an integer expression), version 7, the RFC 9562
 * variant, then random bits. `randomblob` runs once per row.
 */
export function sqlUuidV7(millis: string): string {
	const hex = `printf('%012x', ${millis})`;
	return `lower(substr(${hex}, 1, 8) || '-' || substr(${hex}, 9, 4) || '-7' || substr(hex(randomblob(2)), 2, 3) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6)))`;
}

/** Table and index names. libSQL has one schema per database. */
export const LIBSQL_TABLES = {
	memories: '"mnemocyte_memories"',
	fts: '"mnemocyte_memories_fts"',
	events: '"mnemocyte_events"',
	meta: '"mnemocyte_meta"',
	migrations: '"mnemocyte_migrations"',
} as const;

/** The name SQLite reports in a unique violation on scope + key. */
export const LIBSQL_SCOPE_KEY_INDEX = "mnemocyte_memories_scope_key_idx";

/** Column, result key, in `MemoryRow` order. */
const MEMORY_COLUMNS = [
	["id", "id"],
	["namespace", "namespace"],
	["entity_id", "entityId"],
	["agent_id", "agentId"],
	["session_id", "sessionId"],
	["key", "key"],
	["content", "content"],
	["kind", "kind"],
	["importance", "importance"],
	["tags", "tags"],
	["source", "source"],
	["metadata", "metadata"],
	["confidence", "confidence"],
	["embedding_model", "embeddingModel"],
	["embedding_dimensions", "embeddingDimensions"],
	["superseded_by", "supersededBy"],
	["superseded_at", "supersededAt"],
	["expires_at", "expiresAt"],
	["last_accessed_at", "lastAccessedAt"],
	["access_count", "accessCount"],
	["created_at", "createdAt"],
	["updated_at", "updatedAt"],
] as const;

function capitalize(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The `SELECT` list for a memory row, without the embedding. With `prefix`,
 * result keys become `aId`, `aEntityId`, … so two rows share one result row.
 */
export function libsqlMemoryColumns(
	options: { table?: string; prefix?: string } = {},
): string {
	return MEMORY_COLUMNS.map(([column, key]) => {
		const qualified = options.table
			? `${options.table}."${column}"`
			: `"${column}"`;
		const alias = options.prefix ? `${options.prefix}${capitalize(key)}` : key;
		return `${qualified} AS "${alias}"`;
	}).join(", ");
}

export const LIBSQL_EVENT_COLUMNS = `"id" AS "id", "namespace" AS "namespace", "entity_id" AS "entityId", "agent_id" AS "agentId", "session_id" AS "sessionId", "description" AS "description", "metadata" AS "metadata", "timestamp" AS "timestamp"`;

/** The rows have the Postgres store's shapes, so `rowToMemory` reads both. */
export type LibsqlMemoryRow = MemoryRow;
export type LibsqlEventRow = EventRow;

function text(value: unknown): string {
	return typeof value === "string" ? value : String(value);
}

function nullableText(value: unknown): string | null {
	return value === null || value === undefined ? null : text(value);
}

/**
 * A number from an integer or real column. The client's `intMode` may
 * return integers as `number`, `bigint` or `string`; all convert.
 */
export function toNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value);
}

function toTime(value: unknown): Date {
	return new Date(toNumber(value));
}

function toNullableTime(value: unknown): Date | null {
	return value === null || value === undefined ? null : toTime(value);
}

function parseJson<T>(value: unknown): T {
	// Only this library writes the JSON columns, as arrays of strings
	// (`tags`) or objects (`metadata`); `rowToMemory` clones metadata again.
	return JSON.parse(text(value)) as T;
}

export function toLibsqlMemoryRow(
	row: LibsqlRow,
	prefix = "",
): LibsqlMemoryRow {
	const get = (key: string): unknown =>
		row[prefix === "" ? key : `${prefix}${capitalize(key)}`];
	return {
		id: text(get("id")),
		namespace: text(get("namespace")),
		entityId: text(get("entityId")),
		agentId: nullableText(get("agentId")),
		sessionId: nullableText(get("sessionId")),
		key: nullableText(get("key")),
		content: text(get("content")),
		kind: text(get("kind")),
		importance: text(get("importance")),
		tags: parseJson<string[]>(get("tags")),
		source: nullableText(get("source")),
		metadata: parseJson<JsonObject>(get("metadata")),
		confidence: toNumber(get("confidence")),
		embeddingModel: text(get("embeddingModel")),
		embeddingDimensions: toNumber(get("embeddingDimensions")),
		supersededBy: nullableText(get("supersededBy")),
		supersededAt: toNullableTime(get("supersededAt")),
		expiresAt: toNullableTime(get("expiresAt")),
		lastAccessedAt: toNullableTime(get("lastAccessedAt")),
		accessCount: toNumber(get("accessCount")),
		createdAt: toTime(get("createdAt")),
		updatedAt: toTime(get("updatedAt")),
	};
}

export function toLibsqlEventRow(row: LibsqlRow): LibsqlEventRow {
	return {
		id: text(row.id),
		namespace: text(row.namespace),
		entityId: text(row.entityId),
		agentId: nullableText(row.agentId),
		sessionId: nullableText(row.sessionId),
		description: text(row.description),
		metadata: parseJson<JsonObject>(row.metadata),
		timestamp: toTime(row.timestamp),
	};
}

/**
 * An audit position's timestamp: UTC ISO 8601 with six fraction digits, as
 * the store contract spells it. libSQL stores milliseconds, so the last
 * three digits are zero.
 */
export function positionTimestamp(millis: number): string {
	const iso = new Date(millis).toISOString();
	return `${iso.slice(0, -1)}000Z`;
}

/** Milliseconds of a position timestamp; digits past the third are cut. */
export function positionMillis(timestamp: string): number {
	return new Date(timestamp).getTime();
}

/**
 * A stored `F32_BLOB` as numbers. The driver returns blobs as an
 * `ArrayBuffer` (a typed array is accepted too); a length other than four
 * bytes per dimension means the column holds something this library did not
 * write.
 *
 * @throws {Error} When the value is not a blob of `dimensions` float32s.
 */
export function toEmbedding(value: unknown, dimensions: number): number[] {
	let bytes: Uint8Array;
	if (value instanceof ArrayBuffer) {
		bytes = new Uint8Array(value);
	} else if (ArrayBuffer.isView(value)) {
		bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	} else {
		throw new Error("mnemocyte_memories.embedding is not a blob.");
	}
	if (bytes.byteLength !== dimensions * 4) {
		throw new Error(
			`mnemocyte_memories.embedding holds ${bytes.byteLength} bytes; ${dimensions} float32 dimensions take ${dimensions * 4}.`,
		);
	}
	// Copied, so the view is aligned whatever the source offset.
	return Array.from(new Float32Array(bytes.slice().buffer));
}
