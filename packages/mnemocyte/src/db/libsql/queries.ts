import type {
	StoreAuditPosition,
	StoreListPosition,
	StoreScope,
	StoreSelector,
	StoreVisibility,
} from "../../memory/store.js";
import type {
	DependentsPolicy,
	ImportanceLevel,
	JsonObject,
	MemoryKind,
} from "../../types.js";
import { chunk, INSERT_CHUNK_ROWS } from "../atomic.js";
import type { NewMemoryRow } from "../queries/memories.js";
import type { EventRow, MemoryRow } from "../rows.js";
import type { LibsqlExecutor, LibsqlStatement } from "./executor.js";
import {
	createLibsqlParams,
	LIBSQL_EVENT_COLUMNS,
	LIBSQL_SCOPE_KEY_INDEX,
	type LibsqlParams,
	libsqlMemoryColumns,
	positionMillis,
	positionTimestamp,
	sqlUuidV7,
	LIBSQL_TABLES as T,
	toEmbedding,
	toLibsqlEventRow,
	toLibsqlMemoryRow,
	toNumber,
} from "./sql.js";

const MEMORY_COLUMNS = libsqlMemoryColumns();

const EVENT_INSERT_COLUMNS =
	'"id", "namespace", "entity_id", "agent_id", "session_id", "description", "metadata", "timestamp"';

function column(table: string | undefined, name: string): string {
	return table ? `${table}."${name}"` : `"${name}"`;
}

function statement(params: LibsqlParams, sql: string): LibsqlStatement {
	return { sql, args: params.values };
}

/**
 * Rows visible at a scope, as in the Postgres store: namespace and entity
 * match, and each optional field matches or, unless the read is exact for
 * it, is null (shared). A null field in the scope matches only null rows.
 */
function visibilityConditions(
	params: LibsqlParams,
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
 * Rows a bulk operation selects: set fields match exactly, missing ones
 * match anything, a null namespace matches every namespace. `1` when
 * nothing restricts.
 */
function selectorConditions(
	params: LibsqlParams,
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
	return clauses.length === 0 ? "1" : clauses.join(" AND ");
}

function exactScopeConditions(params: LibsqlParams, scope: StoreScope): string {
	return visibilityConditions(params, {
		scope,
		exactAgent: true,
		exactSession: true,
	});
}

/** Every tag present: `tags` is a JSON array of strings. */
function tagConditions(
	params: LibsqlParams,
	tags: readonly string[],
	table?: string,
): string[] {
	return tags.map(
		(tag) =>
			`EXISTS (SELECT 1 FROM json_each(${column(table, "tags")}) WHERE json_each.value = ${params.add(tag)})`,
	);
}

export interface LibsqlMemoryFilter {
	visibility: StoreVisibility;
	kinds?: readonly MemoryKind[];
	tags?: readonly string[];
	createdBefore?: Date;
	createdAfter?: Date;
	includeSuperseded?: boolean;
	includeExpired?: boolean;
}

/**
 * The recall filters. `now` is the client's clock, which wrote every
 * timestamp; the columns hold Unix milliseconds, the precision of a `Date`,
 * so `createdAfter` needs none of the Postgres store's rounding.
 */
function recallFilters(
	params: LibsqlParams,
	input: LibsqlMemoryFilter,
	now: Date,
	table?: string,
): string {
	const clauses: string[] = [
		visibilityConditions(params, input.visibility, table),
	];
	if (!input.includeSuperseded) {
		clauses.push(`${column(table, "superseded_by")} IS NULL`);
	}
	if (!input.includeExpired) {
		const expires = column(table, "expires_at");
		clauses.push(`(${expires} IS NULL OR ${expires} > ${params.time(now)})`);
	}
	if (input.kinds && input.kinds.length > 0) {
		clauses.push(`${column(table, "kind")} IN (${params.list(input.kinds)})`);
	}
	if (input.tags && input.tags.length > 0) {
		clauses.push(...tagConditions(params, input.tags, table));
	}
	if (input.createdBefore) {
		clauses.push(
			`${column(table, "created_at")} < ${params.time(input.createdBefore)}`,
		);
	}
	if (input.createdAfter) {
		clauses.push(
			`${column(table, "created_at")} > ${params.time(input.createdAfter)}`,
		);
	}
	return clauses.join(" AND ");
}

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
 * The conflict target of a keyed insert: the unique expression index on
 * scope + key, where a null agent or session is `''`, a value scope fields
 * cannot hold (they are non-empty). SQLite has no `NULLS NOT DISTINCT`.
 */
const SCOPE_KEY_TARGET = `("namespace", "entity_id", ifnull("agent_id", ''), ifnull("session_id", ''), "key") WHERE "key" IS NOT NULL`;

function insertStatement(rows: readonly NewMemoryRow[]): LibsqlStatement {
	const params = createLibsqlParams();
	const tuples = rows.map(
		(row) =>
			`(${[
				params.add(row.id),
				params.add(row.scope.namespace),
				params.add(row.scope.entityId),
				params.add(row.scope.agentId),
				params.add(row.scope.sessionId),
				params.add(row.key),
				params.add(row.content),
				params.add(row.kind),
				params.add(row.importance),
				params.json(row.tags),
				params.add(row.source),
				params.json(row.metadata),
				params.add(row.confidence),
				params.vector(row.embedding),
				params.add(row.embeddingModel),
				params.add(row.embeddingDimensions),
				params.add(row.supersededBy),
				params.nullableTime(row.supersededAt),
				params.nullableTime(row.expiresAt),
				params.nullableTime(row.lastAccessedAt),
				params.add(row.accessCount),
				params.time(row.createdAt),
				params.time(row.updatedAt),
			].join(", ")})`,
	);
	const replaced = UPSERT_REPLACED_COLUMNS.map(
		(name) => `"${name}" = excluded."${name}"`,
	).join(", ");
	return statement(
		params,
		`INSERT INTO ${T.memories} (
			"id", "namespace", "entity_id", "agent_id", "session_id", "key", "content",
			"kind", "importance", "tags", "source", "metadata", "confidence",
			"embedding", "embedding_model", "embedding_dimensions", "superseded_by",
			"superseded_at", "expires_at", "last_accessed_at", "access_count",
			"created_at", "updated_at"
		)
		VALUES ${tuples.join(",\n")}
		ON CONFLICT ${SCOPE_KEY_TARGET} DO UPDATE SET ${replaced}
		RETURNING ${MEMORY_COLUMNS}`,
	);
}

/**
 * The audit events of an insert chunk, written before it in the same batch:
 * `memory.updated` with the existing memory's id when a keyed row's key is
 * already used in its exact scope (the insert then updates that row),
 * `memory.created` otherwise. The payload matches the Postgres store's.
 */
function insertAuditStatement(
	rows: readonly NewMemoryRow[],
	eventIds: readonly string[],
): LibsqlStatement {
	const params = createLibsqlParams();
	const prepared = params.json(
		rows.map((row, index) => ({
			id: row.id,
			event_id: eventIds[index],
			namespace: row.scope.namespace,
			entity_id: row.scope.entityId,
			agent_id: row.scope.agentId,
			session_id: row.scope.sessionId,
			key: row.key,
			kind: row.kind,
			importance: row.importance,
			updated_at: row.updatedAt.getTime(),
		})),
	);
	return statement(
		params,
		`INSERT INTO ${T.events} (${EVENT_INSERT_COLUMNS})
		SELECT
			p.event_id, p.namespace, p.entity_id, p.agent_id, p.session_id,
			CASE WHEN existing.id IS NULL THEN 'memory.created' ELSE 'memory.updated' END,
			CASE WHEN p.key IS NULL
				THEN json_object('memoryId', coalesce(existing.id, p.id), 'kind', p.kind, 'importance', p.importance)
				ELSE json_object('memoryId', coalesce(existing.id, p.id), 'kind', p.kind, 'importance', p.importance, 'key', p.key)
			END,
			p.updated_at
		FROM (
			SELECT
				json_extract(value, '$.id') AS id,
				json_extract(value, '$.event_id') AS event_id,
				json_extract(value, '$.namespace') AS namespace,
				json_extract(value, '$.entity_id') AS entity_id,
				json_extract(value, '$.agent_id') AS agent_id,
				json_extract(value, '$.session_id') AS session_id,
				json_extract(value, '$.key') AS key,
				json_extract(value, '$.kind') AS kind,
				json_extract(value, '$.importance') AS importance,
				json_extract(value, '$.updated_at') AS updated_at
			FROM json_each(${prepared})
		) AS p
		LEFT JOIN ${T.memories} AS existing
			ON p.key IS NOT NULL
			AND existing."key" = p.key
			AND existing."namespace" = p.namespace
			AND existing."entity_id" = p.entity_id
			AND existing."agent_id" IS p.agent_id
			AND existing."session_id" IS p.session_id`,
	);
}

/**
 * Insert rows in chunks of {@link INSERT_CHUNK_ROWS}, in one write batch,
 * so every chunk and its audit events commit together or not at all. A
 * keyed row whose key exists in its exact scope updates that row (`ON
 * CONFLICT … DO UPDATE`), keeping its id, creation time, access counts and
 * consolidation link.
 */
export async function insertLibsqlMemories(
	db: LibsqlExecutor,
	rows: readonly NewMemoryRow[],
	eventIds: readonly string[] | undefined,
	signal?: AbortSignal,
): Promise<MemoryRow[]> {
	if (rows.length === 0) {
		return [];
	}
	const rowChunks = chunk(rows, INSERT_CHUNK_ROWS);
	const idChunks =
		eventIds === undefined ? undefined : chunk(eventIds, INSERT_CHUNK_ROWS);
	const statements: LibsqlStatement[] = [];
	const insertIndexes: number[] = [];
	rowChunks.forEach((part, index) => {
		const ids = idChunks?.[index];
		if (ids !== undefined) {
			statements.push(insertAuditStatement(part, ids));
		}
		insertIndexes.push(statements.length);
		statements.push(insertStatement(part));
	});
	const results = await db.batch(statements, "write", signal);
	return insertIndexes.flatMap((index) =>
		(results[index] ?? []).map((row) => toLibsqlMemoryRow(row)),
	);
}

export async function getLibsqlMemoriesByIds(
	db: LibsqlExecutor,
	visibility: StoreVisibility,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<MemoryRow[]> {
	if (ids.length === 0) {
		return [];
	}
	const params = createLibsqlParams();
	const rows = await db.execute(
		statement(
			params,
			`SELECT ${MEMORY_COLUMNS} FROM ${T.memories}
			WHERE ${visibilityConditions(params, visibility)} AND "id" IN (${params.list(ids)})`,
		),
		signal,
	);
	return rows.map((row) => toLibsqlMemoryRow(row));
}

export async function getLibsqlMemoryByKey(
	db: LibsqlExecutor,
	scope: StoreScope,
	key: string,
	signal?: AbortSignal,
): Promise<MemoryRow | null> {
	const params = createLibsqlParams();
	const rows = await db.execute(
		statement(
			params,
			`SELECT ${MEMORY_COLUMNS} FROM ${T.memories}
			WHERE ${exactScopeConditions(params, scope)} AND "key" = ${params.add(key)}
			LIMIT 1`,
		),
		signal,
	);
	const row = rows[0];
	return row ? toLibsqlMemoryRow(row) : null;
}

export interface LibsqlListInput extends LibsqlMemoryFilter {
	limit: number;
	position?: StoreListPosition;
}

/** One page, newest first by `(created_at, id)`, after `position`. */
export async function listLibsqlMemories(
	db: LibsqlExecutor,
	input: LibsqlListInput,
	now: Date,
	signal?: AbortSignal,
): Promise<MemoryRow[]> {
	const params = createLibsqlParams();
	const clauses = [recallFilters(params, input, now)];
	if (input.position) {
		clauses.push(
			`("created_at", "id") < (${params.time(input.position.createdAt)}, ${params.add(input.position.id.toLowerCase())})`,
		);
	}
	const rows = await db.execute(
		statement(
			params,
			`SELECT ${MEMORY_COLUMNS} FROM ${T.memories}
			WHERE ${clauses.join(" AND ")}
			ORDER BY "created_at" DESC, "id" DESC
			LIMIT ${params.add(input.limit)}`,
		),
		signal,
	);
	return rows.map((row) => toLibsqlMemoryRow(row));
}

export interface LibsqlUpdateInput {
	visibility: StoreVisibility;
	id: string;
	now: Date;
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
	audit?: { eventId: string; fields: readonly string[] };
}

/** Whether a driver error is a key collision on the scope + key index. */
export function isLibsqlScopeKeyViolation(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof error.message === "string" &&
		error.message.includes("UNIQUE constraint failed") &&
		error.message.includes(LIBSQL_SCOPE_KEY_INDEX)
	);
}

/**
 * Update one visible memory and return it, or `null`. With `audit`, the
 * event is written by a second statement in the same write batch, which
 * selects the updated row with the same conditions, so it is written
 * exactly when the update matched.
 */
export async function updateLibsqlMemory(
	db: LibsqlExecutor,
	input: LibsqlUpdateInput,
): Promise<MemoryRow | null> {
	const params = createLibsqlParams();
	const assignments: string[] = [];
	const set = (name: string, value: string) => {
		assignments.push(`"${name}" = ${value}`);
	};
	if (input.content !== undefined) {
		set("content", params.add(input.content));
	}
	if (input.embedding !== undefined) {
		set("embedding", params.vector(input.embedding));
	}
	if (input.embeddingModel !== undefined) {
		set("embedding_model", params.add(input.embeddingModel));
	}
	if (input.embeddingDimensions !== undefined) {
		set("embedding_dimensions", params.add(input.embeddingDimensions));
	}
	if (input.key !== undefined) {
		set("key", params.add(input.key));
	}
	if (input.kind !== undefined) {
		set("kind", params.add(input.kind));
	}
	if (input.importance !== undefined) {
		set("importance", params.add(input.importance));
	}
	if (input.tags !== undefined) {
		set("tags", params.json(input.tags));
	}
	if (input.source !== undefined) {
		set("source", params.add(input.source));
	}
	if (input.metadata !== undefined) {
		set("metadata", params.json(input.metadata));
	}
	if (input.confidence !== undefined) {
		set("confidence", params.add(input.confidence));
	}
	if (input.expiresAt !== undefined) {
		set("expires_at", params.nullableTime(input.expiresAt));
	}
	set("updated_at", params.time(input.now));
	const target = `${visibilityConditions(params, input.visibility)} AND "id" = ${params.add(input.id)}`;
	const update = statement(
		params,
		`UPDATE ${T.memories} SET ${assignments.join(", ")}
		WHERE ${target}
		RETURNING ${MEMORY_COLUMNS}`,
	);
	if (input.audit === undefined) {
		const rows = await db.execute(update);
		const row = rows[0];
		return row ? toLibsqlMemoryRow(row) : null;
	}
	const auditParams = createLibsqlParams();
	const audit = statement(
		auditParams,
		`INSERT INTO ${T.events} (${EVENT_INSERT_COLUMNS})
		SELECT ${auditParams.add(input.audit.eventId)}, "namespace", "entity_id", "agent_id", "session_id",
			'memory.updated',
			json_object('memoryId', "id", 'fields', json(${auditParams.json(input.audit.fields)})),
			"updated_at"
		FROM ${T.memories}
		WHERE ${visibilityConditions(auditParams, input.visibility)} AND "id" = ${auditParams.add(input.id)}`,
	);
	const [rows = []] = await db.batch([update, audit], "write");
	const row = rows[0];
	return row ? toLibsqlMemoryRow(row) : null;
}

export async function markLibsqlMemoriesAccessed(
	db: LibsqlExecutor,
	visibility: StoreVisibility,
	ids: readonly string[],
	now: Date,
): Promise<void> {
	if (ids.length === 0) {
		return;
	}
	const params = createLibsqlParams();
	await db.execute(
		statement(
			params,
			`UPDATE ${T.memories}
			SET "last_accessed_at" = ${params.time(now)}, "access_count" = "access_count" + 1
			WHERE ${visibilityConditions(params, visibility)} AND "id" IN (${params.list(ids)})`,
		),
	);
}

export interface LibsqlStatsCounts {
	entityCount: number;
	memoryCount: number;
	activeMemoryCount: number;
	expiredMemoryCount: number;
	supersededMemoryCount: number;
}

export async function getLibsqlStats(
	db: LibsqlExecutor,
	selector: StoreSelector,
	now: Date,
	signal?: AbortSignal,
): Promise<LibsqlStatsCounts> {
	const params = createLibsqlParams();
	const conditions = selectorConditions(params, selector);
	const at = params.time(now);
	const rows = await db.execute(
		statement(
			params,
			`SELECT
				count(DISTINCT "namespace" || char(0) || "entity_id") AS "entityCount",
				count(*) AS "memoryCount",
				coalesce(sum(CASE WHEN "superseded_by" IS NULL AND ("expires_at" IS NULL OR "expires_at" > ${at}) THEN 1 ELSE 0 END), 0) AS "activeMemoryCount",
				coalesce(sum(CASE WHEN "expires_at" IS NOT NULL AND "expires_at" <= ${at} THEN 1 ELSE 0 END), 0) AS "expiredMemoryCount",
				coalesce(sum(CASE WHEN "superseded_by" IS NOT NULL THEN 1 ELSE 0 END), 0) AS "supersededMemoryCount"
			FROM ${T.memories}
			WHERE ${conditions}`,
		),
		signal,
	);
	const row = rows[0] ?? {};
	return {
		entityCount: toNumber(row.entityCount ?? 0),
		memoryCount: toNumber(row.memoryCount ?? 0),
		activeMemoryCount: toNumber(row.activeMemoryCount ?? 0),
		expiredMemoryCount: toNumber(row.expiredMemoryCount ?? 0),
		supersededMemoryCount: toNumber(row.supersededMemoryCount ?? 0),
	};
}

export interface LibsqlDeleteMemoryInput {
	visibility: StoreVisibility;
	/** Lower case. */
	memoryId: string;
	dependents: DependentsPolicy;
	now: Date;
	audit: boolean;
}

export interface LibsqlDeleteMemoryResult {
	found: boolean;
	hasDependents: boolean;
	hiddenDependents: boolean;
	deletedIds: string[];
	restoredIds: string[];
}

function scopeValues(
	params: LibsqlParams,
	scope: StoreScope,
): { namespace: string; entity: string; agent: string; session: string } {
	return {
		namespace: params.add(scope.namespace),
		entity: params.add(scope.entityId),
		agent: params.add(scope.agentId),
		session: params.add(scope.sessionId),
	};
}

/**
 * Ids from a `json_group_array`, sorted. Aggregate `ORDER BY`
 * (`json_group_array(x ORDER BY y)`, SQLite 3.44) does not parse on libSQL
 * servers (sqld parses statements itself), so the order is restored here, or
 * the aggregate reads an ordered subquery where SQL must keep the order.
 */
function parseSortedIds(value: unknown): string[] {
	return parseIds(value).sort();
}

function parseIds(value: unknown): string[] {
	return typeof value === "string" ? (JSON.parse(value) as string[]) : [];
}

/**
 * The memories a `"delete"` removes: the memory and, transitively, every
 * memory consolidated into it.
 */
function treeCte(params: LibsqlParams, input: LibsqlDeleteMemoryInput): string {
	return `WITH RECURSIVE tree ("id") AS (
		SELECT "id" FROM ${T.memories}
		WHERE ${visibilityConditions(params, input.visibility)} AND "id" = ${params.add(input.memoryId)}
		UNION
		SELECT dependent."id" FROM ${T.memories} AS dependent
		INNER JOIN tree ON dependent."superseded_by" = tree."id"
	)`;
}

/**
 * Delete one memory in one write batch. The first statement reads what the
 * others will see (found, dependents, hidden dependents, ids); each write
 * after it carries the same guard as a condition, so on a conflict nothing
 * is written, and `BEGIN IMMEDIATE` keeps other writers out between them.
 * Audit events come before the delete, which they read.
 */
export async function deleteLibsqlMemory(
	db: LibsqlExecutor,
	input: LibsqlDeleteMemoryInput,
	signal?: AbortSignal,
): Promise<LibsqlDeleteMemoryResult> {
	const id = input.memoryId;
	const targetOf = (params: LibsqlParams) =>
		`${visibilityConditions(params, input.visibility)} AND "id" = ${params.add(id)}`;
	const statements: LibsqlStatement[] = [];

	if (input.dependents === "reject") {
		const read = createLibsqlParams();
		statements.push(
			statement(
				read,
				`SELECT
					EXISTS (SELECT 1 FROM ${T.memories} WHERE ${targetOf(read)}) AS "found",
					EXISTS (SELECT 1 FROM ${T.memories} WHERE "superseded_by" = ${read.add(id)}) AS "hasDependents"`,
			),
		);
		const guard = (params: LibsqlParams) =>
			`NOT EXISTS (SELECT 1 FROM ${T.memories} WHERE "superseded_by" = ${params.add(id)})`;
		if (input.audit) {
			const params = createLibsqlParams();
			const scope = scopeValues(params, input.visibility.scope);
			const now = params.time(input.now);
			statements.push(
				statement(
					params,
					`INSERT INTO ${T.events} (${EVENT_INSERT_COLUMNS})
					SELECT ${sqlUuidV7(now)}, ${scope.namespace}, ${scope.entity}, ${scope.agent}, ${scope.session},
						'memory.deleted', json_object('memoryId', "id"), ${now}
					FROM ${T.memories}
					WHERE ${targetOf(params)} AND ${guard(params)}`,
				),
			);
		}
		const remove = createLibsqlParams();
		statements.push(
			statement(
				remove,
				`DELETE FROM ${T.memories} WHERE ${targetOf(remove)} AND ${guard(remove)}`,
			),
		);
		const [rows = []] = await db.batch(statements, "write", signal);
		const found = toNumber(rows[0]?.found ?? 0) === 1;
		const hasDependents = toNumber(rows[0]?.hasDependents ?? 0) === 1;
		return {
			found,
			hasDependents,
			hiddenDependents: false,
			deletedIds: found && !hasDependents ? [id] : [],
			restoredIds: [],
		};
	}

	if (input.dependents === "restore") {
		const hiddenOf = (params: LibsqlParams) =>
			`EXISTS (SELECT 1 FROM ${T.memories} AS member WHERE member."superseded_by" = ${params.add(id)} AND NOT (${visibilityConditions(params, input.visibility, "member")}))`;
		const restoredOf = (params: LibsqlParams) =>
			`(SELECT json_group_array("id") FROM (SELECT "id" FROM ${T.memories} WHERE "superseded_by" = ${params.add(id)} ORDER BY "id"))`;
		const read = createLibsqlParams();
		statements.push(
			statement(
				read,
				`SELECT
					EXISTS (SELECT 1 FROM ${T.memories} WHERE ${targetOf(read)}) AS "found",
					${hiddenOf(read)} AS "hidden",
					${restoredOf(read)} AS "restoredIds"`,
			),
		);
		if (input.audit) {
			const params = createLibsqlParams();
			const scope = scopeValues(params, input.visibility.scope);
			const now = params.time(input.now);
			statements.push(
				statement(
					params,
					`INSERT INTO ${T.events} (${EVENT_INSERT_COLUMNS})
					SELECT ${sqlUuidV7(now)}, ${scope.namespace}, ${scope.entity}, ${scope.agent}, ${scope.session},
						'memory.deleted',
						CASE WHEN EXISTS (SELECT 1 FROM ${T.memories} WHERE "superseded_by" = ${params.add(id)})
							THEN json_object('memoryId', "id", 'restoredIds', json(${restoredOf(params)}))
							ELSE json_object('memoryId', "id") END,
						${now}
					FROM ${T.memories}
					WHERE ${targetOf(params)} AND NOT ${hiddenOf(params)}`,
				),
			);
		}
		const restore = createLibsqlParams();
		statements.push(
			statement(
				restore,
				`UPDATE ${T.memories}
				SET "superseded_by" = NULL, "superseded_at" = NULL, "updated_at" = ${restore.time(input.now)}
				WHERE "superseded_by" = ${restore.add(id)}
					AND EXISTS (SELECT 1 FROM ${T.memories} WHERE ${targetOf(restore)})
					AND NOT ${hiddenOf(restore)}`,
			),
		);
		const remove = createLibsqlParams();
		statements.push(
			statement(
				remove,
				`DELETE FROM ${T.memories}
				WHERE ${targetOf(remove)}
					AND NOT EXISTS (SELECT 1 FROM ${T.memories} WHERE "superseded_by" = ${remove.add(id)})`,
			),
		);
		const [rows = []] = await db.batch(statements, "write", signal);
		const found = toNumber(rows[0]?.found ?? 0) === 1;
		const hidden = toNumber(rows[0]?.hidden ?? 0) === 1;
		return {
			found,
			hasDependents: false,
			hiddenDependents: hidden,
			deletedIds: found && !hidden ? [id] : [],
			restoredIds: found && !hidden ? parseSortedIds(rows[0]?.restoredIds) : [],
		};
	}

	const hiddenOf = (params: LibsqlParams) =>
		`EXISTS (SELECT 1 FROM ${T.memories} AS member WHERE member."id" IN (SELECT "id" FROM tree) AND NOT (${visibilityConditions(params, input.visibility, "member")}))`;
	const read = createLibsqlParams();
	statements.push(
		statement(
			read,
			`${treeCte(read, input)}
			SELECT
				EXISTS (SELECT 1 FROM ${T.memories} WHERE ${targetOf(read)}) AS "found",
				${hiddenOf(read)} AS "hidden",
				(SELECT json_group_array("id") FROM tree) AS "deletedIds"`,
		),
	);
	if (input.audit) {
		const params = createLibsqlParams();
		const tree = treeCte(params, input);
		const scope = scopeValues(params, input.visibility.scope);
		const now = params.time(input.now);
		const memoryId = params.add(id);
		statements.push(
			statement(
				params,
				`INSERT INTO ${T.events} (${EVENT_INSERT_COLUMNS})
				${tree}
				SELECT ${sqlUuidV7(now)}, ${scope.namespace}, ${scope.entity}, ${scope.agent}, ${scope.session},
					'memory.deleted',
					CASE WHEN tree."id" = ${memoryId}
						THEN json_object('memoryId', tree."id")
						ELSE json_object('memoryId', tree."id", 'deletedWith', ${memoryId}) END,
					${now}
				FROM tree
				WHERE NOT ${hiddenOf(params)}`,
			),
		);
	}
	const remove = createLibsqlParams();
	const tree = treeCte(remove, input);
	statements.push(
		statement(
			remove,
			`DELETE FROM ${T.memories}
			WHERE "id" IN (${tree} SELECT "id" FROM tree)
				AND NOT (${tree} SELECT ${hiddenOf(remove)})`,
		),
	);
	const [rows = []] = await db.batch(statements, "write", signal);
	const found = toNumber(rows[0]?.found ?? 0) === 1;
	const hidden = toNumber(rows[0]?.hidden ?? 0) === 1;
	return {
		found,
		hasDependents: false,
		hiddenDependents: hidden,
		deletedIds: found && !hidden ? parseSortedIds(rows[0]?.deletedIds) : [],
		restoredIds: [],
	};
}

export interface LibsqlGuardedDeleteResult {
	matchedCount: number;
	deletedCount: number;
	hasDependents: boolean;
}

/** A memory outside the candidates that points at one of them. */
function outsideDependents(conditions: string): string {
	return `EXISTS (
		SELECT 1 FROM ${T.memories} AS dependent
		WHERE dependent."superseded_by" IN (SELECT "id" FROM ${T.memories} WHERE ${conditions})
			AND dependent."id" NOT IN (SELECT "id" FROM ${T.memories} WHERE ${conditions})
	)`;
}

/**
 * Delete the selected memories and audit events in one write batch, unless
 * a memory outside the selection depends on one of them.
 */
export async function deleteLibsqlScope(
	db: LibsqlExecutor,
	selector: StoreSelector,
	signal?: AbortSignal,
): Promise<LibsqlGuardedDeleteResult> {
	const read = createLibsqlParams();
	const readConditions = selectorConditions(read, selector);
	const events = createLibsqlParams();
	const eventConditions = selectorConditions(events, selector);
	// The same placeholders for the memories guard: `?n` binds by number.
	const eventGuard = eventConditions;
	const remove = createLibsqlParams();
	const removeConditions = selectorConditions(remove, selector);
	const [rows = []] = await db.batch(
		[
			statement(
				read,
				`SELECT
					(SELECT count(*) FROM ${T.memories} WHERE ${readConditions}) AS "matchedCount",
					${outsideDependents(readConditions)} AS "hasDependents"`,
			),
			statement(
				events,
				`DELETE FROM ${T.events}
				WHERE ${eventConditions} AND NOT ${outsideDependents(eventGuard)}`,
			),
			statement(
				remove,
				`DELETE FROM ${T.memories}
				WHERE ${removeConditions} AND NOT ${outsideDependents(removeConditions)}`,
			),
		],
		"write",
		signal,
	);
	const matchedCount = toNumber(rows[0]?.matchedCount ?? 0);
	const hasDependents = toNumber(rows[0]?.hasDependents ?? 0) === 1;
	return {
		matchedCount,
		deletedCount: hasDependents ? 0 : matchedCount,
		hasDependents,
	};
}

export interface LibsqlPruneFilter {
	selector: StoreSelector;
	expired?: boolean;
	superseded?: boolean;
	createdBefore?: Date;
	notAccessedSince?: Date;
	kinds?: readonly MemoryKind[];
	tags?: readonly string[];
	maxImportanceLevels?: readonly ImportanceLevel[];
}

function pruneConditions(
	params: LibsqlParams,
	filter: LibsqlPruneFilter,
	now: Date,
): string {
	const clauses: string[] = [selectorConditions(params, filter.selector)];
	if (filter.expired) {
		clauses.push(
			`("expires_at" IS NOT NULL AND "expires_at" <= ${params.time(now)})`,
		);
	}
	if (filter.superseded) {
		clauses.push(`"superseded_by" IS NOT NULL`);
	}
	if (filter.createdBefore) {
		clauses.push(`"created_at" < ${params.time(filter.createdBefore)}`);
	}
	if (filter.notAccessedSince) {
		clauses.push(
			`coalesce("last_accessed_at", "created_at") < ${params.time(filter.notAccessedSince)}`,
		);
	}
	if (filter.kinds && filter.kinds.length > 0) {
		clauses.push(`"kind" IN (${params.list(filter.kinds)})`);
	}
	if (filter.tags && filter.tags.length > 0) {
		clauses.push(...tagConditions(params, filter.tags));
	}
	if (filter.maxImportanceLevels && filter.maxImportanceLevels.length > 0) {
		clauses.push(
			`"importance" IN (${params.list(filter.maxImportanceLevels)})`,
		);
	}
	return clauses.join(" AND ");
}

export async function countLibsqlPruneMatches(
	db: LibsqlExecutor,
	filter: LibsqlPruneFilter,
	now: Date,
	signal?: AbortSignal,
): Promise<number> {
	const params = createLibsqlParams();
	const rows = await db.execute(
		statement(
			params,
			`SELECT count(*) AS "count" FROM ${T.memories} WHERE ${pruneConditions(params, filter, now)}`,
		),
		signal,
	);
	return toNumber(rows[0]?.count ?? 0);
}

/**
 * Delete the matching memories in one write batch. A survivor is deleted
 * when every memory that references it is deleted too; one outside the
 * matches blocks the whole prune. With `audit`, one `memory.pruned` per
 * affected `(namespace, entity_id)`, at the selector's agent and session.
 */
export async function pruneLibsqlMemories(
	db: LibsqlExecutor,
	filter: LibsqlPruneFilter,
	now: Date,
	audit: boolean,
	signal?: AbortSignal,
): Promise<LibsqlGuardedDeleteResult> {
	const read = createLibsqlParams();
	const readConditions = pruneConditions(read, filter, now);
	const statements: LibsqlStatement[] = [
		statement(
			read,
			`SELECT
				(SELECT count(*) FROM ${T.memories} WHERE ${readConditions}) AS "matchedCount",
				${outsideDependents(readConditions)} AS "hasDependents"`,
		),
	];
	if (audit) {
		const params = createLibsqlParams();
		const conditions = pruneConditions(params, filter, now);
		const guard = conditions;
		const at = params.time(now);
		statements.push(
			statement(
				params,
				`INSERT INTO ${T.events} (${EVENT_INSERT_COLUMNS})
				SELECT ${sqlUuidV7(at)}, "namespace", "entity_id",
					${params.add(filter.selector.agentId ?? null)}, ${params.add(filter.selector.sessionId ?? null)},
					'memory.pruned', json_object('count', count(*)), ${at}
				FROM ${T.memories}
				WHERE ${conditions} AND NOT ${outsideDependents(guard)}
				GROUP BY "namespace", "entity_id"`,
			),
		);
	}
	const remove = createLibsqlParams();
	const removeConditions = pruneConditions(remove, filter, now);
	statements.push(
		statement(
			remove,
			`DELETE FROM ${T.memories}
			WHERE ${removeConditions} AND NOT ${outsideDependents(removeConditions)}`,
		),
	);
	const [rows = []] = await db.batch(statements, "write", signal);
	const matchedCount = toNumber(rows[0]?.matchedCount ?? 0);
	const hasDependents = toNumber(rows[0]?.hasDependents ?? 0) === 1;
	return {
		matchedCount,
		deletedCount: hasDependents ? 0 : matchedCount,
		hasDependents,
	};
}

export interface LibsqlDuplicateFilter {
	visibility: StoreVisibility;
	threshold: number;
	neighbors: number;
	kinds?: readonly string[];
	tags?: readonly string[];
	includeSuperseded?: boolean;
	includeExpired?: boolean;
}

/**
 * The memories a duplicate search compares, with their embeddings. The
 * store compares them in JavaScript (`memory/duplicates.ts`): reading a
 * stored vector costs microseconds, while `vector_distance_cos` between two
 * stored rows costs tens of them, so the pairwise comparison in SQL was the
 * slowest part by far.
 */
export async function listLibsqlDuplicateCandidates(
	db: LibsqlExecutor,
	input: LibsqlDuplicateFilter,
	now: Date,
	signal?: AbortSignal,
): Promise<Array<{ row: MemoryRow; embedding: number[] }>> {
	const params = createLibsqlParams();
	const clauses: string[] = [
		visibilityConditions(params, input.visibility),
		`"embedding" IS NOT NULL`,
	];
	if (!input.includeSuperseded) {
		clauses.push(`"superseded_by" IS NULL`);
	}
	if (!input.includeExpired) {
		clauses.push(
			`("expires_at" IS NULL OR "expires_at" > ${params.time(now)})`,
		);
	}
	if (input.kinds && input.kinds.length > 0) {
		clauses.push(`"kind" IN (${params.list(input.kinds)})`);
	}
	if (input.tags && input.tags.length > 0) {
		clauses.push(...tagConditions(params, input.tags));
	}
	const rows = await db.execute(
		statement(
			params,
			`SELECT ${MEMORY_COLUMNS}, "embedding" AS "embedding"
			FROM ${T.memories}
			WHERE ${clauses.join(" AND ")}
			ORDER BY "id"`,
		),
		signal,
	);
	return rows.map((raw) => {
		const row = toLibsqlMemoryRow(raw);
		return {
			row,
			embedding: toEmbedding(raw.embedding, row.embeddingDimensions),
		};
	});
}

export interface LibsqlConsolidateInput {
	visibility: StoreVisibility;
	survivorId: string;
	/** Lower case, distinct. */
	supersededIds: readonly string[];
	mergeTags: boolean;
	now: Date;
	/** One id per requested loser, in request order; omitted skips the audit. */
	auditEventIds?: readonly string[];
}

export interface LibsqlConsolidateResult {
	survivorActive: boolean;
	hasConflict: boolean;
	supersededIds: string[];
}

/**
 * Consolidation in one write batch. The first statement reads the checks
 * and the losers it will supersede, in request order; every write after it
 * repeats the check as a condition (`ok`), and `BEGIN IMMEDIATE` keeps other
 * writers out, the counterpart of the Postgres store's `FOR UPDATE`. The
 * audit events and the tag merge read the losers before the last statement
 * supersedes them.
 */
export async function consolidateLibsqlMemories(
	db: LibsqlExecutor,
	input: LibsqlConsolidateInput,
	signal?: AbortSignal,
): Promise<LibsqlConsolidateResult> {
	/** `requested`, `survivor`, `losers` and `ok`, for one statement. */
	const ctes = (params: LibsqlParams) => {
		const survivorId = params.add(input.survivorId);
		return `WITH requested AS (
			SELECT value AS "id", min(CAST(key AS INTEGER)) AS position
			FROM json_each(${params.json(input.supersededIds)})
			GROUP BY value
		),
		visible AS MATERIALIZED (
			SELECT "id", "tags", "superseded_by" FROM ${T.memories}
			WHERE ${visibilityConditions(params, input.visibility)}
				AND ("id" = ${survivorId} OR "id" IN (SELECT "id" FROM requested))
		),
		survivor AS (
			SELECT "id", "tags" FROM visible WHERE "id" = ${survivorId} AND "superseded_by" IS NULL
		),
		conflict AS (
			SELECT 1 FROM visible
			WHERE "id" <> ${survivorId} AND "superseded_by" IS NOT NULL AND "superseded_by" <> ${survivorId}
			LIMIT 1
		),
		ok AS (
			SELECT EXISTS (SELECT 1 FROM survivor) AND NOT EXISTS (SELECT 1 FROM conflict) AS allowed
		),
		losers AS (
			SELECT visible."id", visible."tags", requested.position
			FROM visible INNER JOIN requested ON requested."id" = visible."id"
			WHERE visible."id" <> ${survivorId} AND visible."superseded_by" IS NULL
		)`;
	};
	const statements: LibsqlStatement[] = [];
	const read = createLibsqlParams();
	statements.push(
		statement(
			read,
			`${ctes(read)}
			SELECT
				EXISTS (SELECT 1 FROM survivor) AS "survivorActive",
				EXISTS (SELECT 1 FROM conflict) AS "hasConflict",
				(SELECT json_group_array("id") FROM losers) AS "supersededIds"`,
		),
	);
	if (input.auditEventIds !== undefined) {
		const params = createLibsqlParams();
		const with_ = ctes(params);
		const scope = scopeValues(params, input.visibility.scope);
		const now = params.time(input.now);
		statements.push(
			statement(
				params,
				`INSERT INTO ${T.events} (${EVENT_INSERT_COLUMNS})
				${with_},
				numbered AS (
					SELECT "id", row_number() OVER (ORDER BY position) - 1 AS slot FROM losers
				)
				SELECT json_extract(${params.json(input.auditEventIds)}, '$[' || numbered.slot || ']'),
					${scope.namespace}, ${scope.entity}, ${scope.agent}, ${scope.session},
					'memory.superseded',
					json_object('memoryId', numbered."id", 'supersededBy', ${params.add(input.survivorId)}),
					${now}
				FROM numbered
				WHERE (SELECT allowed FROM ok)`,
			),
		);
	}
	if (input.mergeTags) {
		const params = createLibsqlParams();
		const with_ = ctes(params);
		const now = params.time(input.now);
		const survivorId = params.add(input.survivorId);
		statements.push(
			statement(
				params,
				`${with_},
				candidates AS (
					SELECT t.value AS tag, 0 AS grp, 0 AS owner, CAST(t.key AS INTEGER) AS position
					FROM survivor, json_each(survivor."tags") AS t
					UNION ALL
					SELECT t.value, 1, losers.position, CAST(t.key AS INTEGER)
					FROM losers, json_each(losers."tags") AS t
				),
				firsts AS (
					SELECT tag, grp, owner, position,
						row_number() OVER (PARTITION BY tag ORDER BY grp, owner, position) AS occurrence
					FROM candidates
				),
				merged AS (
					SELECT json_group_array(tag) AS tags FROM (
						SELECT tag FROM firsts WHERE occurrence = 1
						ORDER BY grp, owner, position
					)
				)
				UPDATE ${T.memories}
				SET "tags" = (SELECT tags FROM merged), "updated_at" = ${now}
				WHERE "id" = ${survivorId}
					AND (SELECT allowed FROM ok)
					AND json_array_length((SELECT tags FROM merged)) > json_array_length((SELECT "tags" FROM survivor))`,
			),
		);
	}
	const supersede = createLibsqlParams();
	const with_ = ctes(supersede);
	const now = supersede.time(input.now);
	statements.push(
		statement(
			supersede,
			`${with_}
			UPDATE ${T.memories}
			SET "superseded_by" = ${supersede.add(input.survivorId)}, "superseded_at" = ${now}, "updated_at" = ${now}
			WHERE "id" IN (SELECT "id" FROM losers) AND (SELECT allowed FROM ok)`,
		),
	);
	const [rows = []] = await db.batch(statements, "write", signal);
	const row = rows[0];
	return {
		survivorActive: toNumber(row?.survivorActive ?? 0) === 1,
		hasConflict: toNumber(row?.hasConflict ?? 0) === 1,
		// Request order: the order `input.supersededIds` names them.
		supersededIds: (() => {
			const superseded = new Set(parseIds(row?.supersededIds));
			return input.supersededIds.filter((id) => superseded.has(id));
		})(),
	};
}

export interface LibsqlVectorSearchInput extends LibsqlMemoryFilter {
	embedding: readonly number[];
	limit: number;
}

/**
 * The nearest `limit` rows that pass the recall filters, by exact cosine
 * distance: the scope index selects the scope's rows and each one's
 * distance is computed, so filters never shrink the result below what
 * exists ({@link LIBSQL_CAPABILITIES}: `"exact"`, `"prefilter"`). The
 * ranking reads only `rowid`, `id` and the distance, and the columns are
 * read for the `limit` rows it keeps: sorting every column of the scope
 * cost about a third of the search.
 */
export async function libsqlVectorSearch(
	db: LibsqlExecutor,
	input: LibsqlVectorSearchInput,
	now: Date,
): Promise<Array<MemoryRow & { vectorDistance: number }>> {
	const params = createLibsqlParams();
	const embedding = params.vector(input.embedding);
	const rows = await db.execute(
		statement(
			params,
			`WITH nearest AS MATERIALIZED (
				SELECT "rowid" AS "row", "id" AS "id", vector_distance_cos("embedding", ${embedding}) AS "distance"
				FROM ${T.memories}
				WHERE ${recallFilters(params, input, now)} AND "embedding" IS NOT NULL
				ORDER BY "distance", "id"
				LIMIT ${params.add(input.limit)}
			)
			SELECT ${libsqlMemoryColumns({ table: "m" })}, nearest."distance" AS "vectorDistance"
			FROM nearest
			INNER JOIN ${T.memories} AS m ON m."rowid" = nearest."row"
			ORDER BY nearest."distance", nearest."id"`,
		),
	);
	return rows.map((row) => ({
		...toLibsqlMemoryRow(row),
		vectorDistance: toNumber(row.vectorDistance),
	}));
}

/** The most distinct terms a keyword query keeps. */
export const MAX_LEXICAL_TERMS = 64;

/**
 * An FTS5 query for user text: each whitespace-separated term becomes an
 * FTS5 string (double quotes doubled inside), joined with `OR`, so operators
 * and special characters in the text are matched as words. FTS5 has no stop
 * words, so requiring every term (implicit AND) would drop rows over words
 * like "the"; bm25 already ranks rows that match more terms higher. `null`
 * when the text has no terms.
 */
export function ftsQuery(text: string): string | null {
	const terms = [...new Set(text.split(/\s+/u).filter((term) => term !== ""))];
	if (terms.length === 0) {
		return null;
	}
	return terms
		.slice(0, MAX_LEXICAL_TERMS)
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" OR ");
}

export interface LibsqlLexicalSearchInput extends LibsqlMemoryFilter {
	query: string;
	limit: number;
}

/**
 * Keyword candidates from the FTS5 index, best first. The score is
 * `-bm25()`: FTS5 returns more negative values for better matches.
 */
export async function libsqlLexicalSearch(
	db: LibsqlExecutor,
	input: LibsqlLexicalSearchInput,
	now: Date,
): Promise<Array<MemoryRow & { lexicalScore: number }>> {
	const match = ftsQuery(input.query);
	if (match === null) {
		return [];
	}
	const params = createLibsqlParams();
	const rows = await db.execute(
		statement(
			params,
			`SELECT ${libsqlMemoryColumns({ table: "m" })}, -bm25(${T.fts}) AS "lexicalScore"
			FROM ${T.fts}
			INNER JOIN ${T.memories} AS m ON m."rowid" = ${T.fts}."rowid"
			WHERE ${T.fts} MATCH ${params.add(match)}
				AND ${recallFilters(params, input, now, "m")}
			ORDER BY bm25(${T.fts}), m."id"
			LIMIT ${params.add(input.limit)}`,
		),
	);
	return rows
		.map((row) => ({
			...toLibsqlMemoryRow(row),
			lexicalScore: toNumber(row.lexicalScore),
		}))
		.filter((row) => row.lexicalScore > 0);
}

export interface LibsqlEventFilter {
	selector: StoreSelector;
	limit: number;
	before?: Date;
	after?: Date;
	memoryId?: string;
	position?: StoreAuditPosition;
}

/** One audit page, newest first by `(timestamp, id)`. */
export async function listLibsqlEvents(
	db: LibsqlExecutor,
	filter: LibsqlEventFilter,
	signal?: AbortSignal,
): Promise<Array<{ row: EventRow; position: StoreAuditPosition }>> {
	const params = createLibsqlParams();
	const clauses = [selectorConditions(params, filter.selector)];
	if (filter.before) {
		clauses.push(`"timestamp" < ${params.time(filter.before)}`);
	}
	if (filter.after) {
		clauses.push(`"timestamp" > ${params.time(filter.after)}`);
	}
	if (filter.memoryId !== undefined) {
		clauses.push(`"memory_id" = ${params.add(filter.memoryId.toLowerCase())}`);
	}
	if (filter.position) {
		clauses.push(
			`("timestamp", "id") < (${params.add(positionMillis(filter.position.timestamp))}, ${params.add(filter.position.id.toLowerCase())})`,
		);
	}
	const rows = await db.execute(
		statement(
			params,
			`SELECT ${LIBSQL_EVENT_COLUMNS} FROM ${T.events}
			WHERE ${clauses.join(" AND ")}
			ORDER BY "timestamp" DESC, "id" DESC
			LIMIT ${params.add(filter.limit)}`,
		),
		signal,
	);
	return rows.map((raw) => {
		const row = toLibsqlEventRow(raw);
		return {
			row,
			position: {
				timestamp: positionTimestamp(row.timestamp.getTime()),
				id: row.id,
			},
		};
	});
}

export interface LibsqlEventPruneFilter {
	selector: StoreSelector;
	before: Date;
}

export async function countLibsqlEventsBefore(
	db: LibsqlExecutor,
	filter: LibsqlEventPruneFilter,
	signal?: AbortSignal,
): Promise<number> {
	const params = createLibsqlParams();
	const rows = await db.execute(
		statement(
			params,
			`SELECT count(*) AS "count" FROM ${T.events}
			WHERE ${selectorConditions(params, filter.selector)} AND "timestamp" < ${params.time(filter.before)}`,
		),
		signal,
	);
	return toNumber(rows[0]?.count ?? 0);
}

/** Where a batch stopped, in `mnemocyte_events_scope_time_idx` order. */
export interface LibsqlEventPosition {
	namespace: string;
	entityId: string;
	timestamp: number;
	id: string;
}

function compareEventPositions(
	x: LibsqlEventPosition,
	y: LibsqlEventPosition,
): number {
	if (x.namespace !== y.namespace) {
		return x.namespace < y.namespace ? -1 : 1;
	}
	if (x.entityId !== y.entityId) {
		return x.entityId < y.entityId ? -1 : 1;
	}
	if (x.timestamp !== y.timestamp) {
		return x.timestamp - y.timestamp;
	}
	return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}

/**
 * Events after `after` in index order: a row comparison over the index
 * columns that follow the selector's equalities, as in the Postgres store,
 * so a batch never walks the entries the ones before it deleted.
 */
function resumeCondition(
	params: LibsqlParams,
	selector: StoreSelector,
	after: LibsqlEventPosition,
): string {
	const columns: [string, () => string][] = [
		[`"namespace"`, () => params.add(after.namespace)],
		[`"entity_id"`, () => params.add(after.entityId)],
		[`"timestamp"`, () => params.add(after.timestamp)],
		[`"id"`, () => params.add(after.id)],
	];
	const fixed =
		selector.namespace === null ? 0 : selector.entityId === undefined ? 1 : 2;
	const rest = columns.slice(fixed);
	return `(${rest.map(([name]) => name).join(", ")}) > (${rest.map(([, value]) => value()).join(", ")})`;
}

/**
 * Delete up to `batchSize` selected events after `after`, in index order,
 * as one statement that commits on its own. The statement is atomic, so
 * the events it selects are the events it deletes.
 */
export async function deleteLibsqlEventsBatch(
	db: LibsqlExecutor,
	filter: LibsqlEventPruneFilter,
	batchSize: number,
	after: LibsqlEventPosition | null,
	signal?: AbortSignal,
): Promise<{ deletedCount: number; last: LibsqlEventPosition | null }> {
	const params = createLibsqlParams();
	const conditions = [
		selectorConditions(params, filter.selector),
		`"timestamp" < ${params.time(filter.before)}`,
	];
	if (after !== null) {
		conditions.push(resumeCondition(params, filter.selector, after));
	}
	const rows = await db.execute(
		statement(
			params,
			`DELETE FROM ${T.events}
			WHERE "id" IN (
				SELECT "id" FROM ${T.events}
				WHERE ${conditions.join(" AND ")}
				ORDER BY "namespace", "entity_id", "timestamp", "id"
				LIMIT ${params.add(batchSize)}
			)
			RETURNING "namespace" AS "namespace", "entity_id" AS "entityId", "timestamp" AS "timestamp", "id" AS "id"`,
		),
		signal,
	);
	let last: LibsqlEventPosition | null = null;
	for (const row of rows) {
		const position: LibsqlEventPosition = {
			namespace: String(row.namespace),
			entityId: String(row.entityId),
			timestamp: toNumber(row.timestamp),
			id: String(row.id),
		};
		if (last === null || compareEventPositions(position, last) > 0) {
			last = position;
		}
	}
	return { deletedCount: rows.length, last };
}

export interface LibsqlMeta {
	dimensions: number;
	model: string | null;
	vectorType: string;
}

export async function getLibsqlMeta(
	db: LibsqlExecutor,
): Promise<LibsqlMeta | null> {
	const rows = await db.execute({
		sql: `SELECT embedding_dimensions AS "dimensions", embedding_model AS "model", vector_type AS "vectorType" FROM ${T.meta} WHERE key = 'installation' LIMIT 1`,
		args: [],
	});
	const row = rows[0];
	if (row === undefined) {
		return null;
	}
	return {
		dimensions: toNumber(row.dimensions),
		model:
			row.model === null || row.model === undefined ? null : String(row.model),
		vectorType: String(row.vectorType),
	};
}

export async function getLibsqlStoredModels(
	db: LibsqlExecutor,
): Promise<string[]> {
	const rows = await db.execute({
		sql: `SELECT DISTINCT embedding_model AS "model" FROM ${T.memories} LIMIT 2`,
		args: [],
	});
	return rows.map((row) => String(row.model));
}

/** Records the model when none is; `false` when another writer was first. */
export async function recordLibsqlModel(
	db: LibsqlExecutor,
	model: string,
): Promise<boolean> {
	const rows = await db.execute({
		sql: `UPDATE ${T.meta} SET embedding_model = ?1 WHERE key = 'installation' AND embedding_model IS NULL RETURNING key`,
		args: [model],
	});
	return rows.length > 0;
}
