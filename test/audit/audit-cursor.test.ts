import { createMemory, type ListAuditLogInput } from "mnemocyte";
import { describe, test } from "vitest";
import { verifyAuditCursorPagination } from "../fixtures/audit-cursor.js";
import { expectMnemocyteError, testScope } from "../helpers.js";

function createClient() {
	return createMemory({
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

		await verifyAuditCursorPagination(client, "audit_cursor_in_memory");
	});

	test("rejects malformed composite cursors", async () => {
		const client = createClient();
		const malformed: unknown[] = [
			{ scope: testScope("alice"), beforeCursor: null },
			{
				scope: testScope("alice"),
				beforeCursor: { timestamp: new Date("invalid"), id: "evt_x" },
			},
			{
				scope: testScope("alice"),
				afterCursor: { timestamp: new Date(), id: " " },
			},
		];

		for (const input of malformed) {
			await expectMnemocyteError(
				client.listAuditLog(input as ListAuditLogInput),
				"VALIDATION",
			);
		}
	});
});
