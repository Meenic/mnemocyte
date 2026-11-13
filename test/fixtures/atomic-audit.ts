import type { AuditEvent, Memory, MemoryClient, MemoryScope } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";
import type { ScopeFor } from "./survivor-deletes.js";

const UUID_V7 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function recordScope(scope: MemoryScope) {
	return {
		namespace: scope.namespace ?? "",
		entityId: scope.entityId,
		agentId: scope.agentId ?? null,
		sessionId: scope.sessionId ?? null,
	};
}

/** JSON with sorted keys: `jsonb` returns object keys in its own order. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonical).join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** An event without its id and timestamp, in a stable order for comparison. */
function shapes(
	events: readonly Pick<AuditEvent, "description" | "scope" | "metadata">[],
) {
	return events
		.map((event) => ({
			description: event.description,
			scope: event.scope,
			metadata: event.metadata,
		}))
		.sort((a, b) => canonical(a).localeCompare(canonical(b)));
}

async function auditLog(
	memory: MemoryClient,
	scope: MemoryScope,
): Promise<AuditEvent[]> {
	return memory.listAuditLog({
		scope: {
			namespace: expectDefined(scope.namespace),
			entityId: scope.entityId,
		},
		limit: 1000,
	});
}

function eventFor(
	events: readonly AuditEvent[],
	description: string,
	memoryId: string,
): AuditEvent {
	return expectDefined(
		events.find(
			(event) =>
				event.description === description &&
				event.metadata.memoryId === memoryId,
		),
		`no ${description} event for ${memoryId}`,
	);
}

/**
 * Every write path records the same audit payloads on every backend. The
 * memory client must have audit enabled.
 */
export async function verifyAuditPayloads(
	memory: MemoryClient,
	scopeFor: ScopeFor,
): Promise<void> {
	const scope = scopeFor("payloads", { agentId: "agent_a" });
	const entity = scopeFor("payloads");
	const written = recordScope(scope);

	const plain = await memory.add({
		scope,
		content: "Plain memory.",
		kind: "preference",
		importance: "high",
	});
	const keyed = await memory.add({ scope, key: "drink", content: "Tea." });
	const rekeyed = await memory.add({ scope, key: "drink", content: "Coffee." });
	expect(rekeyed.id).toBe(keyed.id);
	const [batched, batchKeyed] = await memory.addMany({
		scope,
		memories: [
			{ content: "Batched memory." },
			{ key: "drink", content: "Water.", importance: "low" },
		],
	});
	expect(expectDefined(batchKeyed).id).toBe(keyed.id);
	const updated = await memory.update({
		scope,
		id: plain.id,
		content: "Plain memory, changed.",
		tags: ["changed"],
	});
	const survivor = expectDefined(batched);
	await memory.consolidate({
		scope,
		survivorId: survivor.id,
		supersededIds: [plain.id],
	});
	await memory.delete({ scope, id: survivor.id, dependents: "restore" });
	const [root, leaf] = await memory.addMany({
		scope,
		memories: [{ content: "Tree root." }, { content: "Tree leaf." }],
	});
	const rootId = expectDefined(root).id;
	const leafId = expectDefined(leaf).id;
	await memory.consolidate({
		scope,
		survivorId: rootId,
		supersededIds: [leafId],
	});
	await memory.delete({ scope, id: rootId, dependents: "delete" });
	await memory.delete({ scope, id: keyed.id });
	const expired = await memory.add({
		scope,
		content: "Expired memory.",
		expiresAt: new Date(Date.now() - 60_000),
	});
	await expect(
		memory.prune({ scope: entity, expired: true }),
	).resolves.toMatchObject({ deletedCount: 1 });

	const events = await auditLog(memory, entity);
	const created = (memoryId: string, extra: object = {}) => ({
		description: "memory.created",
		scope: written,
		metadata: { memoryId, kind: "fact", importance: "normal", ...extra },
	});
	expect(shapes(events)).toEqual(
		shapes([
			{
				description: "memory.created",
				scope: written,
				metadata: {
					memoryId: plain.id,
					kind: "preference",
					importance: "high",
				},
			},
			created(keyed.id, { key: "drink" }),
			{
				description: "memory.updated",
				scope: written,
				metadata: {
					memoryId: keyed.id,
					kind: "fact",
					importance: "normal",
					key: "drink",
				},
			},
			created(survivor.id),
			{
				description: "memory.updated",
				scope: written,
				metadata: {
					memoryId: keyed.id,
					kind: "fact",
					importance: "low",
					key: "drink",
				},
			},
			{
				description: "memory.updated",
				scope: written,
				metadata: { memoryId: plain.id, fields: ["content", "tags"] },
			},
			{
				description: "memory.superseded",
				scope: written,
				metadata: { memoryId: plain.id, supersededBy: survivor.id },
			},
			{
				description: "memory.deleted",
				scope: written,
				metadata: { memoryId: survivor.id, restoredIds: [plain.id] },
			},
			created(rootId),
			created(leafId),
			{
				description: "memory.superseded",
				scope: written,
				metadata: { memoryId: leafId, supersededBy: rootId },
			},
			{
				description: "memory.deleted",
				scope: written,
				metadata: { memoryId: rootId },
			},
			{
				description: "memory.deleted",
				scope: written,
				metadata: { memoryId: leafId, deletedWith: rootId },
			},
			{
				description: "memory.deleted",
				scope: written,
				metadata: { memoryId: keyed.id },
			},
			created(expired.id),
			{
				description: "memory.pruned",
				scope: recordScope(entity),
				metadata: { count: 1 },
			},
		]),
	);

	// Ids are UUIDv7 whether JavaScript or SQL generated them, and the
	// events of a write carry that write's time.
	for (const event of events) {
		expect(event.id).toMatch(UUID_V7);
	}
	expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
	expect(eventFor(events, "memory.created", plain.id).timestamp).toEqual(
		plain.updatedAt,
	);
	const update = events.find(
		(event) =>
			event.description === "memory.updated" &&
			event.metadata.memoryId === plain.id,
	);
	expect(expectDefined(update).timestamp).toEqual(updated.updatedAt);
}

/** Every memory of the entity, superseded and expired included, by id. */
async function snapshot(
	memory: MemoryClient,
	scope: MemoryScope,
): Promise<Memory[]> {
	const page = await memory.list({
		scope,
		includeSuperseded: true,
		includeExpired: true,
		limit: 1000,
	});
	return page.memories.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * With audit enabled and every audit insert in the scope's namespace
 * failing (`failAudit`), each write path rejects with `"DB"` and writes
 * nothing: no memory row changes and no event is added.
 */
export async function verifyAuditFailureRollsBack(
	memory: MemoryClient,
	scopeFor: ScopeFor,
	failAudit: (failing: boolean) => Promise<void>,
): Promise<void> {
	const scope = scopeFor("rollback");
	const plain = await memory.add({ scope, content: "Plain." });
	const keyed = await memory.add({ scope, key: "drink", content: "Tea." });
	const [survivor, loser] = await memory.addMany({
		scope,
		memories: [{ content: "Survivor." }, { content: "Loser." }],
	});
	const survivorId = expectDefined(survivor).id;
	await memory.consolidate({
		scope,
		survivorId,
		supersededIds: [expectDefined(loser).id],
	});
	await memory.add({
		scope,
		content: "Expired.",
		expiresAt: new Date(Date.now() - 60_000),
	});
	const before = await snapshot(memory, scope);
	const eventsBefore = await auditLog(memory, scope);

	await failAudit(true);
	try {
		await expectMnemocyteError(memory.add({ scope, content: "New." }), "DB");
		await expectMnemocyteError(
			memory.add({ scope, key: "drink", content: "Coffee." }),
			"DB",
		);
		// More than one insert chunk: the first chunk rolls back too.
		await expectMnemocyteError(
			memory.addMany({
				scope,
				memories: Array.from({ length: 260 }, (_, index) => ({
					content: `Batch ${index}.`,
				})),
			}),
			"DB",
		);
		await expectMnemocyteError(
			memory.update({ scope, id: plain.id, content: "Changed." }),
			"DB",
		);
		await expectMnemocyteError(memory.delete({ scope, id: keyed.id }), "DB");
		await expectMnemocyteError(
			memory.delete({ scope, id: survivorId, dependents: "restore" }),
			"DB",
		);
		await expectMnemocyteError(
			memory.delete({ scope, id: survivorId, dependents: "delete" }),
			"DB",
		);
		await expectMnemocyteError(memory.prune({ scope, expired: true }), "DB");
		await expectMnemocyteError(
			memory.consolidate({
				scope,
				survivorId: plain.id,
				supersededIds: [keyed.id],
			}),
			"DB",
		);
	} finally {
		await failAudit(false);
	}

	expect(await snapshot(memory, scope)).toEqual(before);
	expect(await auditLog(memory, scope)).toEqual(eventsBefore);
}
