import { sql } from "drizzle-orm";
import { MnemocyteError } from "../../errors.js";
import { executeCancelableSql } from "../cancellation.js";
import type { MnemocyteDatabase } from "../index.js";
import { type EventRow, eventsTable, type NewEventRow } from "../schema.js";

export interface EventFilter {
	entityId: string;
	limit?: number;
	before?: Date;
	after?: Date;
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
				${filter.before ? sql`AND timestamp < ${filter.before}` : sql``}
				${filter.after ? sql`AND timestamp > ${filter.after}` : sql``}
			ORDER BY timestamp DESC
			LIMIT ${filter.limit ?? 50}
		`,
		signal,
	);
}
