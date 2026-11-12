import { describe, expect, test } from "vitest";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { testSelector, testStoreScope } from "../store-helpers.js";

function auditInput(entityId: string) {
	return { selector: testSelector(entityId), limit: 50 };
}

describe("in-memory store", () => {
	test("deleteScope removes the entity's audit events", async () => {
		const store = createInMemoryStore();
		await store.addAuditEvents([
			{
				id: "evt_alice",
				scope: testStoreScope("alice"),
				description: "memory.created",
				metadata: { memoryId: "mem_alice" },
				timestamp: new Date("2026-01-01T00:00:00.000Z"),
			},
			{
				id: "evt_bob",
				scope: testStoreScope("bob"),
				description: "memory.created",
				metadata: { memoryId: "mem_bob" },
				timestamp: new Date("2026-01-01T00:00:00.000Z"),
			},
		]);
		expect(await store.listAuditLog(auditInput("alice"))).toHaveLength(1);
		await store.deleteScope(testSelector("alice"));
		expect(await store.listAuditLog(auditInput("alice"))).toEqual([]);
		expect(await store.listAuditLog(auditInput("bob"))).toHaveLength(1);
	});

	test("deep-clones audit metadata at ingress and egress", async () => {
		const store = createInMemoryStore();
		const metadata = { detail: { reason: "initial" } };
		await store.addAuditEvents([
			{
				id: "evt_metadata",
				scope: testStoreScope("alice"),
				description: "memory.created",
				metadata,
				timestamp: new Date("2026-01-01T00:00:00.000Z"),
			},
		]);

		metadata.detail.reason = "changed after write";
		const first = (await store.listAuditLog(auditInput("alice")))[0];
		expect(first?.metadata).toEqual({ detail: { reason: "initial" } });
		const detail = first?.metadata.detail;
		if (
			detail !== null &&
			typeof detail === "object" &&
			!Array.isArray(detail)
		) {
			detail.reason = "changed after read";
		}
		const second = (await store.listAuditLog(auditInput("alice")))[0];
		expect(second?.metadata).toEqual({ detail: { reason: "initial" } });
	});
});
