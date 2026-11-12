import type { StoreEntitySelector, StoreScope } from "../../memory/store.js";
import type { SqlExecutor } from "../../sql/executor.js";
import type { AuditLogCursor, JsonObject } from "../../types.js";
import { chunk, INSERT_CHUNK_ROWS, runAtomically } from "../atomic.js";
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

export interface NewEventRow {
	id: string;
	scope: StoreScope;
	description: string;
	metadata: JsonObject;
	timestamp: Date;
}

/**
 * Insert audit events with one multi-row `INSERT` per
 * {@link INSERT_CHUNK_ROWS} events, all or nothing.
 */
export async function insertEvents(
	db: SqlExecutor,
	rows: readonly NewEventRow[],
): Promise<void> {
	if (rows.length === 0) {
		return;
	}
	const statements = chunk(rows, INSERT_CHUNK_ROWS).map((part) => {
		const params = createSqlParams();
		const tuples = part.map(
			(row) => `(
				${params.uuid(row.id)},
				${params.add(row.scope.namespace)},
				${params.add(row.scope.entityId)},
				${params.add(row.scope.agentId)}::text,
				${params.add(row.scope.sessionId)}::text,
				${params.add(row.description)},
				${params.json(row.metadata)},
				${params.timestamp(row.timestamp)}
			)`,
		);
		return {
			sql: `INSERT INTO mnemocyte_events (
				id, namespace, entity_id, agent_id, session_id, description, metadata,
				timestamp
			)
			VALUES ${tuples.join(",\n")}`,
			params: params.values,
		};
	});
	await runAtomically(db, statements);
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
