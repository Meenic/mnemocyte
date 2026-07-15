import { describe, expect, test } from "vitest";
import { createInMemoryStore } from "../../src/memory/in-memory.js";

describe("in-memory store lifecycle", () => {
	test("clears audit events on close", async () => {
		const store = createInMemoryStore();
		await store.addAuditEvents([
			{
				id: "evt_close",
				entityId: "alice",
				description: "memory.created",
				metadata: { memoryId: "mem_close" },
				timestamp: new Date("2026-01-01T00:00:00.000Z"),
			},
		]);
		expect(await store.listAuditLog({ entityId: "alice" })).toHaveLength(1);

		await store.close();

		expect(await store.listAuditLog({ entityId: "alice" })).toEqual([]);
	});

	test("deep-clones audit metadata at ingress and egress", async () => {
		const store = createInMemoryStore();
		const metadata = { detail: { reason: "initial" } };
		await store.addAuditEvents([
			{
				id: "evt_metadata",
				entityId: "alice",
				description: "memory.created",
				metadata,
				timestamp: new Date("2026-01-01T00:00:00.000Z"),
			},
		]);

		metadata.detail.reason = "changed after write";
		const first = (await store.listAuditLog({ entityId: "alice" }))[0];
		expect(first?.metadata).toEqual({ detail: { reason: "initial" } });
		const detail = first?.metadata.detail;
		if (
			detail !== null &&
			typeof detail === "object" &&
			!Array.isArray(detail)
		) {
			detail.reason = "changed after read";
		}
		const second = (await store.listAuditLog({ entityId: "alice" }))[0];
		expect(second?.metadata).toEqual({ detail: { reason: "initial" } });
	});
});
