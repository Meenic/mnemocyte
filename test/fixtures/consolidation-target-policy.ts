import type {
	ConsolidateResult,
	MemoryWithScore,
	MnemocyteClient,
} from "mnemocyte";
import { isMnemocyteError } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

async function listEntityMemories(
	client: MnemocyteClient,
	entityId: string,
): Promise<MemoryWithScore[]> {
	return client.recall({
		entityId,
		query: "consolidation target policy",
		limit: 20,
		minScore: 0,
		includeSuperseded: true,
	});
}

async function rememberPolicyMemories(
	client: MnemocyteClient,
	entityId: string,
	labels: readonly string[],
) {
	return client.rememberMany({
		inputs: labels.map((label) => ({
			entityId,
			content: `${entityId} ${label}`,
			tags: [label],
		})),
	});
}

export async function exerciseConsolidationTargetPolicy(
	client: MnemocyteClient,
	entityPrefix: string,
): Promise<void> {
	{
		const entityId = `${entityPrefix}_same_survivor`;
		const [survivor, loser] = await rememberPolicyMemories(client, entityId, [
			"survivor",
			"loser",
		]);
		const definedSurvivor = expectDefined(survivor);
		const definedLoser = expectDefined(loser);

		await expect(
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivor.id,
				supersededIds: [definedLoser.id],
			}),
		).resolves.toMatchObject({
			survivorId: definedSurvivor.id,
			supersededCount: 1,
			supersededIds: [definedLoser.id],
		});
		await expect(
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivor.id,
				supersededIds: [definedLoser.id],
			}),
		).resolves.toEqual({
			survivorId: definedSurvivor.id,
			supersededCount: 0,
			supersededIds: [],
		});
	}

	{
		const entityId = `${entityPrefix}_different_survivor`;
		const [survivorA, survivorB, loser] = await rememberPolicyMemories(
			client,
			entityId,
			["survivor-a", "survivor-b", "loser"],
		);
		const definedSurvivorA = expectDefined(survivorA);
		const definedSurvivorB = expectDefined(survivorB);
		const definedLoser = expectDefined(loser);

		await client.experimental.consolidate({
			entityId,
			survivorId: definedSurvivorA.id,
			supersededIds: [definedLoser.id],
		});
		await expectMnemocyteError(
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivorB.id,
				supersededIds: [definedLoser.id],
			}),
			"CONFLICT",
		);

		const memories = await listEntityMemories(client, entityId);
		expect(
			expectDefined(memories.find((memory) => memory.id === definedLoser.id))
				.supersededBy,
		).toBe(definedSurvivorA.id);
	}

	{
		const entityId = `${entityPrefix}_mixed`;
		const [survivorA, survivorB, sameLoser, conflictLoser, activeLoser] =
			await rememberPolicyMemories(client, entityId, [
				"survivor-a",
				"survivor-b",
				"same-loser",
				"conflict-loser",
				"active-loser",
			]);
		const definedSurvivorA = expectDefined(survivorA);
		const definedSurvivorB = expectDefined(survivorB);
		const definedSameLoser = expectDefined(sameLoser);
		const definedConflictLoser = expectDefined(conflictLoser);
		const definedActiveLoser = expectDefined(activeLoser);

		await client.experimental.consolidate({
			entityId,
			survivorId: definedSurvivorA.id,
			supersededIds: [definedSameLoser.id],
		});
		await client.experimental.consolidate({
			entityId,
			survivorId: definedSurvivorB.id,
			supersededIds: [definedConflictLoser.id],
		});
		const before = await listEntityMemories(client, entityId);
		const survivorTagsBefore = [
			...expectDefined(
				before.find((memory) => memory.id === definedSurvivorA.id),
			).tags,
		];
		const supersededAuditCountBefore = (
			await client.listAuditLog({ entityId, limit: 20 })
		).filter((event) => event.description === "memory.superseded").length;

		await expectMnemocyteError(
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivorA.id,
				supersededIds: [
					definedSameLoser.id,
					definedConflictLoser.id,
					definedActiveLoser.id,
				],
			}),
			"CONFLICT",
		);

		const after = await listEntityMemories(client, entityId);
		expect(
			expectDefined(after.find((memory) => memory.id === definedSameLoser.id))
				.supersededBy,
		).toBe(definedSurvivorA.id);
		expect(
			expectDefined(
				after.find((memory) => memory.id === definedConflictLoser.id),
			).supersededBy,
		).toBe(definedSurvivorB.id);
		expect(
			expectDefined(after.find((memory) => memory.id === definedActiveLoser.id))
				.supersededBy,
		).toBe(null);
		expect([
			...expectDefined(
				after.find((memory) => memory.id === definedSurvivorA.id),
			).tags,
		]).toEqual(survivorTagsBefore);
		expect(
			(await client.listAuditLog({ entityId, limit: 20 })).filter(
				(event) => event.description === "memory.superseded",
			),
		).toHaveLength(supersededAuditCountBefore);
	}

	{
		const entityId = `${entityPrefix}_concurrent_same`;
		const [survivor, loser] = await rememberPolicyMemories(client, entityId, [
			"survivor",
			"loser",
		]);
		const definedSurvivor = expectDefined(survivor);
		const definedLoser = expectDefined(loser);

		const results = await Promise.all([
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivor.id,
				supersededIds: [definedLoser.id],
			}),
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivor.id,
				supersededIds: [definedLoser.id],
			}),
		]);
		expect(results.map((result) => result.supersededCount).sort()).toEqual([
			0, 1,
		]);
		expect(results.flatMap((result) => result.supersededIds)).toEqual([
			definedLoser.id,
		]);
	}

	{
		const entityId = `${entityPrefix}_concurrent`;
		const [survivorA, survivorB, loser] = await rememberPolicyMemories(
			client,
			entityId,
			["survivor-a", "survivor-b", "loser"],
		);
		const definedSurvivorA = expectDefined(survivorA);
		const definedSurvivorB = expectDefined(survivorB);
		const definedLoser = expectDefined(loser);

		const results = await Promise.allSettled([
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivorA.id,
				supersededIds: [definedLoser.id],
			}),
			client.experimental.consolidate({
				entityId,
				survivorId: definedSurvivorB.id,
				supersededIds: [definedLoser.id],
			}),
		]);
		const successes = results.filter(
			(result): result is PromiseFulfilledResult<ConsolidateResult> =>
				result.status === "fulfilled",
		);
		const failures = results.filter(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		expect(successes).toHaveLength(1);
		expect(failures).toHaveLength(1);
		const success = expectDefined(successes[0]);
		const failure = expectDefined(failures[0]);
		expect(success.value.supersededCount).toBe(1);
		expect(success.value.supersededIds).toEqual([definedLoser.id]);
		expect(isMnemocyteError(failure.reason)).toBe(true);
		if (!isMnemocyteError(failure.reason)) {
			throw new Error(
				"Expected concurrent consolidation to reject with CONFLICT.",
			);
		}
		expect(failure.reason.code).toBe("CONFLICT");

		const after = await listEntityMemories(client, entityId);
		expect(
			expectDefined(after.find((memory) => memory.id === definedLoser.id))
				.supersededBy,
		).toBe(success.value.survivorId);
		await expect(
			client.experimental.consolidate({
				entityId,
				survivorId: success.value.survivorId,
				supersededIds: [definedLoser.id],
			}),
		).resolves.toMatchObject({
			supersededCount: 0,
			supersededIds: [],
		});
	}
}
