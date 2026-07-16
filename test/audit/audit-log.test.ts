import { createMnemocyte, type MnemocyteObservation } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

describe("audit log", () => {
	test("records and filters audit events", async () => {
		function createClient(auditEnabled: boolean) {
			return createMnemocyte({
				embedder: {
					model: "audit-test",
					dimensions: 2,
					async embed(texts: readonly string[]) {
						return texts.map((text) => [text.length % 7, 1]);
					},
				},
				audit: { enabled: auditEnabled },
			});
		}

		// 1. Empty entityId rejected with VALIDATION.
		{
			const client = createClient(true);
			try {
				await expectMnemocyteError(
					client.listAuditLog({ entityId: "" }),
					"VALIDATION",
				);
			} finally {
				await client.close();
			}
		}

		// 2. With audit.enabled=false (default behaviour), no events are recorded.
		{
			const client = createClient(false);
			try {
				const mem = await client.remember({
					entityId: "alice",
					content: "hello",
				});
				await client.forget({ entityId: "alice", memoryId: mem.id });
				const log = await client.listAuditLog({ entityId: "alice" });
				expect(log.length).toBe(0);
			} finally {
				await client.close();
			}
		}

		// 3. With audit enabled, remember + forget produce two ordered events.
		{
			const client = createClient(true);
			try {
				const mem = await client.remember({
					entityId: "alice",
					content: "hello",
					type: "preference",
					importance: "high",
				});
				await new Promise((resolve) => setTimeout(resolve, 5));
				await client.forget({ entityId: "alice", memoryId: mem.id });
				const log = await client.listAuditLog({ entityId: "alice" });
				expect(log.length).toBe(2);
				// newest first
				const deleted = expectDefined(log[0]);
				const created = expectDefined(log[1]);
				expect(deleted.description).toBe("memory.deleted");
				expect(deleted.entityId).toBe("alice");
				expect(deleted.metadata.memoryId).toBe(mem.id);
				expect(created.description).toBe("memory.created");
				expect(created.metadata.memoryId).toBe(mem.id);
				expect(created.metadata.type).toBe("preference");
				expect(created.metadata.importance).toBe("high");
				for (const event of log) {
					expect(event.id).toMatch(/^evt_/);
					expect(event.timestamp).toBeInstanceOf(Date);
				}
			} finally {
				await client.close();
			}
		}

		// 4. forgetAll preserves prior audit events and adds an entity.cleared entry.
		{
			const client = createClient(true);
			try {
				await client.remember({ entityId: "alice", content: "one" });
				await client.remember({ entityId: "alice", content: "two" });
				const beforeClear = await client.listAuditLog({ entityId: "alice" });
				expect(beforeClear.length).toBe(2);
				await new Promise((resolve) => setTimeout(resolve, 5));
				await client.forgetAll({ entityId: "alice" });
				const afterClear = await client.listAuditLog({ entityId: "alice" });
				expect(afterClear.length).toBe(3);
				const cleared = expectDefined(afterClear[0]);
				expect(cleared.description).toBe("entity.cleared");
				expect(cleared.metadata.count).toBe(2);
				// Original memory.created events still readable.
				const created = afterClear.filter(
					(event) => event.description === "memory.created",
				);
				expect(created.length).toBe(2);
			} finally {
				await client.close();
			}
		}

		// 5. prune writes memory.pruned only for real (non-dry) runs.
		{
			const client = createClient(true);
			try {
				await client.remember({ entityId: "alice", content: "one" });
				await client.remember({ entityId: "alice", content: "two" });
				await client.prune({ entityId: "alice", dryRun: true });
				const afterDry = await client.listAuditLog({ entityId: "alice" });
				expect(
					afterDry.filter((event) => event.description === "memory.pruned")
						.length,
				).toBe(0);
				await client.prune({ entityId: "alice" });
				const afterReal = await client.listAuditLog({ entityId: "alice" });
				const pruned = afterReal.filter(
					(event) => event.description === "memory.pruned",
				);
				expect(pruned.length).toBe(1);
				expect(expectDefined(pruned[0]).metadata.count).toBe(2);
			} finally {
				await client.close();
			}
		}

		// 6. Audit log is entity-scoped.
		{
			const client = createClient(true);
			try {
				await client.remember({ entityId: "alice", content: "a" });
				await client.remember({ entityId: "bob", content: "b" });
				const alice = await client.listAuditLog({ entityId: "alice" });
				const bob = await client.listAuditLog({ entityId: "bob" });
				expect(alice.length).toBe(1);
				expect(bob.length).toBe(1);
				expect(expectDefined(alice[0]).entityId).toBe("alice");
				expect(expectDefined(bob[0]).entityId).toBe("bob");
			} finally {
				await client.close();
			}
		}

		// 7. before / after time filters work.
		{
			const client = createClient(true);
			try {
				await client.remember({ entityId: "alice", content: "first" });
				// Pad the cutoff so the first event is strictly before it and the
				// second event is strictly after it on any clock resolution.
				await new Promise((resolve) => setTimeout(resolve, 10));
				const cutoff = new Date();
				await new Promise((resolve) => setTimeout(resolve, 10));
				await client.remember({ entityId: "alice", content: "second" });
				const afterOnly = await client.listAuditLog({
					entityId: "alice",
					after: cutoff,
				});
				const beforeOnly = await client.listAuditLog({
					entityId: "alice",
					before: cutoff,
				});
				expect(afterOnly.length).toBe(1);
				expect(expectDefined(afterOnly[0]).metadata.memoryId).toBeDefined();
				expect(beforeOnly.length).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 8. limit caps the number of returned entries (newest first).
		{
			const client = createClient(true);
			try {
				for (let i = 0; i < 5; i += 1) {
					await client.remember({ entityId: "alice", content: `m${i}` });
				}
				const log = await client.listAuditLog({ entityId: "alice", limit: 2 });
				expect(log.length).toBe(2);
				const newest = expectDefined(log[0]);
				const previous = expectDefined(log[1]);
				expect(newest.metadata.memoryId).not.toBe(previous.metadata.memoryId);
			} finally {
				await client.close();
			}
		}

		// 9. Emits a listAuditLog observability event with the entry count.
		{
			const events: MnemocyteObservation[] = [];
			const client = createMnemocyte({
				embedder: {
					model: "audit-observability",
					dimensions: 2,
					async embed(texts: readonly string[]) {
						return texts.map((text) => [text.length, 1]);
					},
				},
				audit: { enabled: true },
				observability: {
					onEvent(event) {
						events.push(event);
					},
				},
			});
			try {
				await client.remember({ entityId: "alice", content: "x" });
				const log = await client.listAuditLog({ entityId: "alice" });
				expect(log.length).toBe(1);
				const success = events.find(
					(event) =>
						event.operation === "listAuditLog" && event.phase === "success",
				);
				expect(success?.entityId).toBe("alice");
				expect(success?.count).toBe(1);
			} finally {
				await client.close();
			}
		}
	});
});
