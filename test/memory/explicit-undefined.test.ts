import { generateText } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import {
	createMemory,
	type Embedder,
	type MemoryClient,
	type MemoryConfig,
	migrate,
} from "mnemocyte";
import {
	aiSdkEmbedder,
	extractMemories,
	type MemoryPrompt,
	withMemory,
} from "mnemocyte/ai-sdk";
import { cohereEmbedder } from "mnemocyte/embedders/cohere";
import { googleEmbedder } from "mnemocyte/embedders/google";
import { openaiEmbedder } from "mnemocyte/embedders/openai";
import { openaiCompatibleEmbedder } from "mnemocyte/embedders/openai-compatible";
import { voyageEmbedder } from "mnemocyte/embedders/voyage";
import { describe, expect, test } from "vitest";
import { useFetchMock } from "../embedders/fetch-mock.js";
import { expectDefined } from "../helpers.js";

/**
 * Every optional input field accepts `undefined` and treats it as left out:
 * the types say `?: T | undefined`, so the runtime must agree.
 */

const VOCABULARY = ["tea", "coffee", "lisbon", "porto"];

function createEmbedder(): Embedder {
	return {
		model: "explicit-undefined",
		dimensions: VOCABULARY.length + 1,
		async embed(texts) {
			return texts.map((text) => {
				const lower = text.toLowerCase();
				return [
					...VOCABULARY.map((word) => (lower.includes(word) ? 1 : 0)),
					0.1,
				];
			});
		},
	};
}

const scope = { namespace: "app", entityId: "alice" };
const undefinedScope = {
	namespace: "app",
	entityId: "alice",
	agentId: undefined,
	sessionId: undefined,
};
const selector = {
	namespace: "app",
	entityId: undefined,
	agentId: undefined,
	sessionId: undefined,
};

const undefinedFilters = {
	kinds: undefined,
	tags: undefined,
	includeSuperseded: undefined,
	includeExpired: undefined,
	exactAgent: undefined,
	exactSession: undefined,
	signal: undefined,
};

async function seeded(): Promise<MemoryClient> {
	const memory = createMemory({
		embedder: createEmbedder(),
		audit: { enabled: true },
	});
	await memory.add({
		scope,
		key: "drink",
		content: "Likes tea.",
		tags: ["drinks"],
		source: "chat",
	});
	await memory.add({ scope, content: "Likes green tea." });
	await memory.add({ scope, content: "Lives in Lisbon." });
	return memory;
}

function ids(items: readonly { id: string }[]): string[] {
	return items.map((item) => item.id);
}

describe("method inputs", () => {
	test("add and addMany", async () => {
		const memory = await seeded();
		const added = await memory.add({
			scope: undefinedScope,
			content: "Drinks coffee.",
			key: undefined,
			kind: undefined,
			importance: undefined,
			tags: undefined,
			source: undefined,
			metadata: undefined,
			confidence: undefined,
			expiresAt: undefined,
			signal: undefined,
		});
		const plain = await memory.add({ scope, content: "Visits Porto." });
		expect(added.scope).toEqual(plain.scope);
		expect({
			...added,
			id: "",
			content: "",
			createdAt: 0,
			updatedAt: 0,
		}).toEqual({ ...plain, id: "", content: "", createdAt: 0, updatedAt: 0 });

		const many = await memory.addMany({
			scope: undefinedScope,
			memories: [
				{ content: "Drinks oat coffee.", key: undefined, tags: undefined },
			],
			signal: undefined,
		});
		expect(expectDefined(many[0]).key).toBeNull();
		expect(expectDefined(many[0]).tags).toEqual([]);
	});

	test("search, get and list", async () => {
		const memory = await seeded();
		const searched = await memory.search({
			scope: undefinedScope,
			query: "tea",
			limit: undefined,
			minScore: undefined,
			before: undefined,
			after: undefined,
			explain: undefined,
			trackAccess: undefined,
			...undefinedFilters,
		});
		expect(ids(searched)).toEqual(
			ids(await memory.search({ scope, query: "tea" })),
		);

		const got = await memory.get({
			scope: undefinedScope,
			key: "drink",
			exactAgent: undefined,
			exactSession: undefined,
			signal: undefined,
		});
		expect(got?.content).toBe("Likes tea.");

		const listed = await memory.list({
			scope: undefinedScope,
			limit: undefined,
			cursor: undefined,
			...undefinedFilters,
		});
		const plain = await memory.list({ scope });
		expect(ids(listed.memories)).toEqual(ids(plain.memories));
		expect(listed.nextCursor).toBe(plain.nextCursor);
	});

	test("a cursor loop with a `string | undefined` cursor", async () => {
		const memory = await seeded();
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await memory.list({ scope, limit: 2, cursor });
			seen.push(...ids(page.memories));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(seen).toEqual(ids((await memory.list({ scope })).memories));
	});

	test("update leaves undefined fields unchanged", async () => {
		const memory = await seeded();
		const original = expectDefined(await memory.get({ scope, key: "drink" }));
		const updated = await memory.update({
			scope: undefinedScope,
			id: original.id,
			content: "Likes black tea.",
			key: undefined,
			kind: undefined,
			importance: undefined,
			tags: undefined,
			source: undefined,
			metadata: undefined,
			confidence: undefined,
			expiresAt: undefined,
			signal: undefined,
		});
		expect(updated.content).toBe("Likes black tea.");
		expect(updated.key).toBe("drink");
		expect(updated.tags).toEqual(["drinks"]);
		expect(updated.source).toBe("chat");
		expect(updated.expiresAt).toBeNull();
	});

	test("context", async () => {
		const memory = await seeded();
		const explicit = await memory.context({
			scope: undefinedScope,
			query: "tea",
			format: undefined,
			maxTokens: undefined,
			limit: undefined,
			minScore: undefined,
			trackAccess: undefined,
			tokenCounter: undefined,
			...undefinedFilters,
		});
		expect(explicit).toBe(await memory.context({ scope, query: "tea" }));
	});

	test("findDuplicates and experimental.findDuplicatesPage", async () => {
		const memory = await seeded();
		const duplicateFields = {
			threshold: undefined,
			neighbors: undefined,
			kinds: undefined,
			tags: undefined,
			includeSuperseded: undefined,
			includeExpired: undefined,
			signal: undefined,
		};
		const pairIds = (
			pairs: readonly { a: { id: string }; b: { id: string } }[],
		) => pairs.map(({ a, b }) => [a.id, b.id]);

		const found = await memory.findDuplicates({
			scope: undefinedScope,
			limit: undefined,
			...duplicateFields,
		});
		expect(pairIds(found)).toEqual(
			pairIds(await memory.findDuplicates({ scope })),
		);

		const page = await memory.experimental.findDuplicatesPage({
			scope: undefinedScope,
			batchSize: undefined,
			cursor: undefined,
			...duplicateFields,
		});
		const plain = await memory.experimental.findDuplicatesPage({ scope });
		expect(pairIds(page.pairs)).toEqual(pairIds(plain.pairs));
		expect(page.nextCursor).toBe(plain.nextCursor);
	});

	test("listAuditLog, pruneAuditLog and stats", async () => {
		const memory = await seeded();
		const listed = await memory.listAuditLog({
			scope: selector,
			limit: undefined,
			cursor: undefined,
			before: undefined,
			after: undefined,
			signal: undefined,
		});
		const plain = await memory.listAuditLog({ scope: { namespace: "app" } });
		expect(ids(listed.events)).toEqual(ids(plain.events));
		expect(listed.events.length).toBeGreaterThan(0);

		const pruned = await memory.pruneAuditLog({
			scope: selector,
			before: new Date(Date.now() + 60_000),
			batchSize: undefined,
			dryRun: true,
			signal: undefined,
		});
		expect(pruned.matchedCount).toBe(listed.events.length);

		const stats = await memory.stats({ scope: selector });
		expect(stats.memoryCount).toBe(3);
	});

	test("prune with dryRun undefined runs for real", async () => {
		const memory = await seeded();
		const result = await memory.prune({
			scope: selector,
			expired: undefined,
			superseded: undefined,
			createdBefore: new Date(Date.now() + 60_000),
			notAccessedSince: undefined,
			kinds: ["episode"],
			tags: undefined,
			maxImportance: undefined,
			dryRun: undefined,
			signal: undefined,
		});
		expect(result.dryRun).toBe(false);
	});

	test("allNamespaces undefined next to a scope, from JavaScript", async () => {
		// The types keep `allNamespaces?: never` beside a scope; an untyped
		// caller that sets it to undefined still gets the scoped call.
		const memory = await seeded();
		const input = { scope, allNamespaces: undefined };
		expect((await memory.stats(input as never)).memoryCount).toBe(3);
		expect((await memory.listAuditLog(input as never)).events.length).toBe(3);
		const prune = { ...input, kinds: ["episode"] } as never;
		expect((await memory.prune(prune)).dryRun).toBe(false);
	});

	test("consolidate, delete and deleteScope", async () => {
		const memory = await seeded();
		const [survivor, duplicate] = (await memory.list({ scope })).memories;
		const consolidated = await memory.consolidate({
			scope: undefinedScope,
			survivorId: expectDefined(survivor).id,
			supersededIds: [expectDefined(duplicate).id],
			mergeTags: undefined,
			signal: undefined,
		});
		expect(consolidated.supersededCount).toBe(1);

		await memory.delete({
			scope: undefinedScope,
			id: expectDefined(duplicate).id,
			dependents: undefined,
			signal: undefined,
		});
		const erased = await memory.deleteScope({
			scope: undefinedScope,
			signal: undefined,
		});
		expect(erased.deletedCount).toBe(2);
	});

	test("bound and default-namespace clients", async () => {
		const memory = createMemory({
			namespace: "app",
			embedder: createEmbedder(),
		});
		const added = await memory.add({
			scope: { namespace: undefined, entityId: "alice" },
			content: "Likes tea.",
		});
		expect(added.scope.namespace).toBe("app");

		const bound = memory.for({ entityId: "alice", agentId: undefined });
		expect(bound.scope).toEqual({ namespace: "app", entityId: "alice" });
		const page = await bound.list({ limit: undefined, cursor: undefined });
		expect(ids(page.memories)).toEqual([added.id]);
		const searched = await bound.search({ query: "tea", limit: undefined });
		expect(ids(searched)).toEqual([added.id]);
	});
});

describe("config", () => {
	test("every optional config field may be undefined", async () => {
		const config: MemoryConfig = {
			embedder: createEmbedder(),
			namespace: undefined,
			store: undefined,
			defaults: { limit: undefined, minScore: undefined },
			retrieval: {
				fusion: { k: undefined, vector: undefined, lexical: undefined },
				boosts: { recency: undefined, importance: undefined },
				recencyHalfLifeDays: undefined,
				candidateMultiplier: undefined,
				trackAccess: undefined,
			},
			observability: { onEvent: undefined, onError: undefined },
			provider: {
				timeoutMs: undefined,
				retries: undefined,
				baseDelayMs: undefined,
				maxDelayMs: undefined,
				maxRetryAfterMs: undefined,
				shouldRetry: undefined,
			},
			audit: { enabled: undefined },
		};
		const memory = createMemory(config);
		await memory.add({ scope, content: "Likes tea." });

		// Undefined fusion and boost weights keep their defaults.
		const [hit] = await memory.search({ scope, query: "tea", explain: true });
		expect(expectDefined(hit).explanation).toMatchObject({
			fusion: { k: 60, vector: 1, lexical: 1 },
			boosts: { recency: 0.1, importance: 0.1 },
		});

		const migrated = await migrate({
			memory,
			dimensions: undefined,
			createExtension: undefined,
			dryRun: undefined,
			signal: undefined,
		});
		expect(migrated.applied).toEqual([]);
	});
});

describe("embedders", () => {
	const { respondJson, lastRequest, lastBody } = useFetchMock();

	test("openaiEmbedder", async () => {
		const embedder = openaiEmbedder({
			model: "text-embedding-3-small",
			apiKey: "key",
			dimensions: undefined,
			baseURL: undefined,
			maxBatch: undefined,
		});
		expect(embedder.dimensions).toBe(1536);
		respondJson({ data: [{ index: 0, embedding: new Array(1536).fill(0) }] });
		await embedder.embed(["x"], { purpose: "query" });
		expect(lastRequest().url).toBe("https://api.openai.com/v1/embeddings");
		expect(lastBody()).not.toHaveProperty("dimensions");
	});

	test("openaiCompatibleEmbedder", async () => {
		const embedder = openaiCompatibleEmbedder({
			model: "local",
			dimensions: 1,
			baseURL: "http://localhost:1234/v1",
			apiKey: undefined,
			headers: undefined,
			maxBatch: undefined,
			sendDimensions: undefined,
			purposes: {
				query: { prefix: undefined, body: undefined },
				document: undefined,
			},
		});
		respondJson({ data: [{ index: 0, embedding: [1] }] });
		await embedder.embed(["x"], { purpose: "query" });
		expect(lastBody()).toEqual({
			model: "local",
			input: ["x"],
			encoding_format: "float",
		});
		expect(new Headers(lastRequest().init.headers).has("authorization")).toBe(
			false,
		);
	});

	test.each([
		[
			"voyageEmbedder",
			() =>
				voyageEmbedder({
					model: "voyage-3.5",
					apiKey: "key",
					dimensions: undefined,
					truncate: undefined,
					baseURL: undefined,
					maxBatch: undefined,
				}),
			() => voyageEmbedder({ model: "voyage-3.5", apiKey: "key" }),
		],
		[
			"cohereEmbedder",
			() =>
				cohereEmbedder({
					model: "embed-v4.0",
					apiKey: "key",
					dimensions: undefined,
					truncate: undefined,
					baseURL: undefined,
					maxBatch: undefined,
				}),
			() => cohereEmbedder({ model: "embed-v4.0", apiKey: "key" }),
		],
		[
			"googleEmbedder",
			() =>
				googleEmbedder({
					model: "gemini-embedding-001",
					apiKey: "key",
					dimensions: undefined,
					truncate: undefined,
					baseURL: undefined,
					maxBatch: undefined,
				}),
			() => googleEmbedder({ model: "gemini-embedding-001", apiKey: "key" }),
		],
	])("%s", (_name, explicit, omitted) => {
		const a = explicit();
		const b = omitted();
		expect([a.model, a.dimensions, a.maxBatch]).toEqual([
			b.model,
			b.dimensions,
			b.maxBatch,
		]);
	});
});

describe("AI SDK options", () => {
	test("aiSdkEmbedder", async () => {
		const model = new MockEmbeddingModelV4({
			modelId: "text-embedding-3-small",
			doEmbed: async ({ values }) => ({
				embeddings: values.map(() => new Array(1536).fill(0)),
				warnings: [],
			}),
		});
		const embedder = aiSdkEmbedder({
			model,
			dimensions: undefined,
			maxBatch: undefined,
			providerOptions: undefined,
			purposes: { query: undefined, document: undefined },
		});
		expect(embedder.dimensions).toBe(1536);
		await embedder.embed(["x"], { purpose: "query" });
		expect(model.doEmbedCalls[0]?.providerOptions).toBeUndefined();
	});

	const user = (text: string): MemoryPrompt[number] => ({
		role: "user",
		content: [{ type: "text", text }],
	});
	const usage = {
		inputTokens: {
			total: 1,
			noCache: 1,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: 1, reasoning: undefined },
	};
	const textResult = (text: string) => ({
		content: [{ type: "text" as const, text }],
		finishReason: { unified: "stop" as const, raw: undefined },
		usage,
		warnings: [],
	});

	test("withMemory sends the same prompt as with the options left out", async () => {
		const memory = createMemory({
			namespace: "app",
			embedder: createEmbedder(),
		});
		const alice = memory.for({ entityId: "alice" });
		await alice.add({ content: "Likes tea." });
		const prompts: unknown[] = [];
		const model = new MockLanguageModelV4({
			doGenerate: async ({ prompt }) => {
				prompts.push(prompt);
				return textResult("ok");
			},
		});

		await generateText({
			model: withMemory({
				model,
				memory: alice,
				placement: undefined,
				context: undefined,
				query: undefined,
				save: undefined,
				onError: undefined,
			}),
			prompt: "What do I drink? tea",
		});
		await generateText({
			model: withMemory({ model, memory: alice }),
			prompt: "What do I drink? tea",
		});
		expect(prompts).toHaveLength(2);
		expect(prompts[0]).toEqual(prompts[1]);
		expect(JSON.stringify(prompts[0])).toContain("Likes tea.");
	});

	test("extractMemories", async () => {
		const memory = createMemory({
			namespace: "app",
			embedder: createEmbedder(),
		});
		const alice = memory.for({ entityId: "alice" });
		const model = new MockLanguageModelV4({
			doGenerate: async () =>
				textResult(
					JSON.stringify({
						memories: [
							{
								key: "home-city",
								content: "Lives in Lisbon.",
								kind: "fact",
								importance: "normal",
							},
						],
					}),
				),
		});
		const stored = await extractMemories({
			model,
			memory: alice,
			prompt: [user("I live in Lisbon.")],
			text: "Nice.",
			instructions: undefined,
			maxMemories: undefined,
			timeoutMs: undefined,
			signal: undefined,
		});
		expect(stored.map((item) => item.content)).toEqual(["Lives in Lisbon."]);
	});
});
