import type {
	StoreListPosition,
	StoreScope,
	StoreSelector,
	StoreVisibility,
} from "../../memory/store.js";
import type { SqlExecutor } from "../../sql/executor.js";
import type { ImportanceLevel, JsonObject, MemoryKind } from "../../types.js";
import {
	extractPrefixedMemoryRow,
	type MemoryRow,
	type RawMemoryRow,
	selectMemoryColumns,
	toMemoryRow,
	type VectorType,
} from "../rows.js";
import { createSqlParams, type SqlParams } from "../sql.js";
import { formatVector } from "../vector.js";

export interface MemoryFilter {
	visibility: StoreVisibility;
	kinds?: readonly MemoryKind[];
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
	deletedByEntity: Array<{
		namespace: string;
		entityId: string;
		deletedCount: number;
	}>;
}

export interface GlobalMemoryStatsCounts extends MemoryStatsCounts {
	entityCount: number;
}

/** Cosine distance (`<=>`) from the query embedding, as Postgres returns it. */
export type VectorSearchRow = MemoryRow & { vectorDistance: number };

export type LexicalSearchRow = MemoryRow & { lexicalScore: number };

export interface NewMemoryRow {
	id: string;
	scope: StoreScope;
	key: string | null;
	content: string;
	kind: string;
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
 * Rows visible at a scope: the namespace and entity match, and each optional
 * field either matches or, unless the read is exact for that field, is null
 * (shared). A null field in the scope matches only null rows.
 */
function visibilityConditions(
	params: SqlParams,
	visibility: StoreVisibility,
	table?: string,
): string {
	const { scope } = visibility;
	const clauses = [
		`${column(table, "namespace")} = ${params.add(scope.namespace)}`,
		`${column(table, "entity_id")} = ${params.add(scope.entityId)}`,
	];
	for (const [name, value, exact] of [
		["agent_id", scope.agentId, visibility.exactAgent],
		["session_id", scope.sessionId, visibility.exactSession],
	] as const) {
		const qualified = column(table, name);
		if (value === null) {
			clauses.push(`${qualified} IS NULL`);
		} else if (exact) {
			clauses.push(`${qualified} = ${params.add(value)}`);
		} else {
			clauses.push(
				`(${qualified} = ${params.add(value)} OR ${qualified} IS NULL)`,
			);
		}
	}
	return clauses.join(" AND ");
}

/**
 * Rows a bulk operation selects: each field that is set matches exactly, a
 * missing field matches anything, and a null namespace matches every
 * namespace. Shared by memories and audit events, which have the same scope
 * columns. Returns `TRUE` when nothing restricts.
 */
export function selectorConditions(
	params: SqlParams,
	selector: StoreSelector,
	table?: string,
): string {
	const clauses: string[] = [];
	for (const [name, value] of [
		["namespace", selector.namespace],
		["entity_id", selector.entityId],
		["agent_id", selector.agentId],
		["session_id", selector.sessionId],
	] as const) {
		if (value !== undefined && value !== null) {
			clauses.push(`${column(table, name)} = ${params.add(value)}`);
		}
	}
	return clauses.length === 0 ? "TRUE" : clauses.join(" AND ");
}

/** The exact scope, where keys are unique: null fields match null rows. */
function exactScopeConditions(params: SqlParams, scope: StoreScope): string {
	return visibilityConditions(params, {
		scope,
		exactAgent: true,
		exactSession: true,
	});
}

/**
 * Filters shared by the recall queries, as `AND …` clauses for a table without
 * an alias.
 */
function recallFilters(params: SqlParams, input: MemoryFilter): string {
	const clauses: string[] = [visibilityConditions(params, input.visibility)];
	if (!input.includeSuperseded) {
		clauses.push("superseded_by IS NULL");
	}
	if (!input.includeExpired) {
		clauses.push("(expires_at IS NULL OR expires_at > now())");
	}
	if (input.kinds && input.kinds.length > 0) {
		clauses.push(`kind IN (${params.list(input.kinds)})`);
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

/**
 * The unique index on scope + key: an `add` with a key that exists in the
 * exact scope updates that row (`ON CONFLICT … DO UPDATE`).
 */
const SCOPE_KEY_INDEX = "mnemocyte_memories_scope_key_idx";

/** Columns a keyed `add` replaces on an existing row. */
const UPSERT_REPLACED_COLUMNS = [
	"content",
	"kind",
	"importance",
	"tags",
	"source",
	"metadata",
	"confidence",
	"embedding",
	"embedding_model",
	"embedding_dimensions",
	"expires_at",
	"updated_at",
] as const;

/**
 * Insert rows in one statement. A keyed row whose key already exists in its
 * exact scope updates that row instead: the conflict target names the partial
 * unique index's columns and its predicate (`WHERE key IS NOT NULL`), which
 * Postgres needs to infer a partial index as the arbiter. The update keeps
 * `id`, `created_at`, the access counts and the consolidation link, and takes
 * everything else from the new row. `ON CONFLICT DO UPDATE` guarantees an
 * insert or an update for each row even under concurrency. One statement
 * cannot update the same row twice, so callers pass distinct keys.
 */
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
			${params.add(row.key)}::text,
			${params.add(row.content)},
			${params.add(row.kind)},
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
	const replaced = UPSERT_REPLACED_COLUMNS.map(
		(name) => `${name} = EXCLUDED.${name}`,
	).join(", ");
	const result = await db.query<RawMemoryRow>(
		`INSERT INTO mnemocyte_memories (
			id, namespace, entity_id, agent_id, session_id, key, content, kind,
			importance, tags, source, metadata, confidence, embedding,
			embedding_model, embedding_dimensions, superseded_by, superseded_at,
			expires_at, last_accessed_at, access_count, created_at, updated_at
		)
		VALUES ${tuples.join(",\n")}
		ON CONFLICT (namespace, entity_id, agent_id, session_id, key)
			WHERE key IS NOT NULL
			DO UPDATE SET ${replaced}
		RETURNING ${MEMORY_COLUMNS}`,
		params.values,
	);
	return result.map(toMemoryRow);
}

export async function getMemoryById(
	db: SqlExecutor,
	visibility: StoreVisibility,
	memoryId: string,
	signal?: AbortSignal,
): Promise<MemoryRow | null> {
	const params = createSqlParams();
	const rows = await db.query<RawMemoryRow>(
		`SELECT ${MEMORY_COLUMNS}
		FROM mnemocyte_memories
		WHERE ${visibilityConditions(params, visibility)} AND id = ${params.uuid(memoryId)}
		LIMIT 1`,
		params.values,
		signal ? { signal } : undefined,
	);
	const row = rows[0];
	return row ? toMemoryRow(row) : null;
}

export async function getMemoryByKey(
	db: SqlExecutor,
	scope: StoreScope,
	key: string,
	signal?: AbortSignal,
): Promise<MemoryRow | null> {
	const params = createSqlParams();
	const rows = await db.query<RawMemoryRow>(
		`SELECT ${MEMORY_COLUMNS}
		FROM mnemocyte_memories
		WHERE ${exactScopeConditions(params, scope)} AND key = ${params.add(key)}
		LIMIT 1`,
		params.values,
		signal ? { signal } : undefined,
	);
	const row = rows[0];
	return row ? toMemoryRow(row) : null;
}

export interface ListMemoriesInput extends MemoryFilter {
	limit: number;
	position?: StoreListPosition;
}

/** `created_at` at the cursor's precision; see {@link listMemories}. */
const LIST_CREATED_AT =
	"date_trunc('milliseconds', mnemocyte_memories.created_at)";

/**
 * One page of memories, newest first, keyed on `(created_at, id)` with
 * `created_at` truncated to milliseconds, the precision of the cursor: rows
 * written with the column default `now()` carry microseconds, and comparing
 * those with a millisecond cursor could skip rows. The `ORDER BY` names the
 * table's `id`, because the select list's `id::text AS id` would otherwise
 * sort by the text.
 */
export async function listMemories(
	db: SqlExecutor,
	input: ListMemoriesInput,
	signal?: AbortSignal,
): Promise<MemoryRow[]> {
	const params = createSqlParams();
	const clauses = [recallFilters(params, input)];
	if (input.position) {
		clauses.push(
			`(${LIST_CREATED_AT}, mnemocyte_memories.id) < (${params.timestamp(input.position.createdAt)}, ${params.uuid(input.position.id)})`,
		);
	}
	const rows = await db.query<RawMemoryRow>(
		`SELECT ${MEMORY_COLUMNS}
		FROM mnemocyte_memories
		WHERE ${clauses.join("\n\t\t\tAND ")}
		ORDER BY ${LIST_CREATED_AT} DESC, mnemocyte_memories.id DESC
		LIMIT ${params.add(input.limit)}`,
		params.values,
		signal ? { signal } : undefined,
	);
	return rows.map(toMemoryRow);
}

export interface UpdateMemoryInput {
	visibility: StoreVisibility;
	id: string;
	now: Date;
	vectorType: VectorType;
	content?: string;
	embedding?: readonly number[];
	embeddingModel?: string;
	embeddingDimensions?: number;
	key?: string | null;
	kind?: string;
	importance?: string;
	tags?: readonly string[];
	source?: string | null;
	metadata?: JsonObject;
	confidence?: number;
	expiresAt?: Date | null;
}

/** Whether a driver error is a key collision on the scope + key index. */
export function isScopeKeyViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "23505" &&
		"constraint_name" in error &&
		error.constraint_name === SCOPE_KEY_INDEX
	);
}

/**
 * Update one visible memory in one statement and return it, or `null` when
 * no visible row has the id. A new key that collides in the row's scope
 * fails with a unique violation on {@link SCOPE_KEY_INDEX}.
 */
export async function updateMemory(
	db: SqlExecutor,
	input: UpdateMemoryInput,
): Promise<MemoryRow | null> {
	const params = createSqlParams();
	const assignments: string[] = [];
	const set = (name: string, value: string) => {
		assignments.push(`${name} = ${value}`);
	};
	if (input.content !== undefined) {
		set("content", params.add(input.content));
	}
	if (input.embedding !== undefined) {
		set(
			"embedding",
			`${params.add(formatVector(input.embedding))}::${input.vectorType}`,
		);
	}
	if (input.embeddingModel !== undefined) {
		set("embedding_model", params.add(input.embeddingModel));
	}
	if (input.embeddingDimensions !== undefined) {
		set(
			"embedding_dimensions",
			`${params.add(input.embeddingDimensions)}::int`,
		);
	}
	if (input.key !== undefined) {
		set("key", `${params.add(input.key)}::text`);
	}
	if (input.kind !== undefined) {
		set("kind", params.add(input.kind));
	}
	if (input.importance !== undefined) {
		set("importance", params.add(input.importance));
	}
	if (input.tags !== undefined) {
		set("tags", params.textArrayValue(input.tags));
	}
	if (input.source !== undefined) {
		set("source", `${params.add(input.source)}::text`);
	}
	if (input.metadata !== undefined) {
		set("metadata", params.json(input.metadata));
	}
	if (input.confidence !== undefined) {
		set("confidence", `${params.add(input.confidence)}::real`);
	}
	if (input.expiresAt !== undefined) {
		set("expires_at", nullableTimestamp(params, input.expiresAt));
	}
	set("updated_at", params.timestamp(input.now));
	const rows = await db.query<RawMemoryRow>(
		`UPDATE mnemocyte_memories
		SET ${assignments.join(", ")}
		WHERE ${visibilityConditions(params, input.visibility)}
			AND id = ${params.uuid(input.id)}
		RETURNING ${MEMORY_COLUMNS}`,
		params.values,
	);
	const row = rows[0];
	return row ? toMemoryRow(row) : null;
}

export async function getMemoryStatsCounts(
	db: SqlExecutor,
	selector: StoreSelector,
	now: Date,
): Promise<GlobalMemoryStatsCounts> {
	const params = createSqlParams();
	const conditions = selectorConditions(params, selector);
	const columns = memoryStatsCountColumns(params, now);
	const rows = await db.query<GlobalMemoryStatsCounts>(
		`SELECT count(DISTINCT (namespace, entity_id))::int AS "entityCount", ${columns}
		FROM mnemocyte_memories
		WHERE ${conditions}`,
		params.values,
	);
	return rows[0] ?? { entityCount: 0, ...emptyMemoryStatsCounts() };
}

export async function deleteMemory(
	db: SqlExecutor,
	visibility: StoreVisibility,
	memoryId: string,
	signal?: AbortSignal,
): Promise<GuardedDeleteResult> {
	const params = createSqlParams();
	const conditions = `${visibilityConditions(params, visibility)} AND id = ${params.uuid(memoryId)}`;
	return deleteMemoriesWithDependentGuard(db, conditions, params, {
		allowSelectedDependents: false,
		...(signal ? { signal } : {}),
	});
}

/**
 * Delete the selected memories and audit events in one statement. A
 * consolidation link between two selected memories does not block it: both
 * rows go in the same statement, and the `NO ACTION` foreign key is checked
 * at the end of the statement, when neither exists.
 */
export async function deleteScope(
	db: SqlExecutor,
	selector: StoreSelector,
	signal?: AbortSignal,
): Promise<GuardedDeleteResult> {
	const params = createSqlParams();
	const conditions = selectorConditions(params, selector);
	const eventConditions = selectorConditions(params, selector);
	return deleteMemoriesWithDependentGuard(db, conditions, params, {
		allowSelectedDependents: true,
		eventConditions,
		...(signal ? { signal } : {}),
	});
}

export interface PruneFilter {
	selector: StoreSelector;
	expired?: boolean;
	superseded?: boolean;
	createdBefore?: Date;
	notAccessedSince?: Date;
	kinds?: readonly MemoryKind[];
	tags?: readonly string[];
	maxImportanceLevels?: readonly ImportanceLevel[];
}

/** The `WHERE` conditions of a prune. */
function pruneConditions(params: SqlParams, filter: PruneFilter): string {
	const clauses: string[] = [selectorConditions(params, filter.selector)];
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
			`COALESCE(last_accessed_at, created_at) < ${params.timestamp(filter.notAccessedSince)}`,
		);
	}
	if (filter.kinds && filter.kinds.length > 0) {
		clauses.push(`kind IN (${params.list(filter.kinds)})`);
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
	return deleteMemoriesWithDependentGuard(db, conditions, params, {
		allowSelectedDependents: false,
		...(signal ? { signal } : {}),
	});
}

interface DependentGuardOptions {
	/**
	 * `false`: any memory that points at a candidate blocks the delete.
	 * `true`: only one outside the candidates does.
	 */
	allowSelectedDependents: boolean;
	/** Audit events to delete in the same statement, when set. */
	eventConditions?: string;
	signal?: AbortSignal;
}

/**
 * Delete the rows matching `conditions` unless a consolidation dependent
 * blocks it, as one statement: the check and the delete see the same
 * snapshot, and the `superseded_by` foreign key is the backstop for rows
 * written concurrently.
 */
async function deleteMemoriesWithDependentGuard(
	db: SqlExecutor,
	conditions: string,
	params: SqlParams,
	options: DependentGuardOptions,
): Promise<GuardedDeleteResult> {
	const outsideOnly = options.allowSelectedDependents
		? "\n\t\t\tWHERE dependent.id NOT IN (SELECT id FROM candidates)"
		: "";
	const deleteEvents =
		options.eventConditions === undefined
			? ""
			: `,
		deleted_events AS (
			DELETE FROM mnemocyte_events
			WHERE ${options.eventConditions}
				AND NOT EXISTS (SELECT 1 FROM dependents)
		)`;
	const rows = await db.query<{
		matchedCount: number | string;
		deletedCount: number | string;
		hasDependents: boolean;
		namespace: string | null;
		entityId: string | null;
		entityDeletedCount: number | string | null;
	}>(
		`WITH candidates AS MATERIALIZED (
			SELECT id, namespace, entity_id
			FROM mnemocyte_memories
			WHERE ${conditions}
		),
		dependents AS MATERIALIZED (
			SELECT 1
			FROM mnemocyte_memories AS dependent
			INNER JOIN candidates AS target
				ON dependent.superseded_by = target.id${outsideOnly}
			LIMIT 1
		),
		deleted AS (
			DELETE FROM mnemocyte_memories
			WHERE id IN (SELECT id FROM candidates)
				AND NOT EXISTS (SELECT 1 FROM dependents)
			RETURNING id, namespace, entity_id
		)${deleteEvents},
		deleted_counts AS (
			SELECT namespace, entity_id, count(*)::int AS deleted_count
			FROM deleted
			GROUP BY namespace, entity_id
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
			deleted_counts.namespace AS "namespace",
			deleted_counts.entity_id AS "entityId",
			deleted_counts.deleted_count AS "entityDeletedCount"
		FROM summary
		LEFT JOIN deleted_counts ON true
		ORDER BY deleted_counts.namespace, deleted_counts.entity_id`,
		params.values,
		options.signal ? { signal: options.signal } : undefined,
	);
	const row = rows[0];
	return {
		matchedCount: Number(row?.matchedCount ?? 0),
		deletedCount: Number(row?.deletedCount ?? 0),
		hasDependents: row?.hasDependents === true,
		deletedByEntity: rows.flatMap((detail) =>
			detail.entityId === null || detail.namespace === null
				? []
				: [
						{
							namespace: detail.namespace,
							entityId: detail.entityId,
							deletedCount: Number(detail.entityDeletedCount ?? 0),
						},
					],
		),
	};
}

export interface DuplicateSearchInput {
	visibility: StoreVisibility;
	threshold: number;
	limit: number;
	kinds?: readonly string[];
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
		visibilityConditions(params, input.visibility, "a"),
		visibilityConditions(params, input.visibility, "b"),
	];
	if (!input.includeSuperseded) {
		clauses.push("a.superseded_by IS NULL AND b.superseded_by IS NULL");
	}
	if (!input.includeExpired) {
		clauses.push(
			"(a.expires_at IS NULL OR a.expires_at > now()) AND (b.expires_at IS NULL OR b.expires_at > now())",
		);
	}
	if (input.kinds && input.kinds.length > 0) {
		const kinds = params.list(input.kinds);
		clauses.push(`a.kind IN (${kinds}) AND b.kind IN (${kinds})`);
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
	visibility: StoreVisibility,
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
		WHERE ${visibilityConditions(params, visibility)}
			AND id IN (${params.uuidList(ids)})`,
		params.values,
		signal ? { signal } : undefined,
	);
}

export interface ConsolidateMemoriesInput {
	visibility: StoreVisibility;
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
	const scope = visibilityConditions(params, input.visibility);
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
					${params.add(input.visibility.scope.namespace)},
					${params.add(input.visibility.scope.entityId)},
					${params.add(input.visibility.scope.agentId)}::text,
					${params.add(input.visibility.scope.sessionId)}::text,
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

/**
 * Rows are locked in id order before the update, so two recalls with
 * overlapping results take their row locks in the same order and cannot
 * deadlock. Rows deleted in the meantime are skipped, and `updated_at` is
 * left alone.
 */
export async function markMemoriesAccessed(
	db: SqlExecutor,
	visibility: StoreVisibility,
	memoryIds: readonly string[],
): Promise<void> {
	if (memoryIds.length === 0) {
		return;
	}
	const params = createSqlParams();
	await db.query(
		`WITH target AS (
			SELECT id
			FROM mnemocyte_memories
			WHERE ${visibilityConditions(params, visibility)}
				AND id IN (${params.uuidList(memoryIds)})
			ORDER BY id
			FOR UPDATE
		)
		UPDATE mnemocyte_memories AS m
		SET last_accessed_at = ${params.timestamp(new Date())}, access_count = m.access_count + 1
		FROM target
		WHERE m.id = target.id`,
		params.values,
	);
}

/** pgvector's default and largest `hnsw.ef_search` (`src/hnsw.h`). */
const HNSW_DEFAULT_EF_SEARCH = 40;
const HNSW_MAX_EF_SEARCH = 1000;

/**
 * `hnsw.ef_search` for a vector search returning `limit` rows: at least the
 * row count, so one HNSW pass can fill it, within pgvector's 1–1000 range.
 */
export function hnswEfSearch(limit: number): number {
	return Math.min(
		HNSW_MAX_EF_SEARCH,
		Math.max(HNSW_DEFAULT_EF_SEARCH, Math.ceil(limit)),
	);
}

/**
 * The nearest `limit` rows that pass the recall filters, by cosine distance.
 *
 * The HNSW index returns its `ef_search` nearest rows before the filters run,
 * so a selective filter could leave fewer rows than exist. The query runs in a
 * transaction that first sets, for that transaction only,
 * `hnsw.iterative_scan = strict_order` (pgvector 0.8+: keep scanning the
 * index, in exact distance order, until `limit` rows pass or
 * `hnsw.max_scan_tuples` is reached) and `hnsw.ef_search` from
 * {@link hnswEfSearch}. Called inside a caller's transaction, the settings last
 * until that transaction ends.
 *
 * The distance is computed once per row: `ORDER BY` names the selected
 * `<=>` column, which the planner still matches to the index's ordering
 * operator.
 */
export async function vectorSearch(
	db: SqlExecutor,
	input: VectorSearchInput,
): Promise<VectorSearchRow[]> {
	const params = createSqlParams();
	const embedding = `${params.add(formatVector(input.embedding))}::${input.vectorType}`;
	const filters = recallFilters(params, input);
	const text = `SELECT ${MEMORY_COLUMNS}, embedding <=> ${embedding} AS "vectorDistance"
		FROM mnemocyte_memories
		WHERE ${filters}
			AND embedding IS NOT NULL
		ORDER BY "vectorDistance"
		LIMIT ${params.add(input.limit)}`;
	const rows = await db.transaction(async (tx) => {
		await tx.query(
			`SELECT set_config('hnsw.iterative_scan', 'strict_order', true),
				set_config('hnsw.ef_search', $1, true)`,
			[String(hnswEfSearch(input.limit))],
		);
		return tx.query<RawMemoryRow & { vectorDistance: number | string }>(
			text,
			params.values,
		);
	});
	return rows.map((row) => ({
		...toMemoryRow(row),
		// Drivers may return float8 as a number or as text.
		vectorDistance: Number(row.vectorDistance),
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
		ORDER BY "lexicalScore" DESC, id
		LIMIT ${params.add(input.limit)}`,
		params.values,
	);
	return rows.map((row) => ({
		...toMemoryRow(row),
		lexicalScore: row.lexicalScore,
	}));
}
