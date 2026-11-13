import { createMemory, type MemoryClient } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { CONTRACT_DIMENSIONS, embedText } from "../contract/suite.js";
import { verifyKnnDuplicates } from "../fixtures/knn-duplicates.js";
import { verifySurvivorDeletes } from "../fixtures/survivor-deletes.js";
import { expectDefined, testScope } from "../helpers.js";

function inMemoryClient(audit = false): MemoryClient {
	return createMemory({
		embedder: {
			model: "survivor-deletes",
			dimensions: CONTRACT_DIMENSIONS,
			async embed(texts) {
				return texts.map(embedText);
			},
		},
		...(audit ? { audit: { enabled: true } } : {}),
	});
}

describe("survivor-aware deletes (in-memory)", () => {
	test("follow the shared fixture", async () => {
		await verifySurvivorDeletes(inMemoryClient(), testScope);
	});

	test("record one memory.deleted event per deleted memory", async () => {
		const memory = inMemoryClient(true);
		const scope = testScope("audit");
		const [survivor, loser, other] = await memory.addMany({
			scope,
			memories: [
				{ content: "Audited survivor." },
				{ content: "Audited loser." },
				{ content: "Audited restored loser." },
			],
		});
		const survivorId = expectDefined(survivor).id;
		const loserId = expectDefined(loser).id;
		const otherId = expectDefined(other).id;
		await memory.consolidate({
			scope,
			survivorId,
			supersededIds: [loserId],
		});
		await memory.delete({ scope, id: survivorId, dependents: "delete" });
		const cascade = await memory.listAuditLog({ scope, limit: 10 });
		expect(
			cascade
				.filter((event) => event.description === "memory.deleted")
				.map((event) => event.metadata),
		).toEqual(
			expect.arrayContaining([
				{ memoryId: survivorId },
				{ memoryId: loserId, deletedWith: survivorId },
			]),
		);

		const next = await memory.add({ scope, content: "Next survivor." });
		await memory.consolidate({
			scope,
			survivorId: next.id,
			supersededIds: [otherId],
		});
		await memory.delete({ scope, id: next.id, dependents: "restore" });
		// Events in the same millisecond have no fixed order, so find it by id.
		const restored = (await memory.listAuditLog({ scope, limit: 20 })).find(
			(event) =>
				event.description === "memory.deleted" &&
				event.metadata.memoryId === next.id,
		);
		expect(restored?.metadata).toEqual({
			memoryId: next.id,
			restoredIds: [otherId],
		});
	});
});

describe("deprecated experimental.consolidate", () => {
	test("is the same method as consolidate", async () => {
		const memory = inMemoryClient();
		const scope = testScope("alias");
		const [survivor, loser] = await memory.addMany({
			scope,
			memories: [{ content: "Alias survivor." }, { content: "Alias loser." }],
		});
		const input = {
			scope,
			survivorId: expectDefined(survivor).id,
			supersededIds: [expectDefined(loser).id],
		};
		await expect(memory.experimental.consolidate(input)).resolves.toEqual({
			survivorId: input.survivorId,
			supersededCount: 1,
			supersededIds: input.supersededIds,
		});
		// A retry through the stable method is the usual idempotent no-op.
		await expect(memory.consolidate(input)).resolves.toMatchObject({
			supersededCount: 0,
		});
	});
});

describe("nearest-neighbor duplicates (in-memory)", () => {
	test("follow the shared fixture", async () => {
		await verifyKnnDuplicates(inMemoryClient(), testScope);
	});
});
