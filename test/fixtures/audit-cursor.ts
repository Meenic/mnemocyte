import type {
	AuditEvent,
	ListAuditLogInput,
	ListAuditLogResult,
	MemoryClient,
} from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";
import type { ScopeFor } from "./survivor-deletes.js";

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function compareNewestFirst(a: AuditEvent, b: AuditEvent): number {
	const timestampDifference = b.timestamp.getTime() - a.timestamp.getTime();
	if (timestampDifference !== 0) {
		return timestampDifference;
	}
	if (a.id === b.id) {
		return 0;
	}
	return a.id < b.id ? 1 : -1;
}

function ids(events: readonly AuditEvent[]): string[] {
	return events.map((event) => event.id);
}

/** Base64url of a JSON value, the encoding of every Mnemocyte cursor. */
function encode(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Every page of a listing, following `nextCursor` until it is `null`. Pages
 * other than the last must be full.
 */
export async function allPages(
	list: (cursor: string | undefined) => Promise<ListAuditLogResult>,
	limit: number,
): Promise<{ events: AuditEvent[]; pages: number }> {
	const events: AuditEvent[] = [];
	let cursor: string | undefined;
	let pages = 0;
	for (;;) {
		const page = await list(cursor);
		pages += 1;
		events.push(...page.events);
		if (page.nextCursor === null) {
			return { events, pages };
		}
		expect(page.events).toHaveLength(limit);
		cursor = page.nextCursor;
	}
}

/**
 * `listAuditLog` pages: entity, namespace and all-namespace selectors,
 * events sharing a timestamp, the `before` / `after` filters next to a
 * cursor, bound clients and malformed cursors. The client must have audit
 * enabled; `scopeFor` and `otherScopeFor` must be namespaces no one else
 * writes to.
 */
export async function verifyAuditPages(input: {
	client: MemoryClient;
	scopeFor: ScopeFor;
	otherScopeFor: ScopeFor;
}): Promise<void> {
	const { client, scopeFor, otherScopeFor } = input;
	const alice = scopeFor("pages_alice");
	const bob = scopeFor("pages_bob");
	const carol = otherScopeFor("pages_carol");
	const namespace = { namespace: alice.namespace };

	// Four `memory.created` events with one timestamp, then three
	// `memory.superseded` with another, then one newer event per entity.
	const memories = await client.addMany({
		scope: alice,
		memories: [
			{ content: "survivor" },
			{ content: "loser one" },
			{ content: "loser two" },
			{ content: "loser three" },
		],
	});
	const survivor = expectDefined(memories[0]);
	await pause(5);
	await client.consolidate({
		scope: alice,
		survivorId: survivor.id,
		supersededIds: memories.slice(1).map((memory) => memory.id),
	});
	await pause(5);
	await client.add({ scope: bob, content: "bob" });
	await pause(5);
	await client.add({ scope: carol, content: "carol" });
	await pause(5);
	await client.add({ scope: alice, content: "newest" });

	const entityScope = { namespace: alice.namespace, entityId: alice.entityId };
	const whole = await client.listAuditLog({ scope: entityScope, limit: 100 });
	expect(whole.nextCursor).toBeNull();
	expect(whole.events).toHaveLength(8);
	expect(whole.events).toEqual([...whole.events].sort(compareNewestFirst));
	expect(whole.events.map((event) => event.type)).toEqual([
		"memory.created",
		"memory.superseded",
		"memory.superseded",
		"memory.superseded",
		"memory.created",
		"memory.created",
		"memory.created",
		"memory.created",
	]);

	// One event per page walks every event once, across shared timestamps.
	const single = await allPages(
		(cursor) =>
			client.listAuditLog({
				scope: entityScope,
				limit: 1,
				...(cursor === undefined ? {} : { cursor }),
			}),
		1,
	);
	expect(ids(single.events)).toEqual(ids(whole.events));
	expect(single.pages).toBe(8);

	// An exact last page ends with `null`, without an empty page after it.
	const exact = await client.listAuditLog({ scope: entityScope, limit: 4 });
	expect(exact.nextCursor).not.toBeNull();
	const last = await client.listAuditLog({
		scope: entityScope,
		limit: 4,
		cursor: expectDefined(exact.nextCursor),
	});
	expect(ids(last.events)).toEqual(ids(whole.events.slice(4)));
	expect(last.nextCursor).toBeNull();

	// A namespace selector lists every entity in it, and no other namespace.
	const bobEvents = (
		await client.listAuditLog({
			scope: { namespace: bob.namespace, entityId: bob.entityId },
		})
	).events;
	expect(bobEvents).toHaveLength(1);
	const namespaceEvents = [...whole.events, ...bobEvents].sort(
		compareNewestFirst,
	);
	const namespacePages = await allPages(
		(cursor) =>
			client.listAuditLog({
				scope: namespace,
				limit: 2,
				...(cursor === undefined ? {} : { cursor }),
			}),
		2,
	);
	expect(ids(namespacePages.events)).toEqual(ids(namespaceEvents));

	// Agents and sessions narrow a selector; shared events have neither.
	expect(
		(
			await client.listAuditLog({
				scope: { ...entityScope, agentId: "nobody" },
			})
		).events,
	).toEqual([]);

	// `allNamespaces` reaches both namespaces. Other namespaces may hold
	// events too, so compare only these two.
	const carolEvents = (
		await client.listAuditLog({
			scope: { namespace: carol.namespace, entityId: carol.entityId },
		})
	).events;
	expect(carolEvents).toHaveLength(1);
	const everywhere = await allPages(
		(cursor) =>
			client.listAuditLog({
				allNamespaces: true,
				limit: 3,
				...(cursor === undefined ? {} : { cursor }),
			}),
		3,
	);
	const ours = new Set([alice.namespace, carol.namespace]);
	expect(
		ids(everywhere.events.filter((event) => ours.has(event.scope.namespace))),
	).toEqual(ids([...namespaceEvents, ...carolEvents].sort(compareNewestFirst)));
	expect(new Set(ids(everywhere.events)).size).toBe(everywhere.events.length);

	// `before` and `after` filter every page; the cursor keeps paging inside
	// them. Both are strict, so the boundary timestamp's events are left out.
	const superseded = expectDefined(whole.events[1]);
	const created = expectDefined(whole.events.at(-1));
	const olderThanSuperseded = await allPages(
		(cursor) =>
			client.listAuditLog({
				scope: entityScope,
				before: superseded.timestamp,
				limit: 3,
				...(cursor === undefined ? {} : { cursor }),
			}),
		3,
	);
	expect(ids(olderThanSuperseded.events)).toEqual(ids(whole.events.slice(4)));
	const between = await client.listAuditLog({
		scope: entityScope,
		after: created.timestamp,
		before: expectDefined(whole.events[0]).timestamp,
	});
	expect(ids(between.events)).toEqual(ids(whole.events.slice(1, 4)));

	// A bound client lists within its scope and pages the same way.
	const bound = client.for(entityScope);
	const boundPages = await allPages(
		(cursor) => bound.listAuditLog({ limit: 3, ...(cursor ? { cursor } : {}) }),
		3,
	);
	expect(ids(boundPages.events)).toEqual(ids(whole.events));
	expect((await bound.listAuditLog()).events).toHaveLength(8);

	// Cursors from other methods, other formats and tampered positions.
	const listCursor = expectDefined(
		(await client.list({ scope: alice, limit: 1 })).nextCursor,
	);
	const firstPage = await client.listAuditLog({ scope: entityScope, limit: 1 });
	const decoded = JSON.parse(
		Buffer.from(expectDefined(firstPage.nextCursor), "base64url").toString(),
	) as [string, string, string];
	expect(decoded[0]).toBe("a1");
	expect(decoded[1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
	expect(decoded[2]).toBe(expectDefined(firstPage.events[0]).id);
	const [, timestamp, id] = decoded;
	for (const cursor of [
		listCursor,
		"not a cursor",
		"",
		encode(["a1", timestamp]),
		encode(["d1", timestamp, id]),
		encode(["a1", timestamp.replace(/\d{3}Z$/, "Z"), id]),
		encode(["a1", "2026-02-30T00:00:00.000000Z", id]),
		encode(["a1", timestamp, "not-a-uuid"]),
		encode({ timestamp, id }),
		42,
	]) {
		await expectMnemocyteError(
			client.listAuditLog({
				scope: entityScope,
				cursor,
			} as ListAuditLogInput),
			"VALIDATION",
		);
	}
}
