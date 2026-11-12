import { createMemory, type MnemocyteObservation } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectDefined, expectMnemocyteError, testScope } from "../helpers.js";

describe("audit log", () => {
	test("records and filters audit events", async () => {
		function createClient(auditEnabled: boolean) {
			return createMemory({
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
			await expectMnemocyteError(
				client.listAuditLog({ scope: testScope("") }),
				"VALIDATION",
			);
		}

		// 2. With audit.enabled=false (default behaviour), no events are recorded.
		{
			const client = createClient(false);
			const mem = await client.add({
				scope: testScope("alice"),
				content: "hello",
			});
			await client.delete({ scope: testScope("alice"), id: mem.id });
			const log = await client.listAuditLog({ scope: testScope("alice") });
			expect(log.length).toBe(0);
		}

		// 3. With audit enabled, remember + forget produce two ordered events.
		{
			const client = createClient(true);
			const mem = await client.add({
				scope: testScope("alice"),
				content: "hello",
				kind: "preference",
				importance: "high",
			});
			await new Promise((resolve) => setTimeout(resolve, 5));
			await client.delete({ scope: testScope("alice"), id: mem.id });
			const log = await client.listAuditLog({ scope: testScope("alice") });
			expect(log.length).toBe(2);
			// newest first
			const deleted = expectDefined(log[0]);
			const created = expectDefined(log[1]);
			expect(deleted.description).toBe("memory.deleted");
			expect(deleted.scope.entityId).toBe("alice");
			expect(deleted.metadata.memoryId).toBe(mem.id);
			expect(created.description).toBe("memory.created");
			expect(created.metadata.memoryId).toBe(mem.id);
			expect(created.metadata.kind).toBe("preference");
			expect(created.metadata.importance).toBe("high");
			for (const event of log) {
				expect(event.id).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				);
				expect(event.timestamp).toBeInstanceOf(Date);
			}
		}

		// 4. deleteScope erases the scope's audit events with its memories.
		{
			const client = createClient(true);
			await client.add({ scope: testScope("alice"), content: "one" });
			await client.add({ scope: testScope("bob"), content: "two" });
			expect(
				await client.listAuditLog({ scope: testScope("alice") }),
			).toHaveLength(1);
			await expect(
				client.deleteScope({ scope: testScope("alice") }),
			).resolves.toEqual({ deletedCount: 1 });
			expect(await client.listAuditLog({ scope: testScope("alice") })).toEqual(
				[],
			);
			expect(
				await client.listAuditLog({ scope: testScope("bob") }),
			).toHaveLength(1);
		}

		// 5. prune writes memory.pruned only for real (non-dry) runs.
		{
			const client = createClient(true);
			await client.add({ scope: testScope("alice"), content: "one" });
			await client.add({ scope: testScope("alice"), content: "two" });
			await client.prune({
				scope: testScope("alice"),
				createdBefore: new Date(Date.now() + 60_000),
				dryRun: true,
			});
			const afterDry = await client.listAuditLog({
				scope: testScope("alice"),
			});
			expect(
				afterDry.filter((event) => event.description === "memory.pruned")
					.length,
			).toBe(0);
			await client.prune({
				scope: testScope("alice"),
				createdBefore: new Date(Date.now() + 60_000),
			});
			const afterReal = await client.listAuditLog({
				scope: testScope("alice"),
			});
			const pruned = afterReal.filter(
				(event) => event.description === "memory.pruned",
			);
			expect(pruned.length).toBe(1);
			expect(expectDefined(pruned[0]).metadata.count).toBe(2);
		}

		// 6. Audit log is entity-scoped.
		{
			const client = createClient(true);
			await client.add({ scope: testScope("alice"), content: "a" });
			await client.add({ scope: testScope("bob"), content: "b" });
			const alice = await client.listAuditLog({ scope: testScope("alice") });
			const bob = await client.listAuditLog({ scope: testScope("bob") });
			expect(alice.length).toBe(1);
			expect(bob.length).toBe(1);
			expect(expectDefined(alice[0]).scope.entityId).toBe("alice");
			expect(expectDefined(bob[0]).scope.entityId).toBe("bob");
		}

		// 7. before / after time filters work.
		{
			const client = createClient(true);
			await client.add({ scope: testScope("alice"), content: "first" });
			// Pad the cutoff so the first event is strictly before it and the
			// second event is strictly after it on any clock resolution.
			await new Promise((resolve) => setTimeout(resolve, 10));
			const cutoff = new Date();
			await new Promise((resolve) => setTimeout(resolve, 10));
			await client.add({ scope: testScope("alice"), content: "second" });
			const afterOnly = await client.listAuditLog({
				scope: testScope("alice"),
				after: cutoff,
			});
			const beforeOnly = await client.listAuditLog({
				scope: testScope("alice"),
				before: cutoff,
			});
			expect(afterOnly.length).toBe(1);
			expect(expectDefined(afterOnly[0]).metadata.memoryId).toBeDefined();
			expect(beforeOnly.length).toBe(1);
		}

		// 8. limit caps the number of returned entries (newest first).
		{
			const client = createClient(true);
			for (let i = 0; i < 5; i += 1) {
				await client.add({ scope: testScope("alice"), content: `m${i}` });
			}
			const log = await client.listAuditLog({
				scope: testScope("alice"),
				limit: 2,
			});
			expect(log.length).toBe(2);
			const newest = expectDefined(log[0]);
			const previous = expectDefined(log[1]);
			expect(newest.metadata.memoryId).not.toBe(previous.metadata.memoryId);
		}

		// 9. Emits a listAuditLog observability event with the entry count.
		{
			const events: MnemocyteObservation[] = [];
			const client = createMemory({
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
			await client.add({ scope: testScope("alice"), content: "x" });
			const log = await client.listAuditLog({ scope: testScope("alice") });
			expect(log.length).toBe(1);
			const success = events.find(
				(event) =>
					event.operation === "listAuditLog" && event.phase === "success",
			);
			expect(success?.entityId).toBe("alice");
			expect(success?.count).toBe(1);
		}
	});
});
