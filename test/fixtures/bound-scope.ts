import { type MemoryClient, type MemoryScope, migrate } from "mnemocyte";
import { expect } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

/**
 * Default namespaces and bound clients, shared by every backend. `memory`
 * has no default namespace; `defaulted` uses `namespace` as its default and
 * audits writes. Both use one store. Rows go to `namespace` and
 * `${namespace}_other`.
 */
export async function verifyBoundScope(input: {
	memory: MemoryClient;
	defaulted: MemoryClient<true>;
	namespace: string;
}): Promise<void> {
	const { memory, defaulted, namespace } = input;
	const other = `${namespace}_other`;

	// The default fills an omitted namespace; a scope's own namespace wins.
	const shared = await defaulted.add({
		scope: { entityId: "alice" },
		content: "bound probe about kites, shared",
	});
	expect(shared.scope).toEqual({
		namespace,
		entityId: "alice",
		agentId: null,
		sessionId: null,
	});
	const elsewhere = await defaulted.add({
		scope: { namespace: other, entityId: "alice" },
		content: "bound probe about kites, other namespace",
	});
	expect(elsewhere.scope.namespace).toBe(other);

	const alice = defaulted.for({ entityId: "alice" });
	const aliceAgent = defaulted.for({ entityId: "alice", agentId: "agent-a" });
	const bob = memory.for({ namespace, entityId: "bob" });
	expect(alice.scope).toEqual({ namespace, entityId: "alice" });
	expect(Object.isFrozen(alice.scope)).toBe(true);

	const held = await aliceAgent.add({
		content: "bound probe about kites, held by agent a",
	});
	expect(held.scope).toEqual({
		namespace,
		entityId: "alice",
		agentId: "agent-a",
		sessionId: null,
	});
	const [bobMemory] = await bob.addMany({
		memories: [{ content: "bound probe about kites, bob" }],
	});
	if (bobMemory === undefined) {
		throw new Error("addMany returned no memory.");
	}

	// Reads see the bound scope plus shared memories, as on the unbound client.
	async function ids(promise: Promise<{ memories: { id: string }[] }>) {
		return (await promise).memories.map((memory) => memory.id).sort();
	}
	expect(await ids(alice.list())).toEqual([shared.id]);
	expect(await ids(aliceAgent.list())).toEqual([shared.id, held.id].sort());
	expect(await ids(aliceAgent.list({ exactAgent: true }))).toEqual([held.id]);
	const found = await aliceAgent.search({ query: "kites", limit: 10 });
	expect(found.map((memory) => memory.id).sort()).toEqual(
		[shared.id, held.id].sort(),
	);
	await expect(alice.get({ id: shared.id })).resolves.toMatchObject({
		id: shared.id,
	});
	await expect(
		alice.context({ query: "kites", format: "plain" }),
	).resolves.toContain("bound probe about kites, shared");
	await expect(alice.findDuplicates()).resolves.toEqual([]);

	// Another bound scope cannot reach alice's memories.
	await expect(bob.get({ id: shared.id })).resolves.toBeNull();
	await expectMnemocyteError(
		bob.update({ id: shared.id, importance: "high" }),
		"NOT_FOUND",
	);
	await expectMnemocyteError(bob.delete({ id: shared.id }), "NOT_FOUND");
	const updated = await alice.update({ id: shared.id, importance: "high" });
	expect(updated.importance).toBe("high");

	// Bulk operations select within the bound scope: an omitted agent matches
	// any agent.
	await expect(alice.stats()).resolves.toMatchObject({ memoryCount: 2 });
	await expect(aliceAgent.stats()).resolves.toMatchObject({ memoryCount: 1 });
	await expect(
		alice.prune({ createdBefore: new Date(Date.now() + 60_000), dryRun: true }),
	).resolves.toEqual({ matchedCount: 2, deletedCount: 0, dryRun: true });
	const events = await alice.listAuditLog();
	expect(events.map((event) => event.scope.entityId)).toEqual([
		"alice",
		"alice",
		"alice",
	]);
	expect(events.every((event) => event.scope.namespace === namespace)).toBe(
		true,
	);
	await expect(defaulted.stats({ scope: {} })).resolves.toMatchObject({
		entityCount: 2,
		memoryCount: 3,
	});

	// A bound client takes no scope and no allNamespaces, even from untyped
	// code, and checks its input before anything runs.
	const reject = (call: () => Promise<unknown>) =>
		expectMnemocyteError(call(), "VALIDATION");
	await reject(() =>
		alice.add({
			content: "bound probe, escaped",
			scope: { namespace, entityId: "bob" },
		} as never),
	);
	await reject(() =>
		(alice.stats as (input: unknown) => Promise<unknown>)({
			allNamespaces: true,
		}),
	);
	await reject(() =>
		alice.prune({ allNamespaces: true, expired: true } as never),
	);
	await reject(() => alice.list(null as never));
	await reject(() => alice.deleteScope("all" as never));
	await expect(bob.stats()).resolves.toMatchObject({ memoryCount: 1 });

	// A malformed bound scope, or no namespace at all, fails at for().
	expect(() => defaulted.for({ entityId: "" })).toThrow(
		expect.objectContaining({ code: "VALIDATION" }),
	);
	expect(() => memory.for({ entityId: "alice" } as MemoryScope)).toThrow(
		expect.objectContaining({ code: "VALIDATION" }),
	);

	// migrate takes a bound client; the schema is current here.
	await expect(migrate({ memory: alice })).resolves.toEqual({
		applied: [],
		adopted: [],
		extensionCreated: false,
	});

	// deleteScope erases the bound scope only.
	await expect(aliceAgent.deleteScope()).resolves.toEqual({ deletedCount: 1 });
	await expect(alice.deleteScope()).resolves.toEqual({ deletedCount: 1 });
	await expect(bob.list()).resolves.toMatchObject({
		memories: [{ id: bobMemory.id }],
	});
	await expect(
		memory.stats({ scope: { namespace: other } }),
	).resolves.toMatchObject({ memoryCount: 1 });
}
