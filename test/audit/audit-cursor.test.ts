import { createMemory, type ListAuditLogInput } from "mnemocyte";
import { describe, expect, test } from "vitest";
import {
	verifyAuditMemoryHistory,
	verifyAuditPages,
} from "../../src/store-test/fixtures/audit-cursor.js";
import { expectMnemocyteError, testScope } from "../helpers.js";

const embedder = {
	model: "audit-cursor-test",
	dimensions: 1,
	async embed(texts: readonly string[]) {
		return texts.map(() => [1]);
	},
};

function createClient() {
	return createMemory({ embedder, audit: { enabled: true } });
}

describe("listAuditLog pages (in-memory)", () => {
	test("follows the shared fixture", async () => {
		await verifyAuditPages({
			client: createClient(),
			scopeFor: testScope,
			otherScopeFor: (entityId, extra = {}) => ({
				namespace: "other",
				entityId,
				...extra,
			}),
		});
	});

	test("filters by memory id", async () => {
		await verifyAuditMemoryHistory({
			client: createClient(),
			scopeFor: testScope,
			otherScopeFor: (entityId, extra = {}) => ({
				namespace: "other",
				entityId,
				...extra,
			}),
		});
	});

	test("a default namespace fills an empty selector", async () => {
		const client = createMemory({
			embedder,
			audit: { enabled: true },
			namespace: "app",
		});
		await client.add({ scope: { entityId: "u1" }, content: "one" });
		await client.add({ scope: { entityId: "u2" }, content: "two" });
		await client.add({
			scope: { namespace: "elsewhere", entityId: "u1" },
			content: "three",
		});

		const page = await client.listAuditLog({ scope: {} });
		expect(page.events.map((event) => event.scope.entityId).sort()).toEqual([
			"u1",
			"u2",
		]);
		expect(page.events.every((event) => event.scope.namespace === "app")).toBe(
			true,
		);
	});

	test("rejects a missing or doubled selector", async () => {
		const client = createClient();
		const malformed: unknown[] = [
			{},
			{ scope: testScope("alice"), allNamespaces: true },
			{ allNamespaces: false },
			{ scope: { entityId: "alice" } },
			{ scope: testScope("alice"), limit: 0 },
			{ scope: testScope("alice"), before: new Date("invalid") },
		];

		for (const input of malformed) {
			await expectMnemocyteError(
				client.listAuditLog(input as ListAuditLogInput),
				"VALIDATION",
			);
		}
	});

	test("a bound client rejects allNamespaces and scope", async () => {
		const bound = createClient().for(testScope("alice"));
		for (const input of [
			{ allNamespaces: true },
			{ scope: testScope("bob") },
		]) {
			await expectMnemocyteError(
				bound.listAuditLog(input as never),
				"VALIDATION",
			);
		}
	});
});
