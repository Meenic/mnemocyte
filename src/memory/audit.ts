import type { AuditEvent, JsonObject, Memory } from "../types.js";
import { createEventId } from "./records.js";
import type { StoreScope, StoreSelector } from "./store.js";

/**
 * Audit event payloads. The in-memory store builds its events here; the
 * Postgres store builds the same JSON in SQL (`src/db/queries/memories.ts`),
 * and the shared store contract checks that both agree.
 */

function event(
	scope: StoreScope,
	description: string,
	metadata: JsonObject,
	timestamp: Date,
): AuditEvent {
	return {
		id: createEventId(),
		scope: { ...scope },
		description,
		metadata,
		timestamp: new Date(timestamp),
	};
}

/** `memory.created`, or `memory.updated` for a keyed add that updated a row. */
export function writtenEvent(memory: Memory, created: boolean): AuditEvent {
	return event(
		memory.scope,
		created ? "memory.created" : "memory.updated",
		{
			memoryId: memory.id,
			kind: memory.kind,
			importance: memory.importance,
			...(memory.key === null ? {} : { key: memory.key }),
		},
		memory.updatedAt,
	);
}

/** `memory.updated` for `update`, listing the changed fields. */
export function updatedEvent(
	memory: Memory,
	fields: readonly string[],
): AuditEvent {
	return event(
		memory.scope,
		"memory.updated",
		{ memoryId: memory.id, fields: [...fields] },
		memory.updatedAt,
	);
}

/**
 * One `memory.deleted` per deleted memory: `{ memoryId, restoredIds? }` for
 * the one asked for, `{ memoryId, deletedWith }` for each dependent.
 */
export function deletedEvents(input: {
	scope: StoreScope;
	memoryId: string;
	deletedIds: readonly string[];
	restoredIds: readonly string[];
	now: Date;
}): AuditEvent[] {
	return input.deletedIds.map((memoryId) =>
		event(
			input.scope,
			"memory.deleted",
			memoryId === input.memoryId
				? {
						memoryId,
						...(input.restoredIds.length > 0
							? { restoredIds: [...input.restoredIds] }
							: {}),
					}
				: { memoryId, deletedWith: input.memoryId },
			input.now,
		),
	);
}

/** `memory.pruned` for one entity, at the prune selector's agent and session. */
export function prunedEvent(input: {
	selector: StoreSelector;
	namespace: string;
	entityId: string;
	count: number;
	now: Date;
}): AuditEvent {
	return event(
		{
			namespace: input.namespace,
			entityId: input.entityId,
			agentId: input.selector.agentId ?? null,
			sessionId: input.selector.sessionId ?? null,
		},
		"memory.pruned",
		{ count: input.count },
		input.now,
	);
}

/** `memory.superseded` for one loser, in the caller's scope. */
export function supersededEvent(input: {
	scope: StoreScope;
	memoryId: string;
	survivorId: string;
	now: Date;
}): AuditEvent {
	return event(
		input.scope,
		"memory.superseded",
		{ memoryId: input.memoryId, supersededBy: input.survivorId },
		input.now,
	);
}
