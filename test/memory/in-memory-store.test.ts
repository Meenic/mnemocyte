import { createMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { testScope } from "../helpers.js";

function auditedMemory() {
	return createMemory({
		embedder: {
			model: "in-memory-store",
			dimensions: 2,
			async embed(texts: readonly string[]) {
				return texts.map(() => [1, 0]);
			},
		},
		audit: { enabled: true },
	});
}

describe("in-memory store", () => {
	test("deleteScope removes the entity's audit events", async () => {
		const memory = auditedMemory();
		await memory.add({ scope: testScope("alice"), content: "Alice." });
		await memory.add({ scope: testScope("bob"), content: "Bob." });
		expect(
			await memory.listAuditLog({ scope: testScope("alice") }),
		).toHaveLength(1);

		await memory.deleteScope({ scope: testScope("alice") });

		expect(await memory.listAuditLog({ scope: testScope("alice") })).toEqual(
			[],
		);
		expect(await memory.listAuditLog({ scope: testScope("bob") })).toHaveLength(
			1,
		);
	});

	test("returns detached copies of audit events", async () => {
		const memory = auditedMemory();
		const added = await memory.add({
			scope: testScope("alice"),
			content: "Alice.",
		});

		const [first] = await memory.listAuditLog({ scope: testScope("alice") });
		if (first) {
			first.metadata.memoryId = "changed after read";
			first.scope.entityId = "changed after read";
			first.timestamp.setTime(0);
		}

		const [second] = await memory.listAuditLog({ scope: testScope("alice") });
		expect(second?.metadata.memoryId).toBe(added.id);
		expect(second?.scope.entityId).toBe("alice");
		expect(second?.timestamp).toEqual(added.updatedAt);
	});
});
