import type {
	Embedder,
	Memory,
	MnemocyteClient,
	MnemocyteObservation,
} from "mnemocyte";
import { expect } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import type { MemoryStore } from "../../src/memory/store.js";
import { expectDefined } from "../helpers.js";

export interface StoredAccessState {
	id: string;
	accessCount: number;
	lastAccessedAt: Date | null;
	updatedAt: Date;
}

/**
 * One backend under test. Clients built from it share `store`, which the
 * caller closes; the fixture never closes a client, because closing the
 * in-memory store clears it.
 */
export interface AccessTrackingHarness {
	store: MemoryStore;
	embedder: Embedder;
	entityId: string;
	readStoredState(
		ids: readonly string[],
	): Promise<readonly StoredAccessState[]>;
}

/**
 * Collects `"trackAccess"` events and hands out each settled one
 * (`"success"` or `"error"`) once, whether it arrived before or after the
 * test asked for it.
 */
export function trackAccessEvents() {
	const all: MnemocyteObservation[] = [];
	const settled: MnemocyteObservation[] = [];
	const waiting: Array<(event: MnemocyteObservation) => void> = [];
	return {
		all,
		onEvent(event: MnemocyteObservation) {
			if (event.operation !== "trackAccess") {
				return;
			}
			all.push(event);
			if (event.phase === "start") {
				return;
			}
			const resolve = waiting.shift();
			if (resolve) {
				resolve(event);
			} else {
				settled.push(event);
			}
		},
		nextSettled(): Promise<MnemocyteObservation> {
			const event = settled.shift();
			return event
				? Promise.resolve(event)
				: new Promise((resolve) => waiting.push(resolve));
		},
	};
}

function createClient(
	harness: AccessTrackingHarness,
	options: {
		trackAccess?: boolean;
		onEvent: (event: MnemocyteObservation) => void;
		store?: MemoryStore;
	},
): MnemocyteClient {
	return createMemoryClient(
		{
			embedder: harness.embedder,
			observability: { onEvent: options.onEvent },
			...(options.trackAccess === undefined
				? {}
				: { retrieval: { trackAccess: options.trackAccess } }),
		},
		options.store ?? harness.store,
	);
}

async function readById(
	harness: AccessTrackingHarness,
	memories: readonly Memory[],
): Promise<Map<string, StoredAccessState>> {
	const rows = await harness.readStoredState(
		memories.map((memory) => memory.id),
	);
	return new Map(rows.map((row) => [row.id, row]));
}

export async function verifyAccessTracking(
	harness: AccessTrackingHarness,
): Promise<void> {
	const { entityId } = harness;
	const events = trackAccessEvents();
	const untracked = createClient(harness, { onEvent: events.onEvent });
	const tracked = createClient(harness, {
		trackAccess: true,
		onEvent: events.onEvent,
	});
	const created = await untracked.rememberMany({
		inputs: [
			{ entityId, content: "shared access first" },
			{ entityId, content: "shared access second" },
		],
	});
	const query = { entityId, query: "shared access", limit: 2 };

	// Off by default, and a per-call false overrides the config.
	expect(await untracked.recall(query)).toHaveLength(2);
	await untracked.buildContext(query);
	expect(await tracked.recall({ ...query, trackAccess: false })).toHaveLength(
		2,
	);

	// A tracked recall returns the values from before its own write.
	const beforeWrite = new Date();
	const first = await tracked.recall(query);
	expect(first).toHaveLength(2);
	for (const memory of first) {
		expect(memory.accessCount).toBe(0);
		expect(memory.lastAccessedAt).toBeNull();
	}
	const firstWrite = await events.nextSettled();
	expect(firstWrite).toMatchObject({
		operation: "trackAccess",
		phase: "success",
		entityId,
		count: 2,
	});

	const afterFirst = await readById(harness, created);
	for (const memory of created) {
		const stored = expectDefined(afterFirst.get(memory.id));
		expect(stored.accessCount).toBe(1);
		const lastAccessedAt = expectDefined(stored.lastAccessedAt);
		expect(lastAccessedAt.getTime()).toBeGreaterThanOrEqual(
			beforeWrite.getTime() - 1,
		);
		expect(stored.updatedAt).toEqual(memory.updatedAt);
	}

	// A per-call true overrides a client that does not track.
	await untracked.buildContext({ ...query, trackAccess: true });
	await events.nextSettled();

	const afterSecond = await readById(harness, created);
	const latest = await untracked.recall(query);
	for (const memory of latest) {
		const stored = expectDefined(afterSecond.get(memory.id));
		expect(stored.accessCount).toBe(2);
		expect(stored.updatedAt).toEqual(
			expectDefined(created.find((item) => item.id === memory.id)).updatedAt,
		);
		expect(memory.accessCount).toBe(2);
		expect(memory.lastAccessedAt).toEqual(stored.lastAccessedAt);
	}

	// Only the two tracked calls wrote: one start and one success each.
	expect(events.all.map((event) => event.phase)).toEqual([
		"start",
		"success",
		"start",
		"success",
	]);
}

/**
 * Deletes the first recalled memory just before the access write, as a
 * concurrent `forget` would. Recall still succeeds, and the write updates
 * the memory that is left.
 */
export async function verifyAccessTrackingSkipsDeletedRows(
	harness: AccessTrackingHarness,
): Promise<void> {
	const entityId = `${harness.entityId}_deleted`;
	const events = trackAccessEvents();
	const { store } = harness;
	const racingStore: MemoryStore = {
		...store,
		async markMemoriesAccessed(id, memoryIds) {
			const [gone] = memoryIds;
			if (gone !== undefined) {
				await store.deleteMemory(id, gone);
			}
			return store.markMemoriesAccessed(id, memoryIds);
		},
	};
	const client = createClient(harness, {
		trackAccess: true,
		onEvent: events.onEvent,
		store: racingStore,
	});
	await client.rememberMany({
		inputs: [
			{ entityId, content: "racing access first" },
			{ entityId, content: "racing access second" },
		],
	});

	const results = await client.recall({
		entityId,
		query: "racing access",
		limit: 2,
	});
	expect(results).toHaveLength(2);
	expect(await events.nextSettled()).toMatchObject({ phase: "success" });

	const [gone, kept] = results.map((memory) => memory.id);
	const stored = await harness.readStoredState([
		expectDefined(gone),
		expectDefined(kept),
	]);
	expect(stored).toHaveLength(1);
	expect(stored[0]).toMatchObject({ id: kept, accessCount: 1 });
}

/**
 * `notAccessedSince` counts a never-accessed memory from its `createdAt`,
 * so a fresh memory survives a prune for memories unused since yesterday.
 */
export async function verifyNotAccessedSinceUsesCreatedAt(
	harness: AccessTrackingHarness,
): Promise<void> {
	const entityId = `${harness.entityId}_prune`;
	const client = createClient(harness, { onEvent() {} });
	const memory = await client.remember({
		entityId,
		content: "never recalled",
	});

	const yesterday = new Date(memory.createdAt.getTime() - 86_400_000);
	const kept = await client.prune({ entityId, notAccessedSince: yesterday });
	expect(kept.deletedCount).toBe(0);

	const tomorrow = new Date(memory.createdAt.getTime() + 86_400_000);
	const pruned = await client.prune({ entityId, notAccessedSince: tomorrow });
	expect(pruned.deletedCount).toBe(1);
}
