import type { AuditEvent } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import type { MemoryStore } from "../../src/memory/store.js";
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

	test("keeps an allNamespaces prune successful when audit insertion fails", async () => {
		const baseStore = createInMemoryStore();
		let auditAttempts: AuditEvent[][] = [];
		const store: MemoryStore = {
			...baseStore,
			async addAuditEvents(events) {
				auditAttempts.push([...events]);
				throw new Error("simulated audit failure");
			},
		};
		const client = createMemoryClient(config, store);

		const expiredAt = new Date(Date.now() - 60_000);
		await client.add({
			scope: testScope("audit_failure_alice"),
			content: "alice expired",
			expiresAt: expiredAt,
		});
		await client.add({
			scope: { namespace: "other", entityId: "audit_failure_bob" },
			content: "bob expired",
			expiresAt: expiredAt,
		});
		auditAttempts = [];

		await expect(
			client.prune({ allNamespaces: true, expired: true }),
		).resolves.toEqual({
			matchedCount: 2,
			deletedCount: 2,
			dryRun: false,
		});
		expect(auditAttempts).toHaveLength(1);
		expect(
			auditAttempts[0]?.map((event) => ({
				scope: event.scope,
				description: event.description,
				count: event.metadata.count,
			})),
		).toEqual([
			{
				scope: {
					namespace: "other",
					entityId: "audit_failure_bob",
					agentId: null,
					sessionId: null,
				},
				description: "memory.pruned",
				count: 1,
			},
			{
				scope: {
					namespace: "test",
					entityId: "audit_failure_alice",
					agentId: null,
					sessionId: null,
				},
				description: "memory.pruned",
				count: 1,
			},
		]);
		await expect(client.stats({ allNamespaces: true })).resolves.toMatchObject({
			memoryCount: 0,
		});
	});
});
