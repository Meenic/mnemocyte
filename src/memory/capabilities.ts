import type { StoreCapabilities } from "./store.js";

/**
 * The in-memory backend: an exhaustive cosine scan of the rows that pass the
 * filters, keyword scores from query-term overlap, and no dimension limit.
 * Every call runs to completion before the next starts, so writes never
 * interleave.
 */
export const IN_MEMORY_CAPABILITIES: StoreCapabilities = Object.freeze({
	vectorSearch: "exact",
	filteredVectorSearch: "prefilter",
	lexicalSearch: "overlap",
	locking: "database",
	maxDimensions: Number.POSITIVE_INFINITY,
});

/**
 * The Postgres backend: an HNSW index scanned with pgvector 0.8 iterative
 * scans, `ts_rank` over `content_tsv`, row locks (`SELECT … FOR UPDATE`),
 * and `halfvec` up to the 4,000 dimensions an HNSW index holds. Kept apart
 * from the backend, so the lazily loaded store knows it before loading.
 */
export const POSTGRES_CAPABILITIES: StoreCapabilities = Object.freeze({
	vectorSearch: "approximate",
	filteredVectorSearch: "iterative",
	lexicalSearch: "ts_rank",
	locking: "row",
	maxDimensions: 4000,
});
