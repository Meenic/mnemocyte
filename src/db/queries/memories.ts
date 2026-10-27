import type { SqlExecutor } from "../../sql/executor.js";
import type { ImportanceLevel, MemoryType } from "../../types.js";
import {
	extractPrefixedMemoryRow,
	type MemoryRow,
	type RawMemoryRow,
	selectMemoryColumns,
	toMemoryRow,
} from "../rows.js";
import { createSqlParams, type SqlParams } from "../sql.js";
import { formatVector, parseVector } from "../vector.js";

export interface MemoryFilter {
	entityId: string;
	types?: readonly MemoryType[];
	tags?: readonly string[];
	before?: Date;
	after?: Date;
	includeSuperseded?: boolean;
	includeExpired?: boolean;
}

export interface VectorSearchInput extends MemoryFilter {
	embedding: readonly number[];
	limit: number;
	minVectorScore?: number;
}

export interface LexicalSearchInput extends MemoryFilter {
	query: string;
	limit: number;
}

export interface MemoryStatsCounts {
	memoryCount: number;
	activeMemoryCount: number;
	expiredMemoryCount: number;
	supersededMemoryCount: number;
}

export interface GuardedDeleteResult {
	matchedCount: number;
	deletedCount: number;
	hasDependents: boolean;
	deletedByEntity: Array<{ entityId: string; deletedCount: number }>;
}

export interface GlobalMemoryStatsCounts extends MemoryStatsCounts {
	entityCount: number;
}

export type VectorSearchRow = MemoryRow & { vectorScore: number };

export type LexicalSearchRow = MemoryRow & { lexicalScore: number };

export interface NewMemoryRow {
	id: string;
	entityId: string;
	content: string;
	type: string;
	importance: string;
	tags: string[];
	source: string | null;
	metadata: unknown;
	confidence: number;
	embedding: number[];
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

const MEMORY_COLUMNS = selectMemoryColumns();

function nullableTimestamp(params: SqlParams, value: Date | null): string {
	return value === null
		? `${params.add(null)}::timestamptz`
		: params.timestamp(value);
}

/**
 * Filters shared by the recall queries, as `AND …` clauses for a table without
 * an alias.
 */
function recallFilters(params: SqlParams, input: MemoryFilter): string {
	const clauses: string[] = [`entity_id = ${params.add(input.entityId)}`];
	if (!input.includeSuperseded) {
		clauses.push("superseded_by IS NULL");
	}
	if (!input.includeExpired) {
		clauses.push("(expires_at IS NULL OR expires_at > now())");
	}
	if (input.types && input.types.length > 0) {
		clauses.push(`type IN (${params.list(input.types)})`);
	}
	if (input.tags && input.tags.length > 0) {
		clauses.push(`tags @> ${params.textArray(input.tags)}`);
	}
	if (input.before) {
		clauses.push(`created_at < ${params.timestamp(input.before)}`);
	}
	if (input.after) {
		clauses.push(`created_at > ${params.timestamp(input.after)}`);
	}
	return clauses.join("\n\t\t\tAND ");
}

function memoryStatsCountColumns(params: SqlParams, now: Date): string {
	const nowParam = params.timestamp(now);
	return `
		count(*)::int AS "memoryCount",
		(count(*) FILTER (
			WHERE superseded_by IS NULL
				AND (expires_at IS NULL OR expires_at > ${nowParam})
		))::int AS "activeMemoryCount",
		(count(*) FILTER (
			WHERE expires_at IS NOT NULL AND expires_at <= ${nowParam}
		))::int AS "expiredMemoryCount",
		(count(*) FILTER (WHERE superseded_by IS NOT NULL))::int AS "supersededMemoryCount"
	`;
}

function emptyMemoryStatsCounts(): MemoryStatsCounts {
	return {
		memoryCount: 0,
		activeMemoryCount: 0,
		expiredMemoryCount: 0,
		supersededMemoryCount: 0,
	};
}

export async function insertMemories(
	db: SqlExecutor,
	rows: readonly NewMemoryRow[],
): Promise<MemoryRow[]> {
	if (rows.length === 0) {
		return [];
	}
	const params = createSqlParams();
	const tuples = rows.map(
		(row) => `(
			${params.add(row.id)},
			${params.add(row.entityId)},
			${params.add(row.content)},
			${params.add(row.type)},
			${params.add(row.importance)},
			${params.textArrayValue(row.tags)},
			${params.add(row.source)}::text,
			${params.json(row.metadata)},
			${params.add(row.confidence)}::real,
			${params.add(formatVector(row.embedding))}::vector,
			${params.add(row.embeddingModel)},
			${params.add(row.embeddingDimensions)}::int,
			${params.add(row.supersededBy)}::text,
			${nullableTimestamp(params, row.supersededAt)},
			${nullableTimestamp(params, row.expiresAt)},
			${nullableTimestamp(params, row.lastAccessedAt)},
			${params.add(row.accessCount)}::int,
			${params.timestamp(row.createdAt)},
			${params.timestamp(row.updatedAt)}
		)`,
	);
	const result = await db.query<RawMemoryRow>(
		`INSERT INTO mnemocyte_memories (
			id, entity_id, content, type, importance, tags, source, metadata,
			confidence, embedding, embedding_model, embedding_dimensions,
			superseded_by, superseded_at, expires_at, last_accessed_at,
			access_count, created_at, updated_at
		)
		VALUES ${tuples.join(",\n")}
		RETURNING ${MEMORY_COLUMNS}`,
		params.values,
	);
	return result.map(toMemoryRow);
}

export async function getMemoryById(
	db: SqlExecutor,
	entityId: string,
	memoryId: string,
): Promise<MemoryRow | null> {
	const rows = await db.query<RawMemoryRow>(
		`SELECT ${MEMORY_COLUMNS}
		FROM mnemocyte_memories
		WHERE entity_id = $1 AND id = $2
		LIMIT 1`,
		[entityId, memoryId],
	);
	const row = rows[0];
	return row ? toMemoryRow(row) : null;
}

export async function getEntityMemoryStatsCounts(
	db: SqlExecutor,
	entityId: string,
	now: Date,
): Promise<MemoryStatsCounts> {
	const params = createSqlParams();
	const columns = memoryStatsCountColumns(params, now);
	const rows = await db.query<MemoryStatsCounts>(
		`SELECT ${columns}
		FROM mnemocyte_memories
		WHERE entity_id = ${params.add(entityId)}`,
		params.values,
	);
	return rows[0] ?? emptyMemoryStatsCounts();
}

export async function getGlobalMemoryStatsCounts(
	db: SqlExecutor,
	now: Date,
): Promise<GlobalMemoryStatsCounts> {
	const params = createSqlParams();
	const columns = memoryStatsCountColumns(params, now);
	const rows = await db.query<GlobalMemoryStatsCounts>(
		`SELECT count(DISTINCT entity_id)::int AS "entityCount", ${columns}
		FROM mnemocyte_memories`,
		params.values,
	);
	return rows[0] ?? { entityCount: 0, ...emptyMemoryStatsCounts() };
}

export async function deleteMemory(
	db: SqlExecutor,
	entityId: string,
	memoryId: string,
): Promise<GuardedDeleteResult> {
	const params = createSqlParams();
	const conditions = `entity_id = ${params.add(entityId)} AND id = ${params.add(memoryId)}`;
	return deleteMemoriesWithDependentGuard(db, conditions, params);
}

export async function deleteMemoriesForEntity(
	db: SqlExecutor,
	entityId: string,
): Promise<GuardedDeleteResult> {
	const params = createSqlParams();
	const conditions = `entity_id = ${params.add(entityId)}`;
	return deleteMemoriesWithDependentGuard(db, conditions, params);
}

export interface PruneFilter {
	entityId?: string;
	expired?: boolean;
	superseded?: boolean;
	createdBefore?: Date;
	notAccessedSince?: Date;
	types?: readonly MemoryType[];
	tags?: readonly string[];
	maxImportanceLevels?: readonly ImportanceLevel[];
}

/** The `WHERE` conditions of a prune, or `undefined` when nothing filters. */
function pruneConditions(
	params: SqlParams,
	filter: PruneFilter,
): string | undefined {
	const clauses: string[] = [];
	if (filter.entityId !== undefined) {
		clauses.push(`entity_id = ${params.add(filter.entityId)}`);
	}
	if (filter.expired) {
		clauses.push("(expires_at IS NOT NULL AND expires_at <= now())");
	}
	if (filter.superseded) {
		clauses.push("superseded_by IS NOT NULL");
	}
	if (filter.createdBefore) {
		clauses.push(`created_at < ${params.timestamp(filter.createdBefore)}`);
	}
	if (filter.notAccessedSince) {
		clauses.push(
			`(last_accessed_at IS NULL OR last_accessed_at < ${params.timestamp(filter.notAccessedSince)})`,
		);
	}
	if (filter.types && filter.types.length > 0) {
		clauses.push(`type IN (${params.list(filter.types)})`);
	}
	if (filter.tags && filter.tags.length > 0) {
		clauses.push(`tags @> ${params.textArray(filter.tags)}`);
	}
	if (filter.maxImportanceLevels && filter.maxImportanceLevels.length > 0) {
		clauses.push(`importance IN (${params.list(filter.maxImportanceLevels)})`);
	}
	return clauses.length > 0 ? clauses.join(" AND ") : undefined;
}

export async function countPruneMatches(
	db: SqlExecutor,
	filter: PruneFilter,
	signal?: AbortSignal,
): Promise<number> {
	const params = createSqlParams();
	const conditions = pruneConditions(params, filter);
	const rows = await db.query<{ count: number | string }>(
		`SELECT count(*)::int AS count
		FROM mnemocyte_memories
		${conditions ? `WHERE ${conditions}` : ""}`,
		params.values,
		signal ? { signal } : undefined,
	);
	return Number(rows[0]?.count ?? 0);
}

export async function pruneMemories(
	db: SqlExecutor,
	filter: PruneFilter,
	signal?: AbortSignal,
): Promise<GuardedDeleteResult> {
	const params = createSqlParams();
	const conditions = pruneConditions(params, filter);
	return deleteMemoriesWithDependentGuard(db, conditions, params, signal);
}

async function deleteMemoriesWithDependentGuard(
	db: SqlExecutor,
	conditions: string | undefined,
	params: SqlParams,
	signal?: AbortSignal,
): Promise<GuardedDeleteResult> {
	const rows = await db.query<{
		matchedCount: number | string;
		deletedCount: number | string;
		hasDependents: boolean;
		entityId: string | null;
		entityDeletedCount: number | string | null;
	}>(
		`WITH candidates AS MATERIALIZED (
			SELECT id, entity_id
			FROM mnemocyte_memories
			${conditions ? `WHERE ${conditions}` : ""}
		),
		dependents AS MATERIALIZED (
			SELECT 1
			FROM mnemocyte_memories AS dependent
			INNER JOIN candidates AS target
				ON dependent.superseded_by = target.id
			LIMIT 1
		),
		deleted AS (
			DELETE FROM mnemocyte_memories
			WHERE id IN (SELECT id FROM candidates)
				AND NOT EXISTS (SELECT 1 FROM dependents)
			RETURNING id, entity_id
		),
		deleted_counts AS (
			SELECT entity_id, count(*)::int AS deleted_count
			FROM deleted
			GROUP BY entity_id
		),
		summary AS (
			SELECT
				(SELECT count(*)::int FROM candidates) AS matched_count,
				(SELECT count(*)::int FROM deleted) AS deleted_count,
				EXISTS (SELECT 1 FROM dependents) AS has_dependents
		)
		SELECT
			summary.matched_count AS "matchedCount",
			summary.deleted_count AS "deletedCount",
			summary.has_dependents AS "hasDependents",
			deleted_counts.entity_id AS "entityId",
			deleted_counts.deleted_count AS "entityDeletedCount"
		FROM summary
		LEFT JOIN deleted_counts ON true
		ORDER BY deleted_counts.entity_id`,
		params.values,
		signal ? { signal } : undefined,
	);
	const row = rows[0];
	return {
		matchedCount: Number(row?.matchedCount ?? 0),
		deletedCount: Number(row?.deletedCount ?? 0),
		hasDependents: row?.hasDependents === true,
		deletedByEntity: rows.flatMap((detail) =>
			detail.entityId === null
				? []
				: [
						{
							entityId: detail.entityId,
							deletedCount: Number(detail.entityDeletedCount ?? 0),
						},
					],
		),
	};
}

export interface DuplicateSearchInput {
	entityId: string;
	threshold: number;
	limit: number;
	types?: readonly string[];
	tags?: readonly string[];
	includeSuperseded?: boolean;
	includeExpired?: boolean;
}

export async function findDuplicatePairs(
	db: SqlExecutor,
	input: DuplicateSearchInput,
	signal?: AbortSignal,
): Promise<Array<{ a: MemoryRow; b: MemoryRow; similarity: number }>> {
	const params = createSqlParams();
	const clauses: string[] = [`a.entity_id = ${params.add(input.entityId)}`];
	if (!input.includeSuperseded) {
		clauses.push("a.superseded_by IS NULL AND b.superseded_by IS NULL");
	}
	if (!input.includeExpired) {
		clauses.push(
			"(a.expires_at IS NULL OR a.expires_at > now()) AND (b.expires_at IS NULL OR b.expires_at > now())",
		);
	}
	if (input.types && input.types.length > 0) {
		const types = params.list(input.types);
		clauses.push(`a.type IN (${types}) AND b.type IN (${types})`);
	}
	if (input.tags && input.tags.length > 0) {
		const tags = params.textArray(input.tags);
		clauses.push(`a.tags @> ${tags} AND b.tags @> ${tags}`);
	}
	clauses.push(
		`1 - (a.embedding <=> b.embedding) >= ${params.add(input.threshold)}`,
	);
	const rows = await db.query<Record<string, unknown>>(
		`SELECT
			${selectMemoryColumns({ table: "a", prefix: "a" })},
			${selectMemoryColumns({ table: "b", prefix: "b" })},
			1 - (a.embedding <=> b.embedding) AS "similarity"
		FROM mnemocyte_memories a
		JOIN mnemocyte_memories b
			ON b.entity_id = a.entity_id
			AND a.id < b.id
			AND a.embedding IS NOT NULL
			AND b.embedding IS NOT NULL
		WHERE ${clauses.join("\n\t\t\tAND ")}
		ORDER BY "similarity" DESC
		LIMIT ${params.add(input.limit)}`,
		params.values,
		signal ? { signal } : undefined,
	);
	return rows.map((row) => ({
		a: toMemoryRow(extractPrefixedMemoryRow(row, "a")),
		b: toMemoryRow(extractPrefixedMemoryRow(row, "b")),
		similarity: Number(row.similarity) || 0,
	}));
}

export interface SupersedeRow {
	id: string;
	tags: string[];
}

export async function loadConsolidationTargets(
	db: SqlExecutor,
	entityId: string,
	ids: readonly string[],
): Promise<Array<{ id: string; tags: string[]; supersededBy: string | null }>> {
	if (ids.length === 0) {
		return [];
	}
	const params = createSqlParams();
	return db.query(
		`SELECT id, tags, superseded_by AS "supersededBy"
		FROM mnemocyte_memories
		WHERE entity_id = ${params.add(entityId)}
			AND id IN (${params.list(ids)})`,
		params.values,
	);
}

export async function lockConsolidationMemories(
	db: SqlExecutor,
	entityId: string,
	survivorId: string,
	supersededIds: readonly string[],
): Promise<Array<{ id: string; tags: string[]; supersededBy: string | null }>> {
	const ids = [...new Set([survivorId, ...supersededIds])].sort();
	const params = createSqlParams();
	return db.query(
		`SELECT id, tags, superseded_by AS "supersededBy"
		FROM mnemocyte_memories
		WHERE entity_id = ${params.add(entityId)}
			AND id IN (${params.list(ids)})
		ORDER BY id
		FOR UPDATE`,
		params.values,
	);
}

export async function markMemoriesSuperseded(
	db: SqlExecutor,
	input: {
		survivorId: string;
		entityId: string;
		ids: readonly string[];
		now: Date;
	},
): Promise<SupersedeRow[]> {
	if (input.ids.length === 0) {
		return [];
	}
	const params = createSqlParams();
	const survivorId = params.add(input.survivorId);
	const now = params.timestamp(input.now);
	return db.query<SupersedeRow>(
		`UPDATE mnemocyte_memories
		SET superseded_by = ${survivorId}, superseded_at = ${now}, updated_at = ${now}
		WHERE entity_id = ${params.add(input.entityId)}
			AND id IN (${params.list(input.ids)})
			AND superseded_by IS NULL
		RETURNING id, tags`,
		params.values,
	);
}

export async function setMemoryTags(
	db: SqlExecutor,
	input: {
		entityId: string;
		memoryId: string;
		tags: readonly string[];
		now: Date;
	},
): Promise<void> {
	const params = createSqlParams();
	await db.query(
		`UPDATE mnemocyte_memories
		SET tags = ${params.textArrayValue(input.tags)}, updated_at = ${params.timestamp(input.now)}
		WHERE entity_id = ${params.add(input.entityId)}
			AND id = ${params.add(input.memoryId)}`,
		params.values,
	);
}

export async function markMemoriesAccessed(
	db: SqlExecutor,
	memoryIds: readonly string[],
): Promise<
	Array<{
		id: string;
		lastAccessedAt: Date | null;
		accessCount: number;
		updatedAt: Date;
	}>
> {
	if (memoryIds.length === 0) {
		return [];
	}
	const params = createSqlParams();
	const now = params.timestamp(new Date());
	const rows = await db.query<{
		id: string;
		lastAccessedAt: Date | string | null;
		accessCount: number;
		updatedAt: Date | string;
	}>(
		`UPDATE mnemocyte_memories
		SET last_accessed_at = ${now}, access_count = access_count + 1, updated_at = ${now}
		WHERE id IN (${params.list(memoryIds)})
		RETURNING id, last_accessed_at AS "lastAccessedAt", access_count AS "accessCount", updated_at AS "updatedAt"`,
		params.values,
	);
	return rows.map((row) => ({
		id: row.id,
		lastAccessedAt:
			row.lastAccessedAt === null ? null : new Date(row.lastAccessedAt),
		accessCount: row.accessCount,
		updatedAt: new Date(row.updatedAt),
	}));
}

export async function getMemoryEmbeddings(
	db: SqlExecutor,
	memoryIds: readonly string[],
): Promise<Map<string, number[]>> {
	if (memoryIds.length === 0) {
		return new Map();
	}
	const params = createSqlParams();
	const rows = await db.query<{ id: string; embedding: string }>(
		`SELECT id, embedding::text AS embedding
		FROM mnemocyte_memories
		WHERE id IN (${params.list(memoryIds)})
			AND embedding IS NOT NULL`,
		params.values,
	);
	return new Map(rows.map((row) => [row.id, parseVector(row.embedding)]));
}

export async function vectorSearch(
	db: SqlExecutor,
	input: VectorSearchInput,
): Promise<VectorSearchRow[]> {
	const params = createSqlParams();
	const embedding = `${params.add(formatVector(input.embedding))}::vector`;
	const rawScore = `1 - (embedding <=> ${embedding})`;
	const vectorScore = `CASE
		WHEN ${rawScore} = 'NaN'::double precision
			OR ${rawScore} = 'Infinity'::double precision
			OR ${rawScore} = '-Infinity'::double precision
			THEN 0::double precision
		ELSE GREATEST(0::double precision, LEAST(1::double precision, ${rawScore}))
	END`;
	const filters = recallFilters(params, input);
	const rows = await db.query<RawMemoryRow & { vectorScore: number }>(
		`SELECT ${MEMORY_COLUMNS}, ${vectorScore} AS "vectorScore"
		FROM mnemocyte_memories
		WHERE ${filters}
			AND embedding IS NOT NULL
			AND ${vectorScore} >= ${params.add(input.minVectorScore ?? 0)}
		ORDER BY embedding <=> ${embedding}
		LIMIT ${params.add(input.limit)}`,
		params.values,
	);
	return rows.map((row) => ({
		...toMemoryRow(row),
		vectorScore: row.vectorScore,
	}));
}

export async function lexicalSearch(
	db: SqlExecutor,
	input: LexicalSearchInput,
): Promise<LexicalSearchRow[]> {
	const params = createSqlParams();
	const query = params.add(input.query);
	const filters = recallFilters(params, input);
	const rows = await db.query<RawMemoryRow & { lexicalScore: number }>(
		`SELECT ${MEMORY_COLUMNS},
			ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', ${query})) AS "lexicalScore"
		FROM mnemocyte_memories
		WHERE ${filters}
			AND to_tsvector('english', content) @@ websearch_to_tsquery('english', ${query})
		ORDER BY "lexicalScore" DESC
		LIMIT ${params.add(input.limit)}`,
		params.values,
	);
	return rows.map((row) => ({
		...toMemoryRow(row),
		lexicalScore: row.lexicalScore,
	}));
}
