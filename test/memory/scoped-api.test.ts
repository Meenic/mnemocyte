import { createMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import {
	verifyGetAndScopeValidation,
	verifyKeyedAdd,
	verifyKeyedAddAudit,
	verifyListPaging,
	verifyScopeVisibility,
	verifyUpdate,
} from "../fixtures/scoped-api.js";

function createClient(options: { audit?: boolean } = {}) {
	let embedCalls = 0;
	const client = createMemory({
		embedder: {
			model: "scoped-api-test",
			dimensions: 3,
			async embed(texts) {
				embedCalls += 1;
				return texts.map((text) => [text.length, 1, text.charCodeAt(0)]);
			},
		},
		...(options.audit ? { audit: { enabled: true } } : {}),
	});
	return { client, embedCalls: () => embedCalls };
}

describe("scoped API (in-memory)", () => {
	test("reads see the scope plus shared memories; bulk operations select", async () => {
		await verifyScopeVisibility(createClient().client, "visibility");
	});

	test("add with a key updates the memory in place", async () => {
		await verifyKeyedAdd(createClient().client, "keys");
	});

	test("keyed adds are audited as created, then updated", async () => {
		await verifyKeyedAddAudit(createClient({ audit: true }).client, "audit");
	});

	test("list pages newest first with an opaque cursor", async () => {
		await verifyListPaging(createClient().client, "paging");
	});

	test("update changes fields and re-embeds only new content", async () => {
		const { client, embedCalls } = createClient();
		await verifyUpdate(client, "update", embedCalls);
	});

	test("get reads by id or key, and every method validates its scope", async () => {
		await verifyGetAndScopeValidation(createClient().client, "get");
	});

	test("context does not echo the query", async () => {
		const { client } = createClient();
		const scope = { namespace: "context", entityId: "alice" };
		await client.add({ scope, content: "Prefers short answers." });
		const query = "UNIQUE-QUERY-MARKER short answers";
		for (const format of ["markdown", "plain", "xml"] as const) {
			const context = await client.context({ scope, query, format });
			expect(context).toContain("Prefers short answers.");
			expect(context).not.toContain("UNIQUE-QUERY-MARKER");
		}
	});

	test("the client has no close method", () => {
		expect("close" in createClient().client).toBe(false);
	});
});
