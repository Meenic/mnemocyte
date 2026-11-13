import type { StoreEntitySelector, StoreSelector } from "../../memory/store.js";
import type { SqlExecutor } from "../../sql/executor.js";
import type { AuditLogCursor } from "../../types.js";
import {
	EVENT_COLUMNS,
	type EventRow,
	type RawEventRow,
	toEventRow,
} from "../rows.js";
import { createSqlParams, type SqlParams } from "../sql.js";
import { selectorConditions } from "./memories.js";

export interface EventFilter {
	selector: StoreEntitySelector;
	limit?: number;
	before?: Date;
	after?: Date;
	beforeCursor?: AuditLogCursor;
	afterCursor?: AuditLogCursor;
}

export async function listEvents(
	db: SqlExecutor,
	filter: EventFilter,
	signal?: AbortSignal,
): Promise<EventRow[]> {
	const params = createSqlParams();
	// An omitted agent or session matches every value, so `{ namespace,
	// entityId }` lists the whole entity across agents and sessions.
	const clauses: string[] = [selectorConditions(params, filter.selector)];
	if (filter.before) {
		clauses.push(`timestamp < ${params.timestamp(filter.before)}`);
	}
	if (filter.after) {
		clauses.push(`timestamp > ${params.timestamp(filter.after)}`);
	}
	if (filter.beforeCursor) {
		clauses.push(
			`(timestamp, id) < (${params.timestamp(filter.beforeCursor.timestamp)}, ${params.uuid(filter.beforeCursor.id)})`,
		);
	}
	if (filter.afterCursor) {
		clauses.push(
			`(timestamp, id) > (${params.timestamp(filter.afterCursor.timestamp)}, ${params.uuid(filter.afterCursor.id)})`,
		);
	}
	const rows = await db.query<RawEventRow>(
		`SELECT ${EVENT_COLUMNS}
		FROM mnemocyte_events
		WHERE ${clauses.join("\n\t\t\tAND ")}
		ORDER BY mnemocyte_events.timestamp DESC, mnemocyte_events.id DESC
		LIMIT ${params.add(filter.limit ?? 50)}`,
		params.values,
		signal ? { signal } : undefined,
	);
	return rows.map(toEventRow);
}

export interface EventPruneFilter {
	selector: StoreSelector;
	/** Events strictly before this time are selected. */
	before: Date;
}

function eventPruneConditions(
	params: SqlParams,
	filter: EventPruneFilter,
): string {
	return `${selectorConditions(params, filter.selector)}
			AND timestamp < ${params.timestamp(filter.before)}`;
}

/** Number of events a `pruneAuditLog` dry run would delete. */
export async function countEventsBefore(
	db: SqlExecutor,
	filter: EventPruneFilter,
	signal?: AbortSignal,
): Promise<number> {
	const params = createSqlParams();
	const rows = await db.query<{ count: number | string }>(
		`SELECT count(*)::int AS count
		FROM mnemocyte_events
		WHERE ${eventPruneConditions(params, filter)}`,
		params.values,
		signal ? { signal } : undefined,
	);
	return Number(rows[0]?.count ?? 0);
}

/**
 * Where a batch stopped, in `mnemocyte_events_scope_time_idx` order. The
 * timestamp is text with microseconds, which a `Date` would cut to
 * milliseconds.
 */
export interface EventPosition {
	namespace: string;
	entityId: string;
	timestamp: string;
	id: string;
}

export interface EventDeleteBatchResult {
	/** Events the batch selected: below `batchSize` means none were left. */
	selectedCount: number;
	/** Events the batch deleted; fewer when another statement got there first. */
	deletedCount: number;
	/** The last selected event, where the next batch starts; null when none. */
	last: EventPosition | null;
}

/**
 * Events after `after` in index order, as a row comparison over the index
 * columns that follow the selector's equalities: `(timestamp, id)` within
 * an entity, `(entity_id, timestamp, id)` within a namespace, all four
 * across namespaces. Next to `namespace = $1`, a comparison that starts at
 * `namespace` did not bound the scan, and every batch walked the deleted
 * entries of the ones before (measured in features/maintenance.md).
 */
function resumeCondition(
	params: SqlParams,
	selector: StoreSelector,
	after: EventPosition,
): string {
	// Placeholders are added only for the columns compared, so the statement
	// has no unused parameter.
	const columns: [string, () => string][] = [
		["namespace", () => `${params.add(after.namespace)}::text`],
		["entity_id", () => `${params.add(after.entityId)}::text`],
		["timestamp", () => `${params.add(after.timestamp)}::timestamptz`],
		["id", () => params.uuid(after.id)],
	];
	const fixed =
		selector.namespace === null ? 0 : selector.entityId === undefined ? 1 : 2;
	const rest = columns.slice(fixed);
	const names = rest.map(([name]) => name).join(", ");
	const values = rest.map(([, value]) => value()).join(", ");
	return `(${names}) > (${values})`;
}

/**
 * Delete up to `batchSize` selected events after `after`, in one statement.
 * `DELETE` has no `LIMIT`, so a materialized CTE picks the batch by primary
 * key and the delete joins on it. Batches walk
 * `mnemocyte_events_scope_time_idx` in order and each starts after the last
 * event of the one before (keyset pagination), so no batch reads the index
 * entries earlier batches deleted: restarting from the beginning made a
 * whole-table run quadratic in the backlog (see features/maintenance.md).
 */
export async function deleteEventsBatch(
	db: SqlExecutor,
	filter: EventPruneFilter,
	batchSize: number,
	after: EventPosition | null,
	signal?: AbortSignal,
): Promise<EventDeleteBatchResult> {
	const params = createSqlParams();
	const conditions = [eventPruneConditions(params, filter)];
	if (after !== null) {
		conditions.push(resumeCondition(params, filter.selector, after));
	}
	const rows = await db.query<{
		selectedCount: number | string;
		deletedCount: number | string;
		lastNamespace: string | null;
		lastEntityId: string | null;
		lastTimestamp: string | null;
		lastId: string | null;
	}>(
		`WITH batch AS MATERIALIZED (
			SELECT namespace, entity_id, timestamp, id
			FROM mnemocyte_events
			WHERE ${conditions.join("\n\t\t\tAND ")}
			ORDER BY namespace, entity_id, timestamp, id
			LIMIT ${params.add(batchSize)}
		),
		deleted AS (
			DELETE FROM mnemocyte_events
			WHERE id IN (SELECT id FROM batch)
			RETURNING 1
		),
		last AS (
			SELECT namespace, entity_id, timestamp, id
			FROM batch
			ORDER BY namespace DESC, entity_id DESC, timestamp DESC, id DESC
			LIMIT 1
		)
		SELECT
			(SELECT count(*)::int FROM batch) AS "selectedCount",
			(SELECT count(*)::int FROM deleted) AS "deletedCount",
			last.namespace AS "lastNamespace",
			last.entity_id AS "lastEntityId",
			to_char(last.timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "lastTimestamp",
			last.id::text AS "lastId"
		FROM (SELECT 1) AS one
		LEFT JOIN last ON TRUE`,
		params.values,
		signal ? { signal } : undefined,
	);
	const row = rows[0];
	const last =
		row?.lastNamespace != null &&
		row.lastEntityId != null &&
		row.lastTimestamp != null &&
		row.lastId != null
			? {
					namespace: row.lastNamespace,
					entityId: row.lastEntityId,
					timestamp: row.lastTimestamp,
					id: row.lastId,
				}
			: null;
	return {
		selectedCount: Number(row?.selectedCount ?? 0),
		deletedCount: Number(row?.deletedCount ?? 0),
		last,
	};
}
