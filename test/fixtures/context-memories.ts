import type {
	ContextWithMemoriesResult,
	MemoryClient,
	MemoryScope,
} from "mnemocyte";
import { expect } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

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
