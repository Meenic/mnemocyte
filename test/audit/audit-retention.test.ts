import { createMemory, type MnemocyteObservation } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { verifyAuditRetention } from "../fixtures/audit-retention.js";
import { testScope } from "../helpers.js";

const embedder = {
	model: "audit-retention-test",
	dimensions: 1,
	async embed(texts: readonly string[]) {
		return texts.map(() => [1]);
	},
};

describe("pruneAuditLog (in-memory)", () => {
	test("follows the shared fixture", async () => {
		const client = createMemory({ embedder, audit: { enabled: true } });
		await verifyAuditRetention({
			client,
			scopeFor: testScope,
			otherScopeFor: (entityId, extra = {}) => ({
				namespace: "other",
				entityId,
				...extra,
			}),
			allNamespaces: true,
		});
	});

	test("reports the deleted count to observability", async () => {
		const observed: MnemocyteObservation[] = [];
		const client = createMemory({
			embedder,
			audit: { enabled: true },
			observability: {
				onEvent: (event) => {
					observed.push(event);
				},
			},
		});
		await client.add({ scope: testScope("observed"), content: "Old." });
		await client.pruneAuditLog({
			scope: { namespace: "test" },
			before: new Date(Date.now() + 1000),
		});
		expect(
			observed
				.filter((event) => event.operation === "pruneAuditLog")
				.map(({ phase, namespace, count }) => ({ phase, namespace, count })),
		).toEqual([
			{ phase: "start", namespace: "test", count: undefined },
			{ phase: "success", namespace: "test", count: 1 },
		]);
	});
});
