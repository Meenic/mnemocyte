import type {
	FindDuplicatesInput,
	ImportanceLevel,
	MemoryType,
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

/** Default cosine-similarity threshold for {@link FindDuplicatesInput}. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;
/** Default cap on the number of duplicate pairs returned. */
export const DEFAULT_DUPLICATE_LIMIT = 100;
/** Default cap on audit-log entries returned per `listAuditLog`. */
export const DEFAULT_AUDIT_LOG_LIMIT = 50;
