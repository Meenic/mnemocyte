import type {
	DependentsPolicy,
	ImportanceLevel,
	MemoryKind,
} from "../types.js";

export const DEFAULT_LIMIT = 10;
export const DEFAULT_MIN_SCORE = 0;
export const DEFAULT_KIND: MemoryKind = "fact";
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

/** Default cosine-similarity threshold for `findDuplicates`. */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.95;
/** Default cap on the number of duplicate pairs returned. */
export const DEFAULT_DUPLICATE_LIMIT = 100;
/** Default nearest neighbors compared per memory by `findDuplicates`. */
export const DEFAULT_DUPLICATE_NEIGHBORS = 10;
/** Default `dependents` policy of `delete`. */
export const DEFAULT_DEPENDENTS_POLICY: DependentsPolicy = "reject";
/** Default cap on audit-log entries returned per `listAuditLog`. */
export const DEFAULT_AUDIT_LOG_LIMIT = 50;
/** Default page size of `list`. */
export const DEFAULT_LIST_LIMIT = 50;
