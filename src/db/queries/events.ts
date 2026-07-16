import { sql } from "drizzle-orm";
import { MnemocyteError } from "../../errors.js";
import type { AuditLogCursor } from "../../types.js";
import { executeCancelableSql } from "../cancellation.js";
import type { MnemocyteDatabase } from "../index.js";
import { type EventRow, eventsTable, type NewEventRow } from "../schema.js";

export interface EventFilter {
	entityId: string;
	limit?: number;
	before?: Date;
	after?: Date;
	beforeCursor?: AuditLogCursor;
	afterCursor?: AuditLogCursor;
}

function timestampParam(value: Date) {
	return sql`${value.toISOString()}::timestamptz`;
}

export async function insertEvent(
	db: MnemocyteDatabase,
	row: NewEventRow,
): Promise<EventRow> {
	const result = await db.insert(eventsTable).values(row).returning();
	const inserted = result[0];
	if (!inserted) {
		throw new MnemocyteError("Event insert returned no rows.", "DB");
	}
	return inserted;
}

export async function listEvents(
	db: MnemocyteDatabase,
	filter: EventFilter,
	signal?: AbortSignal,
): Promise<EventRow[]> {
	return executeCancelableSql<EventRow[]>(
		db,
		sql`
			SELECT
				id,
				entity_id AS "entityId",
				description,
				metadata,
				timestamp
			FROM mnemocyte_events
			WHERE entity_id = ${filter.entityId}
				${filter.before ? sql`AND timestamp < ${timestampParam(filter.before)}` : sql``}
				${filter.after ? sql`AND timestamp > ${timestampParam(filter.after)}` : sql``}
				${
					filter.beforeCursor
						? sql`AND (timestamp, id) < (${timestampParam(filter.beforeCursor.timestamp)}, ${filter.beforeCursor.id})`
						: sql``
				}
				${
					filter.afterCursor
						? sql`AND (timestamp, id) > (${timestampParam(filter.afterCursor.timestamp)}, ${filter.afterCursor.id})`
						: sql``
				}
			ORDER BY timestamp DESC, id DESC
			LIMIT ${filter.limit ?? 50}
		`,
		signal,
	);
}
