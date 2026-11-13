/**
 * Input size caps. Every backend enforces the same values, before any
 * embedder or database call, with `"VALIDATION"` errors.
 */

/** `limit` on search, context, list, findDuplicates and listAuditLog. */
export const MAX_LIMIT = 1000;

/**
 * Characters (UTF-16 code units, `string.length`) in `content` and in a
 * search `query`: about 8,000 tokens, the input limit of common embedding
 * models, and far below Postgres's 1 MB `tsvector` limit.
 */
export const MAX_CONTENT_LENGTH = 32_000;

/** Tags on one memory or in one filter. */
export const MAX_TAGS = 64;

/** Characters in one tag. */
export const MAX_TAG_LENGTH = 128;

/** UTF-8 bytes of `metadata` serialized as JSON. */
export const MAX_METADATA_BYTES = 65_536;

/** Nesting depth of `metadata`; the object itself is depth 1. */
export const MAX_METADATA_DEPTH = 32;

/**
 * UTF-8 bytes in a `key`, and in each scope field (`namespace`, `entityId`,
 * `agentId`, `sessionId`). The unique scope + key btree index holds all five,
 * and a btree entry may not exceed about a third of an 8 kB page (~2.7 kB);
 * 4 × 256 + 512 bytes stays well under it.
 */
export const MAX_KEY_BYTES = 512;
export const MAX_SCOPE_FIELD_BYTES = 256;

/**
 * `neighbors` of `findDuplicates`: nearest neighbors compared per memory.
 * Each is one HNSW probe on Postgres, whose `hnsw.ef_search` tops out at
 * 1,000.
 */
export const MAX_DUPLICATE_NEIGHBORS = 100;

/** Memories in one `addMany` call; they are written in one transaction. */
export const MAX_ADD_MANY = 1000;

/** `batchSize` of `pruneAuditLog`: events one statement deletes. */
export const MAX_AUDIT_PRUNE_BATCH = 10_000;

const encoder = new TextEncoder();

/** UTF-8 length of `value`. */
export function utf8Length(value: string): number {
	return encoder.encode(value).length;
}
