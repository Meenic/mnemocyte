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
import { expectDefined, expectMnemocyteError } from "../helpers.js";

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
				ids.map((id) => store.getMemory("access_in_memory", id)),
			);
			const deleted = await Promise.all(
				ids.map((id) => store.getMemory("access_in_memory_deleted", id)),
			);
			return [...rows, ...deleted].filter((row) => row !== null);
		},
	};
}

describe("recall access tracking (in-memory)", () => {
	test("is opt-in, deferred and leaves updatedAt alone", async () => {
		const harness = createHarness();
		try {
			await verifyAccessTracking(harness);
		} finally {
			await harness.store.close();
		}
	});

	test("skips memories deleted before the write", async () => {
		const harness = createHarness();
		try {
			await verifyAccessTrackingSkipsDeletedRows(harness);
		} finally {
			await harness.store.close();
		}
	});

	test("prunes never-accessed memories by createdAt", async () => {
		const harness = createHarness();
		try {
			await verifyNotAccessedSinceUsesCreatedAt(harness);
		} finally {
			await harness.store.close();
		}
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
				markMemoriesAccessed(entityId, memoryIds) {
					started = true;
					return new Promise<void>((resolve) => {
						release = resolve;
					}).then(() => store.markMemoriesAccessed(entityId, memoryIds));
				},
			},
		);
		try {
			const memory = await client.remember({
				entityId: "alice",
				content: "pending access",
			});
			const results = await client.recall({
				entityId: "alice",
				query: "pending access",
			});
			expect(results.map((result) => result.id)).toEqual([memory.id]);
			expect(started).toBe(true);
			expect((await store.getMemory("alice", memory.id))?.accessCount).toBe(0);

			expectDefined(release)();
			expect(await events.nextSettled()).toMatchObject({ phase: "success" });
			expect((await store.getMemory("alice", memory.id))?.accessCount).toBe(1);
		} finally {
			await client.close();
		}
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
		try {
			await client.remember({ entityId: "alice", content: "failing access" });
			const results = await client.recall({
				entityId: "alice",
				query: "failing access",
			});
			expect(results).toHaveLength(1);
			expect(await events.nextSettled()).toMatchObject({
				operation: "trackAccess",
				phase: "error",
				entityId: "alice",
				count: 1,
				error: failure,
			});
		} finally {
			await client.close();
		}
	});

	test("does not write when recall returns nothing", async () => {
		const store = createInMemoryStore();
		let calls = 0;
		const client = createMemoryClient(
			{ embedder, retrieval: { trackAccess: true } },
			{
				...store,
				async markMemoriesAccessed(entityId, memoryIds) {
					calls += 1;
					return store.markMemoriesAccessed(entityId, memoryIds);
				},
			},
		);
		try {
			expect(
				await client.recall({ entityId: "alice", query: "nothing" }),
			).toEqual([]);
			expect(calls).toBe(0);
		} finally {
			await client.close();
		}
	});

	test.each(["yes", 1, null])(
		"rejects trackAccess=%s on recall and buildContext",
		async (value) => {
			const client = createMemoryClient({ embedder }, createInMemoryStore());
			const input = {
				entityId: "alice",
				query: "anything",
				trackAccess: value as unknown as boolean,
			};
			try {
				await expectMnemocyteError(client.recall(input), "VALIDATION");
				await expectMnemocyteError(client.buildContext(input), "VALIDATION");
			} finally {
				await client.close();
			}
		},
	);
});
