import type { StoreEntitySelector } from "../../memory/store.js";
import type { SqlExecutor } from "../../sql/executor.js";
import type { AuditLogCursor } from "../../types.js";
import {
	EVENT_COLUMNS,
	type EventRow,
	type RawEventRow,
	toEventRow,
} from "../rows.js";
import { createSqlParams } from "../sql.js";
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
