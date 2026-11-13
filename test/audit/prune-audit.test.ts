import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { verifyNamespacePruneAudit } from "../fixtures/prune-audit.js";
import { testScope } from "../helpers.js";

const config = {
	embedder: {
		model: "prune-audit-test",
		dimensions: 1,
		async embed(texts: readonly string[]) {
			return texts.map(() => [1]);
		},
	},
	audit: { enabled: true },
};

describe("prune audit coverage", () => {
	test("audits a namespace prune once per affected in-memory entity", async () => {
		const client = createMemoryClient(config, createInMemoryStore());
		await verifyNamespacePruneAudit(client, "prune_audit_in_memory");
	});

	test("audits an allNamespaces prune once per entity of each namespace", async () => {
		const client = createMemoryClient(config, createInMemoryStore());
		const expiredAt = new Date(Date.now() - 60_000);
		const alice = testScope("audit_all_alice");
		const bob = { namespace: "other", entityId: "audit_all_bob" };
		await client.add({
			scope: alice,
			content: "alice expired",
			expiresAt: expiredAt,
		});
		await client.add({
			scope: bob,
			content: "bob expired",
			expiresAt: expiredAt,
		});

		await expect(
			client.prune({ allNamespaces: true, expired: true }),
		).resolves.toEqual({ matchedCount: 2, deletedCount: 2, dryRun: false });

		for (const scope of [alice, bob]) {
			const pruned = (await client.listAuditLog({ scope })).filter(
				(event) => event.description === "memory.pruned",
			);
			expect(
				pruned.map((event) => ({
					scope: event.scope,
					count: event.metadata.count,
				})),
			).toEqual([
				{ scope: { ...scope, agentId: null, sessionId: null }, count: 1 },
			]);
		}
	});
});
