import { MnemocyteError } from "../../errors.js";
import type { StoreScope } from "../../memory/store.js";
import type { SqlExecutor } from "../../sql/executor.js";
import type { AuditLogCursor, JsonObject } from "../../types.js";
import {
	EVENT_COLUMNS,
	type EventRow,
	type RawEventRow,
	toEventRow,
} from "../rows.js";
import { createSqlParams } from "../sql.js";

export interface EventFilter {
	scope: StoreScope;
	limit?: number;
	before?: Date;
	after?: Date;
	beforeCursor?: AuditLogCursor;
	afterCursor?: AuditLogCursor;
}

export interface NewEventRow {
	id: string;
	scope: StoreScope;
	description: string;
	metadata: JsonObject;
	timestamp: Date;
}

export async function insertEvent(
	db: SqlExecutor,
	row: NewEventRow,
): Promise<EventRow> {
	const params = createSqlParams();
	const result = await db.query<RawEventRow>(
		`INSERT INTO mnemocyte_events (
			id, namespace, entity_id, agent_id, session_id, description, metadata,
			timestamp
		)
		VALUES (
			${params.uuid(row.id)},
			${params.add(row.scope.namespace)},
			${params.add(row.scope.entityId)},
			${params.add(row.scope.agentId)}::text,
			${params.add(row.scope.sessionId)}::text,
			${params.add(row.description)},
			${params.json(row.metadata)},
			${params.timestamp(row.timestamp)}
		)
		RETURNING ${EVENT_COLUMNS}`,
		params.values,
	);
	const inserted = result[0];
	if (!inserted) {
		throw new MnemocyteError("Event insert returned no rows.", "DB");
	}
	return toEventRow(inserted);
}

export async function listEvents(
	db: SqlExecutor,
	filter: EventFilter,
	signal?: AbortSignal,
): Promise<EventRow[]> {
	const params = createSqlParams();
	// Audit events are listed for the whole entity, across agents and sessions.
	const clauses: string[] = [
		`namespace = ${params.add(filter.scope.namespace)}`,
		`entity_id = ${params.add(filter.scope.entityId)}`,
	];
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
