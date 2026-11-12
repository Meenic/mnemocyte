import type { Embedder } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import {
	type AccessTrackingHarness,
	trackAccessEvents,
	verifyAccessTracking,
	verifyAccessTrackingSkipsDeletedRows,
	verifyNotAccessedSinceUsesCreatedAt,
} from "../fixtures/access-tracking.js";
import { expectDefined, expectMnemocyteError, testScope } from "../helpers.js";
import { testVisibility } from "../store-helpers.js";

const embedder: Embedder = {
	model: "access-tracking-test",
	dimensions: 1,
	async embed(texts) {
		return texts.map(() => [1]);
	},
};

function createHarness(): AccessTrackingHarness {
	const store = createInMemoryStore();
	return {
		store,
		embedder,
		entityId: "access_in_memory",
		async readStoredState(ids) {
			const rows = await Promise.all(
				ids.map((id) =>
					store.getMemory(testVisibility("access_in_memory"), id),
				),
			);
			const deleted = await Promise.all(
				ids.map((id) =>
					store.getMemory(testVisibility("access_in_memory_deleted"), id),
				),
			);
			return [...rows, ...deleted].filter((row) => row !== null);
		},
	};
}

describe("recall access tracking (in-memory)", () => {
	test("is opt-in, deferred and leaves updatedAt alone", async () => {
		await verifyAccessTracking(createHarness());
	});

	test("skips memories deleted before the write", async () => {
		await verifyAccessTrackingSkipsDeletedRows(createHarness());
	});

	test("prunes never-accessed memories by createdAt", async () => {
		await verifyNotAccessedSinceUsesCreatedAt(createHarness());
	});

	test("resolves before the write settles", async () => {
		const store = createInMemoryStore();
		const events = trackAccessEvents();
		let release: (() => void) | undefined;
		let started = false;
		const client = createMemoryClient(
			{
				embedder,
				retrieval: { trackAccess: true },
				observability: { onEvent: events.onEvent },
			},
			{
				...store,
				markMemoriesAccessed(visibility, memoryIds) {
					started = true;
					return new Promise<void>((resolve) => {
						release = resolve;
					}).then(() => store.markMemoriesAccessed(visibility, memoryIds));
				},
			},
		);
		const memory = await client.add({
			scope: testScope("alice"),
			content: "pending access",
		});
		const results = await client.search({
			scope: testScope("alice"),
			query: "pending access",
		});
		expect(results.map((result) => result.id)).toEqual([memory.id]);
		expect(started).toBe(true);
		expect(
			(await store.getMemory(testVisibility("alice"), memory.id))?.accessCount,
		).toBe(0);

		expectDefined(release)();
		expect(await events.nextSettled()).toMatchObject({ phase: "success" });
		expect(
			(await store.getMemory(testVisibility("alice"), memory.id))?.accessCount,
		).toBe(1);
	});

	test("reports a failed write to onEvent without failing recall", async () => {
		const store = createInMemoryStore();
		const events = trackAccessEvents();
		const failure = new Error("access write failed");
		const client = createMemoryClient(
			{
				embedder,
				retrieval: { trackAccess: true },
				observability: {
					// A slow hook: the write rejects while the start event is
					// still being delivered, which must not be an unhandled
					// rejection.
					async onEvent(event) {
						await new Promise((resolve) => setTimeout(resolve, 10));
						events.onEvent(event);
					},
				},
			},
			{
				...store,
				async markMemoriesAccessed() {
					throw failure;
				},
			},
		);
		await client.add({
			scope: testScope("alice"),
			content: "failing access",
		});
		const results = await client.search({
			scope: testScope("alice"),
			query: "failing access",
		});
		expect(results).toHaveLength(1);
		expect(await events.nextSettled()).toMatchObject({
			operation: "trackAccess",
			phase: "error",
			namespace: "test",
			entityId: "alice",
			count: 1,
			error: failure,
		});
	});

	test("does not write when recall returns nothing", async () => {
		const store = createInMemoryStore();
		let calls = 0;
		const client = createMemoryClient(
			{ embedder, retrieval: { trackAccess: true } },
			{
				...store,
				async markMemoriesAccessed(visibility, memoryIds) {
					calls += 1;
					return store.markMemoriesAccessed(visibility, memoryIds);
				},
			},
		);
		expect(
			await client.search({ scope: testScope("alice"), query: "nothing" }),
		).toEqual([]);
		expect(calls).toBe(0);
	});

	test.each(["yes", 1, null])(
		"rejects trackAccess=%s on search and context",
		async (value) => {
			const client = createMemoryClient({ embedder }, createInMemoryStore());
			const input = {
				scope: testScope("alice"),
				query: "anything",
				trackAccess: value as unknown as boolean,
			};
			await expectMnemocyteError(client.search(input), "VALIDATION");
			await expectMnemocyteError(client.context(input), "VALIDATION");
		},
	);
});
