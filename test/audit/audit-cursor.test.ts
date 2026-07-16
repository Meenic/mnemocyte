import { createMnemocyte, type ListAuditLogInput } from "mnemocyte";
import { describe, test } from "vitest";
import { verifyAuditCursorPagination } from "../fixtures/audit-cursor.js";
import { expectMnemocyteError } from "../helpers.js";

function createClient() {
	return createMnemocyte({
		embedder: {
			model: "audit-cursor-test",
			dimensions: 1,
			async embed(texts: readonly string[]) {
				return texts.map(() => [1]);
			},
		},
		audit: { enabled: true },
	});
}

describe("audit cursor pagination", () => {
	test("does not skip equal-timestamp in-memory events", async () => {
		const client = createClient();

		try {
			await verifyAuditCursorPagination(client, "audit_cursor_in_memory");
		} finally {
			await client.close();
		}
	});

	test("rejects malformed composite cursors", async () => {
		const client = createClient();
		const malformed: unknown[] = [
			{ entityId: "alice", beforeCursor: null },
			{
				entityId: "alice",
				beforeCursor: { timestamp: new Date("invalid"), id: "evt_x" },
			},
			{
				entityId: "alice",
				afterCursor: { timestamp: new Date(), id: " " },
			},
		];

		try {
			for (const input of malformed) {
				await expectMnemocyteError(
					client.listAuditLog(input as ListAuditLogInput),
					"VALIDATION",
				);
			}
		} finally {
			await client.close();
		}
	});
});
