import type { AuditEvent, MemoryClient, MemoryScope } from "mnemocyte";
import { expect } from "vitest";
import { expectMnemocyteError } from "../helpers.js";
import type { ScopeFor } from "./survivor-deletes.js";

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventsOf(
	client: MemoryClient,
	scope: MemoryScope | Omit<MemoryScope, "agentId" | "sessionId">,
): Promise<AuditEvent[]> {
	return client.listAuditLog({ scope, limit: 100 });
}

/** Every event in the list is at or after the cutoff. */
function allAfter(events: readonly AuditEvent[], cutoff: Date): boolean {
	return events.every((event) => event.timestamp.getTime() >= cutoff.getTime());
}

/**
 * `pruneAuditLog` on every backend: validation, dry runs, the strict
 * `before` boundary, agent, entity and namespace selectors, batches of one,
 * bound clients and, when the store holds only this fixture's events,
 * `allNamespaces`. Memories are never touched, and the prune records no
 * event of its own.
 */
export async function verifyAuditRetention(input: {
	/** A client with `audit: { enabled: true }`. */
	client: MemoryClient;
	scopeFor: ScopeFor;
	/** Scopes in a second namespace, which namespace selectors must skip. */
	otherScopeFor: ScopeFor;
	/** Run `allNamespaces: true`; only safe on a store of its own. */
	allNamespaces: boolean;
}): Promise<void> {
	const { client, scopeFor, otherScopeFor } = input;
	const alice = scopeFor("retention_alice");
	const alicePlanner = scopeFor("retention_alice", { agentId: "planner" });
	const bob = scopeFor("retention_bob");
	const carol = otherScopeFor("retention_carol");
	const dave = otherScopeFor("retention_dave");

	// Old events: alice 3 shared + 1 planner, bob 1, carol 1, dave 1.
	const [first] = await client.addMany({
		scope: alice,
		memories: [{ content: "Alice old one." }, { content: "Alice old two." }],
	});
	await client.update({
		scope: alice,
		id: (first as { id: string }).id,
		importance: "high",
	});
	await client.add({ scope: alicePlanner, content: "Planner old." });
	for (const scope of [bob, carol, dave]) {
		await client.add({ scope, content: "Old." });
	}
	await pause(5);
	const before = new Date();
	await pause(5);
	// New events: one per scope, all after the cutoff.
	for (const scope of [alice, alicePlanner, bob, carol, dave]) {
		await client.add({ scope, content: "New." });
	}

	const namespace = { namespace: alice.namespace };
	for (const invalid of [
		{ scope: namespace },
		{ scope: namespace, before: new Date(Number.NaN) },
		{ scope: namespace, before: "2026-01-01" },
		{ scope: namespace, before, batchSize: 0 },
		{ scope: namespace, before, batchSize: 10_001 },
		{ scope: namespace, before, batchSize: 1.5 },
		{ scope: namespace, before, dryRun: "yes" },
		{ before },
		{ scope: namespace, allNamespaces: true, before },
		{ allNamespaces: false, before },
	]) {
		await expectMnemocyteError(
			client.pruneAuditLog(invalid as never),
			"VALIDATION",
		);
	}
	await expectMnemocyteError(
		client.for(alice).pruneAuditLog({ before, allNamespaces: true } as never),
		"VALIDATION",
	);
	await expectMnemocyteError(
		client.for(alice).pruneAuditLog({ before, scope: alice } as never),
		"VALIDATION",
	);
	const aborted = new AbortController();
	aborted.abort();
	await expectMnemocyteError(
		client.pruneAuditLog({ scope: alice, before, signal: aborted.signal }),
		"ABORTED",
	);
	expect(await eventsOf(client, alice)).toHaveLength(6);

	// A dry run counts the entity's old events across agents.
	await expect(
		client.pruneAuditLog({ scope: alice, before, dryRun: true }),
	).resolves.toEqual({ matchedCount: 4, deletedCount: 0, dryRun: true });
	expect(await eventsOf(client, alice)).toHaveLength(6);

	// `before` is strict: the oldest event itself stays.
	const oldest = (await eventsOf(client, alice)).at(-1) as AuditEvent;
	await expect(
		client.pruneAuditLog({ scope: alice, before: oldest.timestamp }),
	).resolves.toEqual({ matchedCount: 0, deletedCount: 0, dryRun: false });

	// An agent narrows the selection to that agent's events.
	await expect(
		client.pruneAuditLog({ scope: alicePlanner, before }),
	).resolves.toEqual({ matchedCount: 1, deletedCount: 1, dryRun: false });
	const planner = (await eventsOf(client, alice)).filter(
		(event) => event.scope.agentId === "planner",
	);
	expect(planner).toHaveLength(1);
	expect(allAfter(planner, before)).toBe(true);

	// A namespace selector covers every entity in it, one event per batch,
	// and skips the other namespace.
	await expect(
		client.pruneAuditLog({ scope: namespace, before, batchSize: 1 }),
	).resolves.toEqual({ matchedCount: 4, deletedCount: 4, dryRun: false });
	for (const [scope, count] of [
		[alice, 2],
		[bob, 1],
	] as const) {
		const events = await eventsOf(client, scope);
		expect(events).toHaveLength(count);
		expect(allAfter(events, before)).toBe(true);
	}
	expect(await eventsOf(client, carol)).toHaveLength(2);
	expect(await eventsOf(client, dave)).toHaveLength(2);
	await expect(
		client.pruneAuditLog({ scope: namespace, before }),
	).resolves.toEqual({ matchedCount: 0, deletedCount: 0, dryRun: false });

	// A bound client prunes within its scope.
	const boundCarol = client.for(carol);
	await expect(
		boundCarol.pruneAuditLog({ before, dryRun: true }),
	).resolves.toEqual({ matchedCount: 1, deletedCount: 0, dryRun: true });
	await expect(boundCarol.pruneAuditLog({ before })).resolves.toEqual({
		matchedCount: 1,
		deletedCount: 1,
		dryRun: false,
	});
	expect(await eventsOf(client, dave)).toHaveLength(2);

	// The rest of the other namespace: across the installation when this
	// store is ours alone, else through its namespace.
	const rest = input.allNamespaces
		? { allNamespaces: true as const, before, batchSize: 2 }
		: { scope: { namespace: dave.namespace }, before, batchSize: 2 };
	await expect(client.pruneAuditLog(rest)).resolves.toEqual({
		matchedCount: 1,
		deletedCount: 1,
		dryRun: false,
	});
	for (const scope of [carol, dave]) {
		const events = await eventsOf(client, scope);
		expect(events).toHaveLength(1);
		expect(allAfter(events, before)).toBe(true);
	}

	// Memories are untouched: alice still sees her three shared memories.
	const page = await client.list({ scope: alice, limit: 10 });
	expect(page.memories).toHaveLength(3);
}
