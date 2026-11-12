import type { MemoryClient, MemoryWithScore } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError, testScope } from "../helpers.js";

async function listEntityMemories(
	client: MemoryClient,
	entityId: string,
): Promise<MemoryWithScore[]> {
	return client.search({
		scope: testScope(entityId),
		query: "consolidation deletion policy",
		limit: 20,
		minScore: 0,
		includeExpired: true,
		includeSuperseded: true,
	});
}

async function createConsolidatedPair(
	client: MemoryClient,
	entityId: string,
	options: { survivorExpired?: boolean } = {},
) {
	const [survivor, loser] = await client.addMany({
		scope: testScope(entityId),
		memories: [
			{
				content: `${entityId} survivor`,
				...(options.survivorExpired === true
					? { expiresAt: new Date(Date.now() - 60_000) }
					: {}),
			},
			{
				content: `${entityId} loser`,
			},
		],
	});
	const definedSurvivor = expectDefined(survivor);
	const definedLoser = expectDefined(loser);
	await client.experimental.consolidate({
		scope: testScope(entityId),
		survivorId: definedSurvivor.id,
		supersededIds: [definedLoser.id],
	});
	return { survivor: definedSurvivor, loser: definedLoser };
}

async function expectPairUnchanged(
	client: MemoryClient,
	entityId: string,
	survivorId: string,
	loserId: string,
) {
	const memories = await listEntityMemories(client, entityId);
	expect(memories.map((memory) => memory.id).sort()).toEqual(
		[survivorId, loserId].sort(),
	);
	expect(
		expectDefined(memories.find((memory) => memory.id === survivorId))
			.supersededBy,
	).toBe(null);
	expect(
		expectDefined(memories.find((memory) => memory.id === loserId))
			.supersededBy,
	).toBe(survivorId);
}

export async function exerciseConsolidationDeletePolicy(
	client: MemoryClient,
	entityPrefix: string,
): Promise<void> {
	{
		const entityId = `${entityPrefix}_forget`;
		const { survivor, loser } = await createConsolidatedPair(client, entityId);

		await expectMnemocyteError(
			client.delete({ scope: testScope(entityId), id: survivor.id }),
			"CONFLICT",
		);
		await expectPairUnchanged(client, entityId, survivor.id, loser.id);
	}

	{
		// Erasing the whole entity takes the survivor and its dependents in one
		// statement, so the consolidation link does not block it.
		const entityId = `${entityPrefix}_delete_scope`;
		await createConsolidatedPair(client, entityId);

		await expect(
			client.deleteScope({ scope: testScope(entityId) }),
		).resolves.toEqual({ deletedCount: 2 });
		await expect(
			client.stats({ scope: testScope(entityId) }),
		).resolves.toMatchObject({ memoryCount: 0 });
	}

	{
		// A narrowed scope that would leave a dependent behind is rejected.
		const entityId = `${entityPrefix}_delete_scope_narrow`;
		const agentScope = testScope(entityId, { agentId: "agent-a" });
		const survivor = await client.add({
			scope: agentScope,
			content: `${entityId} survivor`,
		});
		const loser = await client.add({
			scope: testScope(entityId),
			content: `${entityId} loser`,
		});
		await client.experimental.consolidate({
			scope: agentScope,
			survivorId: survivor.id,
			supersededIds: [loser.id],
		});

		await expectMnemocyteError(
			client.deleteScope({ scope: agentScope }),
			"CONFLICT",
		);
		await expect(
			client.stats({ scope: testScope(entityId) }),
		).resolves.toMatchObject({ memoryCount: 2 });
	}

	{
		const entityId = `${entityPrefix}_prune`;
		const { survivor, loser } = await createConsolidatedPair(client, entityId, {
			survivorExpired: true,
		});
		const unrelated = await client.add({
			scope: testScope(entityId),
			content: `${entityId} unrelated expired memory`,
			expiresAt: new Date(Date.now() - 60_000),
		});

		await expect(
			client.prune({ scope: testScope(entityId), expired: true, dryRun: true }),
		).resolves.toEqual({
			matchedCount: 2,
			deletedCount: 0,
			dryRun: true,
		});
		await expectMnemocyteError(
			client.prune({ scope: testScope(entityId), expired: true }),
			"CONFLICT",
		);

		const memories = await listEntityMemories(client, entityId);
		expect(memories.map((memory) => memory.id).sort()).toEqual(
			[survivor.id, loser.id, unrelated.id].sort(),
		);
		expect(
			expectDefined(memories.find((memory) => memory.id === loser.id))
				.supersededBy,
		).toBe(survivor.id);
	}

	{
		const entityId = `${entityPrefix}_permitted`;
		const ordinary = await client.add({
			scope: testScope(entityId),
			content: `${entityId} ordinary memory`,
		});
		await expect(
			client.delete({ scope: testScope(entityId), id: ordinary.id }),
		).resolves.toBeUndefined();

		const { survivor, loser } = await createConsolidatedPair(client, entityId);
		await expect(
			client.delete({ scope: testScope(entityId), id: loser.id }),
		).resolves.toBeUndefined();
		await expect(
			client.delete({ scope: testScope(entityId), id: survivor.id }),
		).resolves.toBeUndefined();
		await expect(
			client.stats({ scope: testScope(entityId) }),
		).resolves.toMatchObject({
			memoryCount: 0,
		});
	}
}
