import type { MemoryClient, MemoryWithScore } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError, testScope } from "../helpers.js";

async function listEntityMemories(
	client: Omit<MemoryClient, "for">,
	entityId: string,
): Promise<MemoryWithScore[]> {
	return client.search({
		scope: testScope(entityId),
		query: "duplicate consolidation ids",
		limit: 20,
		minScore: 0,
		includeSuperseded: true,
	});
}

async function listSupersededEvents(
	client: Omit<MemoryClient, "for">,
	entityId: string,
) {
	return (
		await client.listAuditLog({ scope: testScope(entityId), limit: 20 })
	).filter((event) => event.description === "memory.superseded");
}

export async function exerciseConsolidationDuplicateIdPolicy(params: {
	client: Omit<MemoryClient, "for">;
	entityPrefix: string;
	afterDuplicateRejection?: () => void | Promise<void>;
}): Promise<void> {
	const { client, entityPrefix, afterDuplicateRejection } = params;
	const entityId = `${entityPrefix}_duplicate_ids`;
	const [survivor, loser] = await client.addMany({
		scope: testScope(entityId),
		memories: [
			{ content: "survivor", tags: ["base"] },
			{ content: "loser", tags: ["loser"] },
		],
	});
	const definedSurvivor = expectDefined(survivor);
	const definedLoser = expectDefined(loser);

	await expectMnemocyteError(
		client.experimental.consolidate({
			scope: testScope(entityId),
			survivorId: definedSurvivor.id,
			supersededIds: [definedLoser.id, definedLoser.id],
		}),
		"VALIDATION",
	);
	await afterDuplicateRejection?.();

	const afterRejection = await listEntityMemories(client, entityId);
	expect(
		expectDefined(
			afterRejection.find((memory) => memory.id === definedLoser.id),
		).supersededBy,
	).toBe(null);
	expect([
		...expectDefined(
			afterRejection.find((memory) => memory.id === definedSurvivor.id),
		).tags,
	]).toEqual(["base"]);
	expect(await listSupersededEvents(client, entityId)).toHaveLength(0);

	await expect(
		client.experimental.consolidate({
			scope: testScope(entityId),
			survivorId: definedSurvivor.id,
			supersededIds: [definedLoser.id],
		}),
	).resolves.toEqual({
		survivorId: definedSurvivor.id,
		supersededCount: 1,
		supersededIds: [definedLoser.id],
	});
	await expect(
		client.experimental.consolidate({
			scope: testScope(entityId),
			survivorId: definedSurvivor.id,
			supersededIds: [definedLoser.id],
		}),
	).resolves.toEqual({
		survivorId: definedSurvivor.id,
		supersededCount: 0,
		supersededIds: [],
	});

	const afterValidCall = await listEntityMemories(client, entityId);
	expect(
		expectDefined(
			afterValidCall.find((memory) => memory.id === definedLoser.id),
		).supersededBy,
	).toBe(definedSurvivor.id);
	expect(
		[
			...expectDefined(
				afterValidCall.find((memory) => memory.id === definedSurvivor.id),
			).tags,
		].sort(),
	).toEqual(["base", "loser"]);
	const events = await listSupersededEvents(client, entityId);
	expect(events).toHaveLength(1);
	expect(expectDefined(events[0]).metadata).toEqual({
		memoryId: definedLoser.id,
		supersededBy: definedSurvivor.id,
	});
}
