import type { AuditEvent } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { verifyGlobalPruneAudit } from "../fixtures/prune-audit.js";

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
	test("audits a global prune once per affected in-memory entity", async () => {
		const client = createMemoryClient(config, createInMemoryStore());
		try {
			await verifyGlobalPruneAudit(client, "prune_audit_in_memory");
		} finally {
			await client.close();
		}
	});

	test("keeps global prune deletion successful when audit insertion fails", async () => {
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

		try {
			const expiredAt = new Date(Date.now() - 60_000);
			await client.rememberMany({
				inputs: [
					{
						entityId: "audit_failure_alice",
						content: "alice expired",
						expiresAt: expiredAt,
					},
					{
						entityId: "audit_failure_bob",
						content: "bob expired",
						expiresAt: expiredAt,
					},
				],
			});
			auditAttempts = [];

			await expect(client.prune({ expired: true })).resolves.toEqual({
				matchedCount: 2,
				deletedCount: 2,
				dryRun: false,
			});
			expect(auditAttempts).toHaveLength(1);
			expect(
				auditAttempts[0]?.map((event) => ({
					entityId: event.entityId,
					description: event.description,
					count: event.metadata.count,
				})),
			).toEqual([
				{
					entityId: "audit_failure_alice",
					description: "memory.pruned",
					count: 1,
				},
				{
					entityId: "audit_failure_bob",
					description: "memory.pruned",
					count: 1,
				},
			]);
			await expect(client.stats()).resolves.toMatchObject({ memoryCount: 0 });
		} finally {
			await client.close();
		}
	});
});
