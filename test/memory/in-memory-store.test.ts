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
});
