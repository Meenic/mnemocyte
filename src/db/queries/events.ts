import { and, desc, eq, gt, lt } from "drizzle-orm";
import { MnemocyteError } from "../../errors.js";
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
): Promise<EventRow[]> {
	return db
		.select()
		.from(eventsTable)
		.where(
			and(
				eq(eventsTable.entityId, filter.entityId),
				filter.before ? lt(eventsTable.timestamp, filter.before) : undefined,
				filter.after ? gt(eventsTable.timestamp, filter.after) : undefined,
			),
		)
		.orderBy(desc(eventsTable.timestamp))
		.limit(filter.limit ?? 50);
}

export async function deleteEventsForEntity(
	db: MnemocyteDatabase,
	entityId: string,
): Promise<number> {
	const result = await db
		.delete(eventsTable)
		.where(eq(eventsTable.entityId, entityId))
		.returning({ id: eventsTable.id });
	return result.length;
}
