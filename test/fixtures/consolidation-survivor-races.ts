import type { MemoryWithScore, MnemocyteClient } from "mnemocyte";
import { expect } from "vitest";
import type { MemoryStore } from "../../src/memory/store.js";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

interface Deferred {
	promise: Promise<void>;
	resolve(): void;
}

export interface ConsolidationPauseGate {
	entered: Promise<void>;
	release(): void;
}

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return {
		promise,
		resolve() {
			resolve?.();
		},
	};
}

export function createPausingConsolidationStore(baseStore: MemoryStore): {
	store: MemoryStore;
	pauseNext(): ConsolidationPauseGate;
} {
	const pendingGates: Array<{
		entered: Deferred;
		released: Deferred;
	}> = [];

	return {
		store: {
			...baseStore,
			async consolidate(input, options) {
				const gate = pendingGates.shift();
				if (gate) {
					gate.entered.resolve();
					await gate.released.promise;
				}
				return baseStore.consolidate(input, options);
			},
		},
		pauseNext() {
			const entered = createDeferred();
			const released = createDeferred();
			pendingGates.push({ entered, released });
			return {
				entered: entered.promise,
				release: released.resolve,
			};
		},
	};
}

async function listEntityMemories(
	client: MnemocyteClient,
	entityId: string,
): Promise<MemoryWithScore[]> {
	return client.recall({
		entityId,
		query: "consolidation survivor race",
		limit: 20,
		minScore: 0,
		includeSuperseded: true,
	});
}

async function countSupersededEvents(
	client: MnemocyteClient,
	entityId: string,
): Promise<number> {
	return (await client.listAuditLog({ entityId, limit: 20 })).filter(
		(event) => event.description === "memory.superseded",
	).length;
}

export async function exerciseConsolidationSurvivorRaces(params: {
	client: MnemocyteClient;
	mutator: MnemocyteClient;
	pauseNext(): ConsolidationPauseGate;
	entityPrefix: string;
}): Promise<void> {
	const { client, mutator, pauseNext, entityPrefix } = params;

	{
		const entityId = `${entityPrefix}_deleted`;
		const [survivor, loser] = await client.rememberMany({
			inputs: [
				{ entityId, content: "survivor", tags: ["survivor"] },
				{ entityId, content: "loser", tags: ["loser"] },
			],
		});
		const definedSurvivor = expectDefined(survivor);
		const definedLoser = expectDefined(loser);
		const gate = pauseNext();
		const pending = client.experimental.consolidate({
			entityId,
			survivorId: definedSurvivor.id,
			supersededIds: [definedLoser.id],
		});

		await gate.entered;
		try {
			await mutator.forget({ entityId, memoryId: definedSurvivor.id });
		} finally {
			gate.release();
		}
		await expectMnemocyteError(pending, "CONFLICT");

		const memories = await listEntityMemories(client, entityId);
		expect(memories.some((memory) => memory.id === definedSurvivor.id)).toBe(
			false,
		);
		expect(
			expectDefined(memories.find((memory) => memory.id === definedLoser.id))
				.supersededBy,
		).toBe(null);
		expect(await countSupersededEvents(client, entityId)).toBe(0);
	}

	{
		const entityId = `${entityPrefix}_superseded`;
		const [winner, survivor, loser] = await client.rememberMany({
			inputs: [
				{ entityId, content: "winner", tags: ["winner"] },
				{ entityId, content: "survivor", tags: ["survivor"] },
				{ entityId, content: "loser", tags: ["loser"] },
			],
		});
		const definedWinner = expectDefined(winner);
		const definedSurvivor = expectDefined(survivor);
		const definedLoser = expectDefined(loser);
		const gate = pauseNext();
		const pending = client.experimental.consolidate({
			entityId,
			survivorId: definedSurvivor.id,
			supersededIds: [definedLoser.id],
		});

		await gate.entered;
		try {
			await mutator.experimental.consolidate({
				entityId,
				survivorId: definedWinner.id,
				supersededIds: [definedSurvivor.id],
			});
		} finally {
			gate.release();
		}
		await expectMnemocyteError(pending, "CONFLICT");

		const memories = await listEntityMemories(client, entityId);
		const survivorAfter = expectDefined(
			memories.find((memory) => memory.id === definedSurvivor.id),
		);
		expect(survivorAfter.supersededBy).toBe(definedWinner.id);
		expect([...survivorAfter.tags]).toEqual(["survivor"]);
		expect(
			expectDefined(memories.find((memory) => memory.id === definedLoser.id))
				.supersededBy,
		).toBe(null);
		expect(await countSupersededEvents(client, entityId)).toBe(1);
	}

	{
		const entityId = `${entityPrefix}_tags`;
		const [survivor, firstLoser, secondLoser] = await client.rememberMany({
			inputs: [
				{ entityId, content: "survivor", tags: ["base"] },
				{ entityId, content: "first loser", tags: ["first"] },
				{ entityId, content: "second loser", tags: ["second"] },
			],
		});
		const definedSurvivor = expectDefined(survivor);
		const definedFirstLoser = expectDefined(firstLoser);
		const definedSecondLoser = expectDefined(secondLoser);
		const firstGate = pauseNext();
		const secondGate = pauseNext();
		const firstPending = client.experimental.consolidate({
			entityId,
			survivorId: definedSurvivor.id,
			supersededIds: [definedFirstLoser.id],
		});
		const secondPending = client.experimental.consolidate({
			entityId,
			survivorId: definedSurvivor.id,
			supersededIds: [definedSecondLoser.id],
		});

		await Promise.all([firstGate.entered, secondGate.entered]);
		firstGate.release();
		secondGate.release();
		const results = await Promise.all([firstPending, secondPending]);
		expect(results.map((result) => result.supersededCount)).toEqual([1, 1]);

		const memories = await listEntityMemories(client, entityId);
		const survivorAfter = expectDefined(
			memories.find((memory) => memory.id === definedSurvivor.id),
		);
		expect([...survivorAfter.tags].sort()).toEqual(["base", "first", "second"]);
		expect(
			expectDefined(
				memories.find((memory) => memory.id === definedFirstLoser.id),
			).supersededBy,
		).toBe(definedSurvivor.id);
		expect(
			expectDefined(
				memories.find((memory) => memory.id === definedSecondLoser.id),
			).supersededBy,
		).toBe(definedSurvivor.id);
		expect(await countSupersededEvents(client, entityId)).toBe(2);
	}
}
