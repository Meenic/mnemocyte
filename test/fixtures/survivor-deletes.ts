import type { Memory, MemoryClient, MemoryScope } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

/** Builds the scope of one entity; each backend run passes its own namespace. */
export type ScopeFor = (
	entityId: string,
	extra?: Omit<Partial<MemoryScope>, "entityId" | "namespace">,
) => MemoryScope;

async function allMemories(
	client: MemoryClient,
	scope: MemoryScope,
): Promise<Memory[]> {
	const page = await client.list({
		scope,
		includeSuperseded: true,
		includeExpired: true,
		limit: 100,
	});
	return page.memories;
}

async function idsOf(client: MemoryClient, scope: MemoryScope) {
	return (await allMemories(client, scope)).map((memory) => memory.id).sort();
}

/** A survivor with one loser consolidated into it, through the stable method. */
async function consolidatedPair(
	client: MemoryClient,
	scope: MemoryScope,
	options: { expired?: boolean } = {},
): Promise<{ survivor: Memory; loser: Memory }> {
	const expiresAt =
		options.expired === true
			? { expiresAt: new Date(Date.now() - 60_000) }
			: {};
	const [survivor, loser] = await client.addMany({
		scope,
		memories: [
			{ content: "Survivor of a consolidated pair.", ...expiresAt },
			{ content: "Loser of a consolidated pair.", ...expiresAt },
		],
	});
	const result = await client.consolidate({
		scope,
		survivorId: expectDefined(survivor).id,
		supersededIds: [expectDefined(loser).id],
	});
	expect(result.supersededCount).toBe(1);
	return { survivor: expectDefined(survivor), loser: expectDefined(loser) };
}

/**
 * Survivor-aware deletes, the same on every backend: `delete` with each
 * `dependents` policy, dependents outside the visible scope, consolidation
 * chains, and a prune that selects a survivor together with its dependents.
 */
export async function verifySurvivorDeletes(
	client: MemoryClient,
	scopeFor: ScopeFor,
): Promise<void> {
	{
		// "reject", the default, keeps today's behavior.
		const scope = scopeFor("reject");
		const { survivor, loser } = await consolidatedPair(client, scope);
		await expectMnemocyteError(
			client.delete({ scope, id: survivor.id }),
			"CONFLICT",
		);
		await expectMnemocyteError(
			client.delete({ scope, id: survivor.id, dependents: "reject" }),
			"CONFLICT",
		);
		expect(await idsOf(client, scope)).toEqual([survivor.id, loser.id].sort());
		// Without dependents every policy deletes just the memory.
		for (const dependents of ["reject", "restore", "delete"] as const) {
			const lone = await client.add({ scope, content: `Lone ${dependents}.` });
			await expect(
				client.delete({ scope, id: lone.id, dependents }),
			).resolves.toBeUndefined();
			await expect(client.get({ scope, id: lone.id })).resolves.toBeNull();
		}
	}

	{
		// "restore" deletes the survivor and makes its dependents active again.
		const scope = scopeFor("restore");
		const { survivor, loser } = await consolidatedPair(client, scope);
		const other = await client.add({ scope, content: "Second loser." });
		await client.consolidate({
			scope,
			survivorId: survivor.id,
			supersededIds: [other.id],
		});
		await expect(
			client.delete({ scope, id: survivor.id, dependents: "restore" }),
		).resolves.toBeUndefined();
		const remaining = await allMemories(client, scope);
		expect(remaining.map((memory) => memory.id).sort()).toEqual(
			[loser.id, other.id].sort(),
		);
		for (const memory of remaining) {
			expect(memory.supersededBy).toBeNull();
			expect(memory.supersededAt).toBeNull();
		}
		// Restored memories are visible to reads that skip superseded ones.
		expect(
			(await client.list({ scope })).memories.map((memory) => memory.id).sort(),
		).toEqual([loser.id, other.id].sort());
	}

	{
		// "delete" takes the survivor and everything consolidated into it,
		// including memories consolidated into one of its dependents.
		const scope = scopeFor("cascade");
		const { survivor: inner, loser: innerLoser } = await consolidatedPair(
			client,
			scope,
		);
		const outer = await client.add({ scope, content: "Outer survivor." });
		await client.consolidate({
			scope,
			survivorId: outer.id,
			supersededIds: [inner.id],
		});
		const unrelated = await client.add({ scope, content: "Unrelated." });
		await expectMnemocyteError(
			client.delete({ scope, id: outer.id }),
			"CONFLICT",
		);
		await expect(
			client.delete({ scope, id: outer.id, dependents: "delete" }),
		).resolves.toBeUndefined();
		expect(await idsOf(client, scope)).toEqual([unrelated.id]);
		await expect(client.get({ scope, id: innerLoser.id })).resolves.toBeNull();
	}

	{
		// A dependent the call cannot see blocks "restore" and "delete": the
		// survivor is shared by every agent, the loser belongs to one agent.
		const shared = scopeFor("hidden");
		const agentScope = scopeFor("hidden", { agentId: "agent-a" });
		const survivor = await client.add({
			scope: shared,
			content: "Shared survivor.",
		});
		const loser = await client.add({
			scope: agentScope,
			content: "Agent loser.",
		});
		await client.consolidate({
			scope: agentScope,
			survivorId: survivor.id,
			supersededIds: [loser.id],
		});
		for (const dependents of ["reject", "restore", "delete"] as const) {
			await expectMnemocyteError(
				client.delete({ scope: shared, id: survivor.id, dependents }),
				"CONFLICT",
			);
		}
		await expect(
			client.get({ scope: agentScope, id: loser.id }),
		).resolves.toMatchObject({ supersededBy: survivor.id });
		// The agent's scope sees both, so the same call succeeds there.
		await expect(
			client.delete({
				scope: agentScope,
				id: survivor.id,
				dependents: "delete",
			}),
		).resolves.toBeUndefined();
		expect(await idsOf(client, agentScope)).toEqual([]);
	}

	{
		// A prune that selects a survivor and all its dependents deletes them;
		// one that leaves a dependent behind still rejects.
		const scope = scopeFor("prune");
		const { survivor, loser } = await consolidatedPair(client, scope, {
			expired: true,
		});
		await expect(client.prune({ scope, expired: true })).resolves.toEqual({
			matchedCount: 2,
			deletedCount: 2,
			dryRun: false,
		});
		expect(await idsOf(client, scope)).toEqual([]);
		await expect(client.get({ scope, id: survivor.id })).resolves.toBeNull();
		await expect(client.get({ scope, id: loser.id })).resolves.toBeNull();
	}

	{
		// Bound clients take `consolidate` and `dependents` too; the deprecated
		// `experimental.consolidate` still works.
		const bound = client.for(scopeFor("bound"));
		const [survivor, loser, late] = await bound.addMany({
			memories: [
				{ content: "Bound survivor." },
				{ content: "Bound loser." },
				{ content: "Bound late loser." },
			],
		});
		await expect(
			bound.consolidate({
				survivorId: expectDefined(survivor).id,
				supersededIds: [expectDefined(loser).id],
			}),
		).resolves.toMatchObject({ supersededCount: 1 });
		await expect(
			bound.experimental.consolidate({
				survivorId: expectDefined(survivor).id,
				supersededIds: [expectDefined(late).id],
			}),
		).resolves.toMatchObject({ supersededCount: 1 });
		await expect(
			bound.delete({ id: expectDefined(survivor).id, dependents: "delete" }),
		).resolves.toBeUndefined();
		await expect(bound.stats()).resolves.toMatchObject({ memoryCount: 0 });
	}

	await expectMnemocyteError(
		client.delete({
			scope: scopeFor("invalid"),
			id: "00000000-0000-7000-8000-000000000000",
			// @ts-expect-error untyped callers can pass any string
			dependents: "cascade",
		}),
		"VALIDATION",
	);
}
