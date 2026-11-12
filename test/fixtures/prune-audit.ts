import type { MemoryClient } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, TEST_NAMESPACE, testScope } from "../helpers.js";

/** A namespace-wide prune writes one audit event per affected entity. */
export async function verifyNamespacePruneAudit(
	client: MemoryClient,
	entityPrefix: string,
): Promise<void> {
	const tag = `global-prune-${entityPrefix}`;
	const alice = `${entityPrefix}_alice`;
	const bob = `${entityPrefix}_bob`;
	const unaffected = `${entityPrefix}_unaffected`;
	const expiredAt = new Date(Date.now() - 60_000);

	for (const [entityId, contents] of [
		[alice, ["alice expired one", "alice expired two"]],
		[bob, ["bob expired"]],
	] as const) {
		await client.addMany({
			scope: testScope(entityId),
			memories: contents.map((content) => ({
				content,
				tags: [tag],
				expiresAt: expiredAt,
			})),
		});
	}
	await client.add({
		scope: testScope(unaffected),
		content: "unaffected fresh",
		tags: [tag],
	});
	const namespace = { scope: { namespace: TEST_NAMESPACE } };

	await expect(
		client.prune({ ...namespace, expired: true, tags: [tag], dryRun: true }),
	).resolves.toEqual({
		matchedCount: 3,
		deletedCount: 0,
		dryRun: true,
	});
	for (const entityId of [alice, bob, unaffected]) {
		const events = await client.listAuditLog({ scope: testScope(entityId) });
		expect(
			events.filter((event) => event.description === "memory.pruned"),
		).toEqual([]);
	}

	await expect(
		client.prune({ ...namespace, expired: true, tags: [tag] }),
	).resolves.toEqual({
		matchedCount: 3,
		deletedCount: 3,
		dryRun: false,
	});

	const aliceEvents = (
		await client.listAuditLog({ scope: testScope(alice) })
	).filter((event) => event.description === "memory.pruned");
	const bobEvents = (
		await client.listAuditLog({ scope: testScope(bob) })
	).filter((event) => event.description === "memory.pruned");
	const unaffectedEvents = (
		await client.listAuditLog({ scope: testScope(unaffected) })
	).filter((event) => event.description === "memory.pruned");

	expect(aliceEvents).toHaveLength(1);
	expect(expectDefined(aliceEvents[0]).metadata.count).toBe(2);
	expect(bobEvents).toHaveLength(1);
	expect(expectDefined(bobEvents[0]).metadata.count).toBe(1);
	expect(unaffectedEvents).toEqual([]);

	await expect(
		client.prune({ ...namespace, expired: true, tags: [tag] }),
	).resolves.toEqual({
		matchedCount: 0,
		deletedCount: 0,
		dryRun: false,
	});
	expect(
		(await client.listAuditLog({ scope: testScope(alice) })).filter(
			(event) => event.description === "memory.pruned",
		),
	).toHaveLength(1);
	expect(
		(await client.listAuditLog({ scope: testScope(bob) })).filter(
			(event) => event.description === "memory.pruned",
		),
	).toHaveLength(1);
}
