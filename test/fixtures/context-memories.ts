import type {
	ContextWithMemoriesResult,
	MemoryClient,
	MemoryScope,
	MnemocyteObservation,
} from "mnemocyte";
import { expect } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";
import { trackAccessEvents } from "./access-tracking.js";

const WORDS = ["alpha", "bravo", "charlie", "delta", "echo"];

function ids(memories: readonly { id: string }[]): string[] {
	return memories.map((memory) => memory.id);
}

/** The memories split the search result at one point, in rank order. */
function expectSplit(
	result: ContextWithMemoriesResult,
	searchIds: readonly string[],
): void {
	expect([...ids(result.memories), ...ids(result.omitted)]).toEqual(searchIds);
	for (const memory of result.memories) {
		expect(result.context).toContain(memory.content);
	}
	for (const memory of result.omitted) {
		expect(result.context).not.toContain(memory.content);
	}
}

/**
 * `experimental.contextWithMemories`, the same on every backend: the text is
 * what `context()` returns for the same input, and `memories` followed by
 * `omitted` is the search result, split where the token budget ran out.
 * `memory` has no default namespace; `defaulted` uses `namespace` as its
 * default. Both use one store.
 */
export async function verifyContextMemories(input: {
	memory: MemoryClient;
	defaulted: MemoryClient<true>;
	namespace: string;
}): Promise<void> {
	const { memory, defaulted, namespace } = input;
	const scope: MemoryScope = { namespace, entityId: "alice" };
	await memory.addMany({
		scope,
		memories: WORDS.map((word) => ({
			content: `context probe about kites, ${word}`,
		})),
	});
	await memory.add({
		scope: { namespace, entityId: "bob" },
		content: "context probe about kites, bob",
	});
	const query = "kites";
	const searchIds = ids(await memory.search({ scope, query }));
	expect(searchIds).toHaveLength(WORDS.length);

	// Everything fits: nothing omitted, and the text is context()'s.
	const all = await memory.experimental.contextWithMemories({
		scope,
		query,
		maxTokens: 10_000,
	});
	expect(all.omitted).toEqual([]);
	expectSplit(all, searchIds);
	expect(all.context).toBe(
		await memory.context({ scope, query, maxTokens: 10_000 }),
	);
	for (const result of all.memories) {
		expect(result.scope).toMatchObject({ namespace, entityId: "alice" });
		expect(result.score).toBeGreaterThan(0);
		expect(result.explanation).toBeNull();
	}

	// A tighter budget drops the lowest-ranked memories, and says how many.
	for (const format of ["markdown", "plain", "xml"] as const) {
		const full = await memory.experimental.contextWithMemories({
			scope,
			query,
			format,
			maxTokens: 10_000,
		});
		const maxTokens = Math.ceil(full.context.length / 4) - 1;
		const tight = await memory.experimental.contextWithMemories({
			scope,
			query,
			format,
			maxTokens,
		});
		expect(tight.memories.length).toBeGreaterThan(0);
		expect(tight.omitted.length).toBeGreaterThan(0);
		expectSplit(tight, searchIds);
		expect(tight.context).toBe(
			await memory.context({ scope, query, format, maxTokens }),
		);
		expect(tight.context).toContain(
			format === "xml"
				? `<omitted count="${tight.omitted.length}"`
				: `[${tight.omitted.length} memories omitted`,
		);
	}

	// Nothing fits: every match is omitted.
	const none = await memory.experimental.contextWithMemories({
		scope,
		query,
		maxTokens: 1,
	});
	expect(none.memories).toEqual([]);
	expectSplit(none, searchIds);
	expect(none.context).toBe(
		await memory.context({ scope, query, maxTokens: 1 }),
	);

	// No match: an empty text and no memories.
	await expect(
		memory.experimental.contextWithMemories({
			scope: { namespace, entityId: "nobody" },
			query,
		}),
	).resolves.toEqual({ context: "", memories: [], omitted: [] });

	// explain adds the breakdown to both lists and leaves the text alone.
	const explained = await memory.experimental.contextWithMemories({
		scope,
		query,
		maxTokens: 120,
		explain: true,
	});
	for (const result of [...explained.memories, ...explained.omitted]) {
		expect(result.explanation?.finalScore).toBe(result.score);
	}
	expect(explained.context).toBe(
		await memory.context({ scope, query, maxTokens: 120 }),
	);

	// Filters reach the search, so omitted memories match them too.
	const filtered = await memory.experimental.contextWithMemories({
		scope,
		query,
		limit: 2,
	});
	expect(ids(filtered.memories)).toEqual(searchIds.slice(0, 2));
	expect(filtered.omitted).toEqual([]);

	// The default-namespace and bound clients give the same split.
	const defaultedResult = await defaulted.experimental.contextWithMemories({
		scope: { entityId: "alice" },
		query,
	});
	expect(ids(defaultedResult.memories)).toEqual(searchIds);
	const bound = defaulted.for({ entityId: "alice" });
	const boundResult = await bound.experimental.contextWithMemories({
		query,
		maxTokens: 120,
	});
	expect(ids(boundResult.memories)).toEqual(ids(explained.memories));
	expect(ids(boundResult.omitted)).toEqual(ids(explained.omitted));
	await expectMnemocyteError(
		bound.experimental.contextWithMemories({ query, scope } as never),
		"VALIDATION",
	);

	// Inputs are checked like context()'s; explain is the only extra key.
	await expectMnemocyteError(
		memory.experimental.contextWithMemories({
			scope,
			query,
			maxTokens: 0,
		}),
		"VALIDATION",
	);
	await expectMnemocyteError(
		memory.experimental.contextWithMemories({
			scope,
			query,
			explain: "yes",
		} as never),
		"VALIDATION",
	);
	await expect(
		memory.experimental.contextWithMemories({
			scope,
			query,
			memories: true,
		} as never),
	).rejects.toThrow('contextWithMemories does not accept "memories".');
	await expect(
		memory.context({ scope, query, explain: true } as never),
	).rejects.toThrow('context does not accept "explain".');
}

/**
 * With access tracking on, `context` and `contextWithMemories` mark only the
 * memories in the text; the ones the token budget left out keep their
 * counts. `search` still marks every result. `createTracked` returns a
 * client with `retrieval.trackAccess: true` that sends events to `onEvent`.
 */
export async function verifyContextTracksRenderedMemories(input: {
	createTracked(onEvent: (event: MnemocyteObservation) => void): MemoryClient;
	namespace: string;
}): Promise<void> {
	const events = trackAccessEvents();
	const memory = input.createTracked(events.onEvent);
	const scope: MemoryScope = {
		namespace: input.namespace,
		entityId: "tracked",
	};
	const created = await memory.addMany({
		scope,
		memories: WORDS.map((word) => ({
			content: `tracked probe about kites, ${word}`,
		})),
	});
	const query = "kites";
	const full = await memory.experimental.contextWithMemories({
		scope,
		query,
		maxTokens: 10_000,
		trackAccess: false,
	});
	expect(full.memories).toHaveLength(WORDS.length);
	const maxTokens = Math.ceil(full.context.length / 4) - 1;

	async function counts(): Promise<Map<string, number>> {
		const read = await Promise.all(
			created.map((item) => memory.get({ scope, id: item.id })),
		);
		return new Map(
			read.map((item) => {
				const found = expectDefined(item);
				return [found.id, found.accessCount];
			}),
		);
	}
	async function expectCounts(
		used: readonly string[],
		left: readonly string[],
		usedCount: number,
		leftCount: number,
	): Promise<void> {
		const stored = await counts();
		for (const id of used) {
			expect(stored.get(id)).toBe(usedCount);
		}
		for (const id of left) {
			expect(stored.get(id)).toBe(leftCount);
		}
	}

	// A tight budget: only the memories in the text are marked.
	const tight = await memory.experimental.contextWithMemories({
		scope,
		query,
		maxTokens,
	});
	expect(tight.memories.length).toBeGreaterThan(0);
	expect(tight.omitted.length).toBeGreaterThan(0);
	expect(await events.nextSettled()).toMatchObject({
		operation: "trackAccess",
		phase: "success",
		count: tight.memories.length,
	});
	const used = ids(tight.memories);
	const left = ids(tight.omitted);
	await expectCounts(used, left, 1, 0);

	// context() renders the same memories and marks the same ones.
	const text = await memory.context({ scope, query, maxTokens });
	expect(text).toBe(tight.context);
	expect(await events.nextSettled()).toMatchObject({
		phase: "success",
		count: used.length,
	});
	await expectCounts(used, left, 2, 0);

	// Nothing fits: no write starts, before or after the call resolves.
	const startsBefore = events.all.length;
	await memory.context({ scope, query, maxTokens: 1 });
	const none = await memory.experimental.contextWithMemories({
		scope,
		query,
		maxTokens: 1,
	});
	expect(none.memories).toEqual([]);
	expect(events.all).toHaveLength(startsBefore);
	await expectCounts(used, left, 2, 0);

	// search still marks every result it returns.
	const results = await memory.search({ scope, query });
	expect(results).toHaveLength(WORDS.length);
	expect(await events.nextSettled()).toMatchObject({
		phase: "success",
		count: WORDS.length,
	});
	await expectCounts(used, left, 3, 1);
	expect(events.all.map((event) => event.phase)).toEqual([
		"start",
		"success",
		"start",
		"success",
		"start",
		"success",
	]);
}
