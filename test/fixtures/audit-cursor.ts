import type { AuditEvent, AuditLogCursor, MnemocyteClient } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined } from "../helpers.js";

function toCursor(event: AuditEvent): AuditLogCursor {
	return { timestamp: event.timestamp, id: event.id };
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

export async function verifyAuditCursorPagination(
	client: MnemocyteClient,
	entityId: string,
): Promise<void> {
	const memories = await client.rememberMany({
		inputs: [
			{ entityId, content: "survivor" },
			{ entityId, content: "loser one" },
			{ entityId, content: "loser two" },
			{ entityId, content: "loser three" },
		],
	});
	const survivor = expectDefined(memories[0]);
	const losers = memories.slice(1);
	await new Promise((resolve) => setTimeout(resolve, 5));
	await client.experimental.consolidate({
		entityId,
		survivorId: survivor.id,
		supersededIds: losers.map((memory) => memory.id),
	});

	const firstPage = await client.listAuditLog({ entityId, limit: 1 });
	const first = expectDefined(firstPage[0]);
	expect(first.description).toBe("memory.superseded");

	const secondPage = await client.listAuditLog({
		entityId,
		limit: 1,
		beforeCursor: toCursor(first),
	});
	const second = expectDefined(secondPage[0]);
	expect(second.description).toBe("memory.superseded");

	const thirdPage = await client.listAuditLog({
		entityId,
		limit: 1,
		beforeCursor: toCursor(second),
	});
	const third = expectDefined(thirdPage[0]);
	expect(third.description).toBe("memory.superseded");
	expect(new Set([first.id, second.id, third.id]).size).toBe(3);
	expect(second.timestamp).toEqual(first.timestamp);
	expect(third.timestamp).toEqual(first.timestamp);

	const timestampFiltered = await client.listAuditLog({
		entityId,
		limit: 100,
		before: first.timestamp,
	});
	expect(
		timestampFiltered.filter(
			(event) => event.description === "memory.superseded",
		),
	).toEqual([]);

	const newerThanThird = await client.listAuditLog({
		entityId,
		limit: 2,
		afterCursor: toCursor(third),
	});
	expect(newerThanThird.map((event) => event.id)).toEqual([
		first.id,
		second.id,
	]);

	await new Promise((resolve) => setTimeout(resolve, 5));
	await client.remember({ entityId, content: "newest mixed-timestamp event" });

	const allEvents = await client.listAuditLog({ entityId, limit: 100 });
	expect(allEvents).toEqual([...allEvents].sort(compareNewestFirst));

	const pagedEvents: AuditEvent[] = [];
	let beforeCursor: AuditLogCursor | undefined;
	for (;;) {
		const page = await client.listAuditLog({
			entityId,
			limit: 2,
			...(beforeCursor === undefined ? {} : { beforeCursor }),
		});
		if (page.length === 0) {
			break;
		}
		pagedEvents.push(...page);
		beforeCursor = toCursor(expectDefined(page.at(-1)));
	}

	expect(pagedEvents.map((event) => event.id)).toEqual(
		allEvents.map((event) => event.id),
	);
	expect(new Set(pagedEvents.map((event) => event.id)).size).toBe(
		allEvents.length,
	);
}
