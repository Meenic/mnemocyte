import type { MemoryWithScore, MnemocyteClient } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

async function listEntityMemories(
	client: MnemocyteClient,
	entityId: string,
): Promise<MemoryWithScore[]> {
	return client.recall({
		entityId,
		query: "consolidation deletion policy",
		limit: 20,
		minScore: 0,
		includeExpired: true,
		includeSuperseded: true,
	});
}

async function createConsolidatedPair(
	client: MnemocyteClient,
	entityId: string,
	options: { survivorExpired?: boolean } = {},
) {
	const [survivor, loser] = await client.rememberMany({
		inputs: [
			{
				entityId,
				content: `${entityId} survivor`,
				...(options.survivorExpired === true
					? { expiresAt: new Date(Date.now() - 60_000) }
					: {}),
			},
			{
				entityId,
				content: `${entityId} loser`,
			},
		],
	});
	const definedSurvivor = expectDefined(survivor);
	const definedLoser = expectDefined(loser);
	await client.experimental.consolidate({
		entityId,
		survivorId: definedSurvivor.id,
		supersededIds: [definedLoser.id],
	});
	return { survivor: definedSurvivor, loser: definedLoser };
}

async function expectPairUnchanged(
	client: MnemocyteClient,
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
	client: MnemocyteClient,
	entityPrefix: string,
): Promise<void> {
	{
		const entityId = `${entityPrefix}_forget`;
		const { survivor, loser } = await createConsolidatedPair(client, entityId);

		await expectMnemocyteError(
			client.forget({ entityId, memoryId: survivor.id }),
			"CONFLICT",
		);
		await expectPairUnchanged(client, entityId, survivor.id, loser.id);
	}

	{
		const entityId = `${entityPrefix}_forget_all`;
		const { survivor, loser } = await createConsolidatedPair(client, entityId);

		await expectMnemocyteError(client.forgetAll({ entityId }), "CONFLICT");
		await expectPairUnchanged(client, entityId, survivor.id, loser.id);
	}

	{
		const entityId = `${entityPrefix}_prune`;
		const { survivor, loser } = await createConsolidatedPair(client, entityId, {
			survivorExpired: true,
		});
		const unrelated = await client.remember({
			entityId,
			content: `${entityId} unrelated expired memory`,
			expiresAt: new Date(Date.now() - 60_000),
		});

		await expect(
			client.prune({ entityId, expired: true, dryRun: true }),
		).resolves.toEqual({
			matchedCount: 2,
			deletedCount: 0,
			dryRun: true,
		});
		await expectMnemocyteError(
			client.prune({ entityId, expired: true }),
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
		const ordinary = await client.remember({
			entityId,
			content: `${entityId} ordinary memory`,
		});
		await expect(
			client.forget({ entityId, memoryId: ordinary.id }),
		).resolves.toBeUndefined();

		const { survivor, loser } = await createConsolidatedPair(client, entityId);
		await expect(
			client.forget({ entityId, memoryId: loser.id }),
		).resolves.toBeUndefined();
		await expect(
			client.forget({ entityId, memoryId: survivor.id }),
		).resolves.toBeUndefined();
		await expect(client.stats({ entityId })).resolves.toMatchObject({
			memoryCount: 0,
		});
	}
}
