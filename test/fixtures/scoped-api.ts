import type { MemoryClient, MemoryScope } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

/**
 * Behavior of the scoped API shared by every backend. `namespace` should be
 * unique per run so the checks see only their own rows.
 */

export async function verifyScopeVisibility(
	client: MemoryClient,
	namespace: string,
): Promise<void> {
	const entity: MemoryScope = { namespace, entityId: "alice" };
	const agentA: MemoryScope = { ...entity, agentId: "agent-a" };
	const agentB: MemoryScope = { ...entity, agentId: "agent-b" };
	const sessionA: MemoryScope = { ...agentA, sessionId: "session-1" };

	const shared = await client.add({
		scope: entity,
		content: "visibility shared",
	});
	const heldByA = await client.add({ scope: agentA, content: "visibility a" });
	const heldByB = await client.add({ scope: agentB, content: "visibility b" });
	const inSession = await client.add({
		scope: sessionA,
		content: "visibility session",
	});
	const otherEntity = await client.add({
		scope: { namespace, entityId: "bob" },
		content: "visibility bob",
	});
	const otherNamespace = await client.add({
		scope: { namespace: `${namespace}_other`, entityId: "alice" },
		content: "visibility other namespace",
	});

	expect(heldByA.scope).toEqual({
		namespace,
		entityId: "alice",
		agentId: "agent-a",
		sessionId: null,
	});

	async function visible(scope: MemoryScope, options = {}) {
		const result = await client.list({ scope, ...options });
		return result.memories.map((memory) => memory.id).sort();
	}

	// No agent: shared memories only.
	expect(await visible(entity)).toEqual([shared.id]);
	// An agent sees its own memories plus shared ones, never another agent's.
	expect(await visible(agentA)).toEqual([shared.id, heldByA.id].sort());
	expect(await visible(agentA, { exactAgent: true })).toEqual([heldByA.id]);
	expect(await visible(agentB)).toEqual([shared.id, heldByB.id].sort());
	// A session adds its own memories to the agent's.
	expect(await visible(sessionA)).toEqual(
		[shared.id, heldByA.id, inSession.id].sort(),
	);
	expect(await visible(sessionA, { exactSession: true })).toEqual(
		[inSession.id].sort(),
	);
	expect(
		await visible(sessionA, { exactAgent: true, exactSession: true }),
	).toEqual([inSession.id]);

	// Search follows the same rules.
	const searched = await client.search({
		scope: agentA,
		query: "visibility",
		limit: 10,
	});
	expect(searched.map((memory) => memory.id).sort()).toEqual(
		[shared.id, heldByA.id].sort(),
	);

	// Reads by id honor visibility.
	expect(await client.get({ scope: agentA, id: heldByB.id })).toBeNull();
	expect(await client.get({ scope: agentB, id: heldByB.id })).toMatchObject({
		id: heldByB.id,
	});
	expect(await client.get({ scope: entity, id: otherEntity.id })).toBeNull();
	expect(await client.get({ scope: entity, id: otherNamespace.id })).toBeNull();
	await expectMnemocyteError(
		client.delete({ scope: agentA, id: heldByB.id }),
		"NOT_FOUND",
	);

	// Stats select: an omitted agent or session matches any value.
	await expect(client.stats({ scope: entity })).resolves.toMatchObject({
		entityCount: 1,
		memoryCount: 4,
	});
	await expect(client.stats({ scope: { namespace } })).resolves.toMatchObject({
		entityCount: 2,
		memoryCount: 5,
	});
	await expect(client.stats({ scope: agentA })).resolves.toMatchObject({
		memoryCount: 2,
	});

	// deleteScope narrowed to a session leaves the rest.
	await expect(client.deleteScope({ scope: sessionA })).resolves.toEqual({
		deletedCount: 1,
	});
	// deleteScope for the entity erases every agent and session, nothing else.
	await expect(client.deleteScope({ scope: entity })).resolves.toEqual({
		deletedCount: 3,
	});
	await expect(client.stats({ scope: { namespace } })).resolves.toMatchObject({
		memoryCount: 1,
	});
	await expect(
		client.stats({ scope: { namespace: `${namespace}_other` } }),
	).resolves.toMatchObject({ memoryCount: 1 });
}

export async function verifyKeyedAdd(
	client: MemoryClient,
	namespace: string,
): Promise<void> {
	const scope: MemoryScope = { namespace, entityId: "alice" };
	const first = await client.add({
		scope,
		key: "timezone",
		content: "Timezone is Europe/Berlin.",
		kind: "fact",
		importance: "high",
		tags: ["profile"],
		source: "onboarding",
	});
	const second = await client.add({
		scope,
		key: "timezone",
		content: "Timezone is America/New_York.",
	});

	// Same row, new content; omitted fields go back to their defaults.
	expect(second.id).toBe(first.id);
	expect(second.key).toBe("timezone");
	expect(second.createdAt).toEqual(first.createdAt);
	expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(
		first.updatedAt.getTime(),
	);
	expect(second).toMatchObject({
		content: "Timezone is America/New_York.",
		kind: "fact",
		importance: "normal",
		tags: [],
		source: null,
	});
	expect((await client.list({ scope })).memories).toHaveLength(1);
	await expect(client.get({ scope, key: "timezone" })).resolves.toMatchObject({
		id: first.id,
		content: "Timezone is America/New_York.",
	});

	// The new content is what search finds.
	const [hit] = await client.search({ scope, query: "America New_York" });
	expect(hit?.id).toBe(first.id);

	// Keys are unique per exact scope: another agent or entity gets its own row.
	const agentScope = { ...scope, agentId: "agent-a" };
	const agentCopy = await client.add({
		scope: agentScope,
		key: "timezone",
		content: "Agent view of the timezone.",
	});
	expect(agentCopy.id).not.toBe(first.id);
	const bobCopy = await client.add({
		scope: { namespace, entityId: "bob" },
		key: "timezone",
		content: "Bob's timezone.",
	});
	expect(bobCopy.id).not.toBe(first.id);
	// get by key matches the exact scope only, not shared rows.
	await expect(
		client.get({ scope: agentScope, key: "timezone" }),
	).resolves.toMatchObject({ id: agentCopy.id });

	// A batch mixes inserts and keyed updates and keeps input order.
	const batch = await client.addMany({
		scope,
		memories: [
			{ content: "Unkeyed batch memory." },
			{ key: "timezone", content: "Timezone is Asia/Tokyo." },
			{ key: "language", content: "Speaks Japanese." },
		],
	});
	expect(batch.map((memory) => memory.content)).toEqual([
		"Unkeyed batch memory.",
		"Timezone is Asia/Tokyo.",
		"Speaks Japanese.",
	]);
	expect(batch[1]?.id).toBe(first.id);
	expect((await client.list({ scope })).memories).toHaveLength(3);

	// One call cannot use a key twice.
	await expectMnemocyteError(
		client.addMany({
			scope,
			memories: [
				{ key: "dup", content: "one" },
				{ key: "dup", content: "two" },
			],
		}),
		"VALIDATION",
	);

	// Concurrent adds with one key end in one row.
	const concurrent = await Promise.all(
		Array.from({ length: 5 }, (_, index) =>
			client.add({ scope, key: "race", content: `race ${index}` }),
		),
	);
	expect(new Set(concurrent.map((memory) => memory.id)).size).toBe(1);
	const raced = expectDefined(await client.get({ scope, key: "race" }));
	expect(raced.id).toBe(concurrent[0]?.id);
}

export async function verifyKeyedAddAudit(
	client: MemoryClient,
	namespace: string,
): Promise<void> {
	const scope: MemoryScope = { namespace, entityId: "alice" };
	const created = await client.add({ scope, key: "k", content: "first" });
	await client.add({ scope, key: "k", content: "second" });
	const log = await client.listAuditLog({ scope });
	expect(log.map((event) => event.description).sort()).toEqual([
		"memory.created",
		"memory.updated",
	]);
	for (const event of log) {
		expect(event.metadata.memoryId).toBe(created.id);
		expect(event.metadata.key).toBe("k");
	}
}

export async function verifyListPaging(
	client: MemoryClient,
	namespace: string,
): Promise<void> {
	const scope: MemoryScope = { namespace, entityId: "pager" };
	const added = await client.addMany({
		scope,
		memories: Array.from({ length: 7 }, (_, index) => ({
			content: `page item ${index}`,
			kind: index % 2 === 0 ? ("fact" as const) : ("episode" as const),
		})),
	});
	// Same createdAt for the whole batch: ties are broken by id.
	const expectedOrder = [...added]
		.sort(
			(a, b) =>
				b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1),
		)
		.map((memory) => memory.id);

	const seen: string[] = [];
	let cursor: string | undefined;
	let pages = 0;
	do {
		const page = await client.list({
			scope,
			limit: 3,
			...(cursor === undefined ? {} : { cursor }),
		});
		pages += 1;
		seen.push(...page.memories.map((memory) => memory.id));
		cursor = page.nextCursor ?? undefined;
	} while (cursor !== undefined);
	expect(pages).toBe(3);
	expect(seen).toEqual(expectedOrder);

	// An exact page size ends with a null cursor, not an empty page.
	const all = await client.list({ scope, limit: 7 });
	expect(all.memories).toHaveLength(7);
	expect(all.nextCursor).toBeNull();

	// Filters apply.
	const episodes = await client.list({ scope, kinds: ["episode"] });
	expect(episodes.memories).toHaveLength(3);

	// A cursor stays valid when rows are deleted between pages.
	const first = await client.list({ scope, limit: 2 });
	await client.delete({ scope, id: expectDefined(expectedOrder[2]) });
	const second = await client.list({
		scope,
		limit: 10,
		cursor: expectDefined(first.nextCursor ?? undefined),
	});
	expect(second.memories.map((memory) => memory.id)).toEqual(
		expectedOrder.slice(3),
	);

	for (const cursor of ["", "not a cursor", "W10", btoa('["x","y"]')]) {
		await expectMnemocyteError(client.list({ scope, cursor }), "VALIDATION");
	}
	await expectMnemocyteError(client.list({ scope, limit: 0 }), "VALIDATION");
}

export async function verifyUpdate(
	client: MemoryClient,
	namespace: string,
	embedCalls: () => number,
): Promise<void> {
	const scope: MemoryScope = { namespace, entityId: "alice" };
	const memory = await client.add({
		scope,
		key: "color",
		content: "Favorite color is blue.",
		tags: ["prefs"],
		source: "chat",
		expiresAt: new Date("2030-01-01T00:00:00.000Z"),
	});
	await client.add({ scope, key: "food", content: "Likes ramen." });

	// Field-only updates do not call the embedder.
	const before = embedCalls();
	const retagged = await client.update({
		scope,
		id: memory.id,
		tags: ["prefs", " colors ", "prefs"],
		importance: "high",
		source: null,
		expiresAt: null,
	});
	expect(embedCalls()).toBe(before);
	expect(retagged).toMatchObject({
		id: memory.id,
		content: "Favorite color is blue.",
		tags: ["prefs", "colors"],
		importance: "high",
		source: null,
		expiresAt: null,
		key: "color",
	});
	expect(retagged.createdAt).toEqual(memory.createdAt);

	// A content change re-embeds and search finds the new text.
	const rewritten = await client.update({
		scope,
		id: memory.id,
		content: "Favorite color is green.",
		metadata: { changed: true },
	});
	expect(embedCalls()).toBe(before + 1);
	expect(rewritten.content).toBe("Favorite color is green.");
	expect(rewritten.metadata).toEqual({ changed: true });
	const [hit] = await client.search({ scope, query: "green" });
	expect(hit?.id).toBe(memory.id);

	// Keys: clearing, a collision, and a free key.
	await expectMnemocyteError(
		client.update({ scope, id: memory.id, key: "food" }),
		"CONFLICT",
	);
	await expect(
		client.update({ scope, id: memory.id, key: null }),
	).resolves.toMatchObject({ key: null });
	await expect(
		client.update({ scope, id: memory.id, key: "colour" }),
	).resolves.toMatchObject({ key: "colour" });

	// Missing, invisible and malformed updates.
	await expectMnemocyteError(
		client.update({
			scope,
			id: "00000000-0000-7000-8000-000000000000",
			kind: "fact",
		}),
		"NOT_FOUND",
	);
	await expectMnemocyteError(
		client.update({
			scope: { namespace, entityId: "bob" },
			id: memory.id,
			kind: "fact",
		}),
		"NOT_FOUND",
	);
	await expectMnemocyteError(
		client.update({ scope, id: memory.id }),
		"VALIDATION",
	);
	await expectMnemocyteError(
		client.update({ scope, id: memory.id, content: "" }),
		"VALIDATION",
	);
}

export async function verifyGetAndScopeValidation(
	client: MemoryClient,
	namespace: string,
): Promise<void> {
	const scope: MemoryScope = { namespace, entityId: "alice" };
	const memory = await client.add({ scope, content: "get me" });
	await expect(client.get({ scope, id: memory.id })).resolves.toMatchObject({
		id: memory.id,
		content: "get me",
	});
	await expect(client.get({ scope, id: "not-a-uuid" })).resolves.toBeNull();
	await expect(client.get({ scope, key: "missing" })).resolves.toBeNull();
	await expectMnemocyteError(
		client.get({ scope, id: memory.id, key: "both" } as never),
		"VALIDATION",
	);
	await expectMnemocyteError(client.get({ scope } as never), "VALIDATION");

	for (const bad of [
		undefined,
		{},
		{ namespace },
		{ entityId: "alice" },
		{ namespace: " ", entityId: "alice" },
		{ namespace, entityId: "alice", agentId: "" },
		{ namespace, entityId: "alice", sessionId: 3 },
	]) {
		await expectMnemocyteError(
			client.search({ scope: bad as never, query: "x" }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			client.add({ scope: bad as never, content: "x" }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			client.deleteScope({ scope: bad as never }),
			"VALIDATION",
		);
	}
	await expectMnemocyteError(client.stats({} as never), "VALIDATION");
	await expectMnemocyteError(
		client.stats({ scope: { namespace }, allNamespaces: true } as never),
		"VALIDATION",
	);
}
