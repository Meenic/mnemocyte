import type { StoreScope } from "../../memory/store.js";
import type { SqlExecutor } from "../../sql/executor.js";
import type { ImportanceLevel, MemoryType } from "../../types.js";
import {
	extractPrefixedMemoryRow,
	type MemoryRow,
	type RawMemoryRow,
	selectMemoryColumns,
	toMemoryRow,
	type VectorType,
} from "../rows.js";
import { createSqlParams, type SqlParams } from "../sql.js";
import { formatVector, parseVector } from "../vector.js";

export interface MemoryFilter {
	scope: StoreScope;
	types?: readonly MemoryType[];
	tags?: readonly string[];
	before?: Date;
	after?: Date;
	includeSuperseded?: boolean;
	includeExpired?: boolean;
}

export interface VectorSearchInput extends MemoryFilter {
	embedding: readonly number[];
	vectorType: VectorType;
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
	scope: StoreScope;
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

function column(table: string | undefined, name: string): string {
	return table ? `${table}.${name}` : name;
}

/**
 * Rows visible at `scope`: the namespace and entity match, and each optional
 * field either matches or is null (shared). A null field in the scope matches
 * only shared rows.
 */
function scopeConditions(
	params: SqlParams,
	scope: StoreScope,
	table?: string,
): string {
	const clauses = [
		`${column(table, "namespace")} = ${params.add(scope.namespace)}`,
		`${column(table, "entity_id")} = ${params.add(scope.entityId)}`,
	];
	for (const [name, value] of [
		["agent_id", scope.agentId],
		["session_id", scope.sessionId],
	] as const) {
		const qualified = column(table, name);
		clauses.push(
			value === null
				? `${qualified} IS NULL`
				: `(${qualified} = ${params.add(value)} OR ${qualified} IS NULL)`,
		);
	}
	return clauses.join(" AND ");
}

/**
 * Every row about the entity, across agents and sessions. Used by deletes, so
 * erasing an entity never leaves agent- or session-held rows behind.
 */
function entityConditions(params: SqlParams, scope: StoreScope): string {
	return `namespace = ${params.add(scope.namespace)} AND entity_id = ${params.add(scope.entityId)}`;
}

/**
 * Filters shared by the recall queries, as `AND …` clauses for a table without
 * an alias.
 */
function recallFilters(params: SqlParams, input: MemoryFilter): string {
	const clauses: string[] = [scopeConditions(params, input.scope)];
	if (!input.includeSuperseded) {
		clauses.push("superseded_by IS NULL");
	}
	if (!input.includeExpired) {
		clauses.push("(expires_at IS NULL OR expires_at > now())");
	}
	if (input.types && input.types.length > 0) {
		clauses.push(`kind IN (${params.list(input.types)})`);
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
	vectorType: VectorType,
): Promise<MemoryRow[]> {
	if (rows.length === 0) {
		return [];
	}
	const params = createSqlParams();
	const tuples = rows.map(
		(row) => `(
			${params.uuid(row.id)},
			${params.add(row.scope.namespace)},
			${params.add(row.scope.entityId)},
			${params.add(row.scope.agentId)}::text,
			${params.add(row.scope.sessionId)}::text,
			${params.add(row.content)},
			${params.add(row.type)},
			${params.add(row.importance)},
			${params.textArrayValue(row.tags)},
			${params.add(row.source)}::text,
			${params.json(row.metadata)},
			${params.add(row.confidence)}::real,
			${params.add(formatVector(row.embedding))}::${vectorType},
			${params.add(row.embeddingModel)},
			${params.add(row.embeddingDimensions)}::int,
			${params.add(row.supersededBy)}::uuid,
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
			id, namespace, entity_id, agent_id, session_id, content, kind,
			importance, tags, source, metadata, confidence, embedding,
			embedding_model, embedding_dimensions, superseded_by, superseded_at,
			expires_at, last_accessed_at, access_count, created_at, updated_at
		)
		VALUES ${tuples.join(",\n")}
		RETURNING ${MEMORY_COLUMNS}`,
		params.values,
	);
	return result.map(toMemoryRow);
}

export async function getMemoryById(
	db: SqlExecutor,
	scope: StoreScope,
	memoryId: string,
	signal?: AbortSignal,
): Promise<MemoryRow | null> {
	const params = createSqlParams();
	const rows = await db.query<RawMemoryRow>(
		`SELECT ${MEMORY_COLUMNS}
		FROM mnemocyte_memories
		WHERE ${scopeConditions(params, scope)} AND id = ${params.uuid(memoryId)}
		LIMIT 1`,
		params.values,
		signal ? { signal } : undefined,
	);
	const row = rows[0];
	return row ? toMemoryRow(row) : null;
}

export async function getEntityMemoryStatsCounts(
	db: SqlExecutor,
	scope: StoreScope,
	now: Date,
): Promise<MemoryStatsCounts> {
	const params = createSqlParams();
	const columns = memoryStatsCountColumns(params, now);
	const rows = await db.query<MemoryStatsCounts>(
		`SELECT ${columns}
		FROM mnemocyte_memories
		WHERE ${entityConditions(params, scope)}`,
		params.values,
	);
	return rows[0] ?? emptyMemoryStatsCounts();
}

export async function getGlobalMemoryStatsCounts(
	db: SqlExecutor,
	namespace: string,
	now: Date,
): Promise<GlobalMemoryStatsCounts> {
	const params = createSqlParams();
	const columns = memoryStatsCountColumns(params, now);
	const rows = await db.query<GlobalMemoryStatsCounts>(
		`SELECT count(DISTINCT entity_id)::int AS "entityCount", ${columns}
		FROM mnemocyte_memories
		WHERE namespace = ${params.add(namespace)}`,
		params.values,
	);
	return rows[0] ?? { entityCount: 0, ...emptyMemoryStatsCounts() };
}

export async function deleteMemory(
	db: SqlExecutor,
	scope: StoreScope,
	memoryId: string,
): Promise<GuardedDeleteResult> {
	const params = createSqlParams();
	const conditions = `${entityConditions(params, scope)} AND id = ${params.uuid(memoryId)}`;
	return deleteMemoriesWithDependentGuard(db, conditions, params);
}

export async function deleteMemoriesForEntity(
	db: SqlExecutor,
	scope: StoreScope,
): Promise<GuardedDeleteResult> {
	const params = createSqlParams();
	return deleteMemoriesWithDependentGuard(
		db,
		entityConditions(params, scope),
		params,
	);
}

export interface PruneFilter {
	namespace: string;
	entityId?: string;
	expired?: boolean;
	superseded?: boolean;
	createdBefore?: Date;
	notAccessedSince?: Date;
	types?: readonly MemoryType[];
	tags?: readonly string[];
	maxImportanceLevels?: readonly ImportanceLevel[];
}

/** The `WHERE` conditions of a prune. Always limited to one namespace. */
function pruneConditions(params: SqlParams, filter: PruneFilter): string {
	const clauses: string[] = [`namespace = ${params.add(filter.namespace)}`];
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
		clauses.push(`kind IN (${params.list(filter.types)})`);
	}
	if (filter.tags && filter.tags.length > 0) {
		clauses.push(`tags @> ${params.textArray(filter.tags)}`);
	}
	if (filter.maxImportanceLevels && filter.maxImportanceLevels.length > 0) {
		clauses.push(`importance IN (${params.list(filter.maxImportanceLevels)})`);
	}
	return clauses.join(" AND ");
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
		WHERE ${conditions}`,
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
	conditions: string,
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
			WHERE ${conditions}
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
	scope: StoreScope;
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
	const clauses: string[] = [
		scopeConditions(params, input.scope, "a"),
		scopeConditions(params, input.scope, "b"),
	];
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
		clauses.push(`a.kind IN (${types}) AND b.kind IN (${types})`);
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
			ON a.id < b.id
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

export async function loadConsolidationTargets(
	db: SqlExecutor,
	scope: StoreScope,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<Array<{ id: string; tags: string[]; supersededBy: string | null }>> {
	if (ids.length === 0) {
		return [];
	}
	const params = createSqlParams();
	return db.query(
		`SELECT id::text AS id, tags, superseded_by::text AS "supersededBy"
		FROM mnemocyte_memories
		WHERE ${scopeConditions(params, scope)}
			AND id IN (${params.uuidList(ids)})`,
		params.values,
		signal ? { signal } : undefined,
	);
}

export interface ConsolidateMemoriesInput {
	scope: StoreScope;
	survivorId: string;
	supersededIds: readonly string[];
	mergeTags: boolean;
	now: Date;
	/** One pre-generated id per requested loser; `undefined` skips the audit. */
	auditEventIds?: readonly string[];
}

export interface ConsolidateMemoriesResult {
	survivorActive: boolean;
	hasConflict: boolean;
	/** Newly superseded ids, in request order. */
	supersededIds: string[];
}

/**
 * Consolidation as one statement, so it needs no interactive transaction.
 *
 * `locked` takes row locks on the survivor and the requested losers in id
 * order; under READ COMMITTED a `FOR UPDATE` returns each row's latest
 * committed version. Every later step reads from it, so the checks and the
 * writes see the same rows. Sub-statements of one `WITH` share a snapshot and
 * cannot see each other's writes, which is why the tag merge reads the losers
 * from `superseded`'s `RETURNING` rather than from the table. When the
 * survivor is gone or superseded, or a loser belongs to another survivor,
 * nothing is written and the flags say why.
 */
export async function consolidateMemories(
	db: SqlExecutor,
	input: ConsolidateMemoriesInput,
	signal?: AbortSignal,
): Promise<ConsolidateMemoriesResult> {
	const params = createSqlParams();
	const requested = params.jsonArrayRows(input.supersededIds);
	const scope = scopeConditions(params, input.scope);
	const survivorId = params.uuid(input.survivorId);
	const now = params.timestamp(input.now);
	const ctes = [
		`requested AS (
			SELECT element::uuid AS id, position
			FROM ${requested}
		)`,
		`locked AS MATERIALIZED (
			SELECT id, tags, superseded_by
			FROM mnemocyte_memories
			WHERE ${scope}
				AND (id = ${survivorId} OR id IN (SELECT id FROM requested))
			ORDER BY id
			FOR UPDATE
		)`,
		`survivor AS (
			SELECT id, tags
			FROM locked
			WHERE id = ${survivorId} AND superseded_by IS NULL
		)`,
		`conflict AS (
			SELECT 1
			FROM locked
			WHERE id <> ${survivorId}
				AND superseded_by IS NOT NULL
				AND superseded_by <> ${survivorId}
			LIMIT 1
		)`,
		`allowed AS (
			SELECT EXISTS (SELECT 1 FROM survivor)
				AND NOT EXISTS (SELECT 1 FROM conflict) AS ok
		)`,
		`superseded AS (
			UPDATE mnemocyte_memories AS memory
			SET superseded_by = ${survivorId}, superseded_at = ${now}, updated_at = ${now}
			FROM locked
			WHERE memory.id = locked.id
				AND locked.id <> ${survivorId}
				AND locked.superseded_by IS NULL
				AND (SELECT ok FROM allowed)
			RETURNING memory.id, memory.tags
		)`,
		`ordered AS (
			SELECT superseded.id, superseded.tags, requested.position
			FROM superseded
			INNER JOIN requested ON requested.id = superseded.id
		)`,
	];
	if (input.mergeTags) {
		ctes.push(
			`merged AS (
				SELECT array_agg(tag ORDER BY grp, owner, position) AS tags
				FROM (
					SELECT DISTINCT ON (tag) tag, grp, owner, position
					FROM (
						SELECT t.tag, 0 AS grp, 0::bigint AS owner, t.position
						FROM survivor, unnest(survivor.tags) WITH ORDINALITY AS t(tag, position)
						UNION ALL
						SELECT t.tag, 1, ordered.position, t.position
						FROM ordered, unnest(ordered.tags) WITH ORDINALITY AS t(tag, position)
					) AS candidates
					ORDER BY tag, grp, owner, position
				) AS first_occurrences
			)`,
			`tags_updated AS (
				UPDATE mnemocyte_memories AS memory
				SET tags = merged.tags, updated_at = ${now}
				FROM survivor, merged
				WHERE memory.id = survivor.id
					AND cardinality(merged.tags) > cardinality(survivor.tags)
				RETURNING memory.id
			)`,
		);
	}
	if (input.auditEventIds !== undefined) {
		const eventIds = params.jsonArrayRows(input.auditEventIds);
		ctes.push(
			`event_ids AS (
				SELECT element::uuid AS id, position
				FROM ${eventIds}
			)`,
			`audit AS (
				INSERT INTO mnemocyte_events (
					id, namespace, entity_id, agent_id, session_id, description,
					metadata, timestamp
				)
				SELECT
					event_ids.id,
					${params.add(input.scope.namespace)},
					${params.add(input.scope.entityId)},
					${params.add(input.scope.agentId)}::text,
					${params.add(input.scope.sessionId)}::text,
					'memory.superseded',
					jsonb_build_object(
						'memoryId', numbered.id::text,
						'supersededBy', ${params.add(input.survivorId)}::text
					),
					${now}
				FROM (
					SELECT id, row_number() OVER (ORDER BY position) AS position
					FROM ordered
				) AS numbered
				INNER JOIN event_ids ON event_ids.position = numbered.position
				RETURNING id
			)`,
		);
	}
	const rows = await db.query<{
		survivorActive: boolean;
		hasConflict: boolean;
		supersededIds: string;
	}>(
		`WITH ${ctes.join(",\n\t\t")}
		SELECT
			EXISTS (SELECT 1 FROM survivor) AS "survivorActive",
			EXISTS (SELECT 1 FROM conflict) AS "hasConflict",
			COALESCE(
				(SELECT jsonb_agg(id::text ORDER BY position) FROM ordered),
				'[]'::jsonb
			)::text AS "supersededIds"`,
		params.values,
		signal ? { signal } : undefined,
	);
	const row = rows[0];
	return {
		survivorActive: row?.survivorActive === true,
		hasConflict: row?.hasConflict === true,
		// The column is a `jsonb_agg` of text ids, read back as text.
		supersededIds: row ? (JSON.parse(row.supersededIds) as string[]) : [],
	};
}

export async function markMemoriesAccessed(
	db: SqlExecutor,
	scope: StoreScope,
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
		WHERE ${scopeConditions(params, scope)}
			AND id IN (${params.uuidList(memoryIds)})
		RETURNING id::text AS id, last_accessed_at AS "lastAccessedAt", access_count AS "accessCount", updated_at AS "updatedAt"`,
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
	scope: StoreScope,
	memoryIds: readonly string[],
): Promise<Map<string, number[]>> {
	if (memoryIds.length === 0) {
		return new Map();
	}
	const params = createSqlParams();
	const rows = await db.query<{ id: string; embedding: string }>(
		`SELECT id::text AS id, embedding::text AS embedding
		FROM mnemocyte_memories
		WHERE ${scopeConditions(params, scope)}
			AND id IN (${params.uuidList(memoryIds)})
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
	const embedding = `${params.add(formatVector(input.embedding))}::${input.vectorType}`;
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
	const query = `websearch_to_tsquery('english', ${params.add(input.query)})`;
	const filters = recallFilters(params, input);
	const rows = await db.query<RawMemoryRow & { lexicalScore: number }>(
		`SELECT ${MEMORY_COLUMNS}, ts_rank(content_tsv, ${query}) AS "lexicalScore"
		FROM mnemocyte_memories
		WHERE ${filters}
			AND content_tsv @@ ${query}
		ORDER BY "lexicalScore" DESC
		LIMIT ${params.add(input.limit)}`,
		params.values,
	);
	return rows.map((row) => ({
		...toMemoryRow(row),
		lexicalScore: row.lexicalScore,
	}));
}
