import type { MnemocyteClient } from "mnemocyte";
import { expect } from "vitest";
import { expectDefined } from "../helpers.js";

export async function verifyGlobalPruneAudit(
	client: MnemocyteClient,
	entityPrefix: string,
): Promise<void> {
	const tag = `global-prune-${entityPrefix}`;
	const alice = `${entityPrefix}_alice`;
	const bob = `${entityPrefix}_bob`;
	const unaffected = `${entityPrefix}_unaffected`;
	const expiredAt = new Date(Date.now() - 60_000);

	await client.rememberMany({
		inputs: [
			{
				entityId: alice,
				content: "alice expired one",
				tags: [tag],
				expiresAt: expiredAt,
			},
			{
				entityId: alice,
				content: "alice expired two",
				tags: [tag],
				expiresAt: expiredAt,
			},
			{
				entityId: bob,
				content: "bob expired",
				tags: [tag],
				expiresAt: expiredAt,
			},
			{
				entityId: unaffected,
				content: "unaffected fresh",
				tags: [tag],
			},
		],
	});

	await expect(
		client.prune({ expired: true, tags: [tag], dryRun: true }),
	).resolves.toEqual({
		matchedCount: 3,
		deletedCount: 0,
		dryRun: true,
	});
	for (const entityId of [alice, bob, unaffected]) {
		const events = await client.listAuditLog({ entityId });
		expect(
			events.filter((event) => event.description === "memory.pruned"),
		).toEqual([]);
	}

	await expect(client.prune({ expired: true, tags: [tag] })).resolves.toEqual({
		matchedCount: 3,
		deletedCount: 3,
		dryRun: false,
	});

	const aliceEvents = (await client.listAuditLog({ entityId: alice })).filter(
		(event) => event.description === "memory.pruned",
	);
	const bobEvents = (await client.listAuditLog({ entityId: bob })).filter(
		(event) => event.description === "memory.pruned",
	);
	const unaffectedEvents = (
		await client.listAuditLog({ entityId: unaffected })
	).filter((event) => event.description === "memory.pruned");

	expect(aliceEvents).toHaveLength(1);
	expect(expectDefined(aliceEvents[0]).metadata.count).toBe(2);
	expect(bobEvents).toHaveLength(1);
	expect(expectDefined(bobEvents[0]).metadata.count).toBe(1);
	expect(unaffectedEvents).toEqual([]);

	await expect(client.prune({ expired: true, tags: [tag] })).resolves.toEqual({
		matchedCount: 0,
		deletedCount: 0,
		dryRun: false,
	});
	expect(
		(await client.listAuditLog({ entityId: alice })).filter(
			(event) => event.description === "memory.pruned",
		),
	).toHaveLength(1);
	expect(
		(await client.listAuditLog({ entityId: bob })).filter(
			(event) => event.description === "memory.pruned",
		),
	).toHaveLength(1);
}
