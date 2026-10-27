import { MnemocyteError } from "../../errors.js";
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
	entityId: string;
	limit?: number;
	before?: Date;
	after?: Date;
	beforeCursor?: AuditLogCursor;
	afterCursor?: AuditLogCursor;
}

export interface NewEventRow {
	id: string;
	entityId: string;
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
		`INSERT INTO mnemocyte_events (id, entity_id, description, metadata, timestamp)
		VALUES (
			${params.add(row.id)},
			${params.add(row.entityId)},
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
	const clauses: string[] = [`entity_id = ${params.add(filter.entityId)}`];
	if (filter.before) {
		clauses.push(`timestamp < ${params.timestamp(filter.before)}`);
	}
	if (filter.after) {
		clauses.push(`timestamp > ${params.timestamp(filter.after)}`);
	}
	if (filter.beforeCursor) {
		clauses.push(
			`(timestamp, id) < (${params.timestamp(filter.beforeCursor.timestamp)}, ${params.add(filter.beforeCursor.id)})`,
		);
	}
	if (filter.afterCursor) {
		clauses.push(
			`(timestamp, id) > (${params.timestamp(filter.afterCursor.timestamp)}, ${params.add(filter.afterCursor.id)})`,
		);
	}
	const rows = await db.query<RawEventRow>(
		`SELECT ${EVENT_COLUMNS}
		FROM mnemocyte_events
		WHERE ${clauses.join("\n\t\t\tAND ")}
		ORDER BY timestamp DESC, id DESC
		LIMIT ${params.add(filter.limit ?? 50)}`,
		params.values,
		signal ? { signal } : undefined,
	);
	return rows.map(toEventRow);
}
