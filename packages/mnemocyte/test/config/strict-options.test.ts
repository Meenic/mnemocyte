import { MockLanguageModelV4 } from "ai/test";
import { createMemory, type MemoryConfig } from "mnemocyte";
import {
	aiSdkEmbedder,
	extractMemories,
	memoryMiddleware,
	memoryTools,
	withMemory,
} from "mnemocyte/ai-sdk";
import { cohereEmbedder } from "mnemocyte/embedders/cohere";
import { googleEmbedder } from "mnemocyte/embedders/google";
import { openaiEmbedder } from "mnemocyte/embedders/openai";
import { openaiCompatibleEmbedder } from "mnemocyte/embedders/openai-compatible";
import { voyageEmbedder } from "mnemocyte/embedders/voyage";
import { postgresStore, type SqlExecutor } from "mnemocyte/postgres";
import { describe, expect, test } from "vitest";
import { isMnemocyteError } from "../../src/errors.js";

const embedder = {
	model: "strict-test",
	dimensions: 2,
	async embed(texts: readonly string[]) {
		return texts.map(() => [1, 0]);
	},
};

/** Options from outside the type system, as JavaScript callers build them. */
function untyped(value: Record<string, unknown>): never {
	return value as never;
}

function configMessage(action: () => unknown): string {
	try {
		action();
	} catch (error) {
		expect(isMnemocyteError(error)).toBe(true);
		if (isMnemocyteError(error)) {
			expect(error.code).toBe("CONFIG");
			return error.message;
		}
	}
	throw new Error("Expected a CONFIG error.");
}

describe("createMemory config", () => {
	test("rejects an unknown key at the top level", () => {
		const message = configMessage(() =>
			createMemory(untyped({ embedder, retreival: {} })),
		);
		expect(message).toContain('"retreival"');
		expect(message).toContain("retrieval");
	});

	test.each([
		["defaults", { lmit: 1 }],
		["retrieval", { fussion: {} }],
		["retrieval", { fusion: { kk: 1 } }],
		["retrieval", { boosts: { recent: 1 } }],
		["observability", { onEvents() {} }],
		["provider", { timeout: 5 }],
		["audit", { enable: true }],
	] as const)("rejects an unknown key in %s", (key, value) => {
		const config = untyped({ embedder, [key]: value }) as MemoryConfig;
		expect(configMessage(() => createMemory(config))).toContain(
			"does not accept",
		);
	});

	test("accepts every known key, and undefined values", () => {
		expect(() =>
			createMemory({
				namespace: "app",
				embedder,
				defaults: { limit: 5 },
				retrieval: {
					fusion: { k: 60, vector: 1, lexical: 1 },
					boosts: { recency: 0.1, importance: 0.1 },
					recencyHalfLifeDays: 30,
					candidateMultiplier: 3,
					trackAccess: false,
				},
				observability: { onEvent() {}, onError() {} },
				provider: { retries: 1 },
				audit: { enabled: false },
			}),
		).not.toThrow();
	});

	test("accepts a known key set to undefined", () => {
		expect(() =>
			createMemory(
				untyped({
					embedder,
					store: undefined,
					defaults: { minScore: undefined },
					provider: { timeoutMs: undefined },
				}),
			),
		).not.toThrow();
	});

	test("leaves a value that is not an object to its own check", () => {
		expect(
			configMessage(() => createMemory(untyped({ embedder, provider: 3 }))),
		).toContain("provider must be an object");
	});
});

describe("postgresStore options", () => {
	test("rejects an unknown key", () => {
		const executor: SqlExecutor = {
			query: async () => ({ rows: [] }),
		} as unknown as SqlExecutor;
		expect(
			configMessage(() =>
				postgresStore(untyped({ client: executor, pool: 1 })),
			),
		).toContain('"pool"');
	});
});

describe("embedder options", () => {
	const key = "test-key";
	const cases: Array<[string, (options: Record<string, unknown>) => unknown]> =
		[
			[
				"openaiEmbedder",
				(o) =>
					openaiEmbedder(
						untyped({ apiKey: key, model: "text-embedding-3-small", ...o }),
					),
			],
			[
				"openaiCompatibleEmbedder",
				(o) =>
					openaiCompatibleEmbedder(
						untyped({
							baseURL: "http://localhost:1/v1",
							model: "m",
							dimensions: 2,
							...o,
						}),
					),
			],
			[
				"voyageEmbedder",
				(o) =>
					voyageEmbedder(untyped({ apiKey: key, model: "voyage-4", ...o })),
			],
			[
				"googleEmbedder",
				(o) =>
					googleEmbedder(
						untyped({ apiKey: key, model: "gemini-embedding-001", ...o }),
					),
			],
			[
				"cohereEmbedder",
				(o) =>
					cohereEmbedder(untyped({ apiKey: key, model: "embed-v4.0", ...o })),
			],
		];

	test.each(cases)("%s rejects an unknown key", (name, build) => {
		const message = configMessage(() => build({ baseUrll: "http://x" }));
		expect(message).toContain(name);
		expect(message).toContain('"baseUrll"');
	});

	test.each(cases)("%s points from baseUrl to baseURL", (_name, build) => {
		const message = configMessage(() => build({ baseUrl: "http://x" }));
		expect(message).toContain('"baseUrl"');
		expect(message).toContain('renamed "baseURL"');
	});

	test.each(cases)(
		"%s accepts baseURL and an undefined option",
		(_name, build) => {
			expect(() =>
				build({ baseURL: "http://localhost:1/v1", maxBatch: undefined }),
			).not.toThrow();
		},
	);

	test("openaiCompatibleEmbedder checks the keys of purposes", () => {
		const base = {
			baseURL: "http://localhost:1/v1",
			model: "m",
			dimensions: 2,
		};
		expect(
			configMessage(() =>
				openaiCompatibleEmbedder(
					untyped({ ...base, purposes: { queries: {} } }),
				),
			),
		).toContain('"queries"');
		expect(
			configMessage(() =>
				openaiCompatibleEmbedder(
					untyped({ ...base, purposes: { query: { prefx: "q: " } } }),
				),
			),
		).toContain('"prefx"');
	});

	test("aiSdkEmbedder rejects an unknown key, also in purposes", () => {
		const model = "openai/text-embedding-3-small";
		expect(
			configMessage(() =>
				aiSdkEmbedder(untyped({ model, baseURL: "http://x" })),
			),
		).toContain('"baseURL"');
		expect(
			configMessage(() =>
				aiSdkEmbedder(untyped({ model, purposes: { document2: {} } })),
			),
		).toContain('"document2"');
		expect(() =>
			aiSdkEmbedder({ model, purposes: { query: {}, document: {} } }),
		).not.toThrow();
	});
});

describe("AI SDK options", () => {
	const memory = createMemory({ namespace: "app", embedder }).for({
		entityId: "alice",
	});
	const model = new MockLanguageModelV4({});

	test("memoryTools rejects an unknown key", () => {
		expect(
			configMessage(() => memoryTools(untyped({ memory, scope: {} }))),
		).toContain('"scope"');
	});

	test("memoryMiddleware and withMemory reject an unknown key", () => {
		expect(
			configMessage(() =>
				memoryMiddleware(untyped({ memory, placment: "user" })),
			),
		).toContain('"placment"');
		expect(
			configMessage(() => withMemory(untyped({ memory, model, plcement: 1 }))),
		).toContain('"plcement"');
	});

	test("memoryMiddleware rejects an unknown context key", () => {
		expect(
			configMessage(() =>
				memoryMiddleware(untyped({ memory, context: { maxToken: 10 } })),
			),
		).toContain('"maxToken"');
		expect(() =>
			memoryMiddleware({
				memory,
				context: { maxTokens: 10, kinds: ["fact"], tags: ["a"] },
			}),
		).not.toThrow();
	});

	test("save options reject an unknown key and the old timeout", () => {
		expect(
			configMessage(() =>
				memoryMiddleware(untyped({ memory, save: { model, maxMemory: 3 } })),
			),
		).toContain('"maxMemory"');
		const message = configMessage(() =>
			memoryMiddleware(untyped({ memory, save: { model, timeout: 5 } })),
		);
		expect(message).toContain('renamed "timeoutMs"');
		expect(() =>
			memoryMiddleware({
				memory,
				save: { model, timeoutMs: 5, waitUntil: () => {} },
			}),
		).not.toThrow();
	});

	test("extractMemories rejects an unknown key and the old timeout", async () => {
		const input = { model, memory, prompt: [], text: "Hi." };
		await expect(
			extractMemories(untyped({ ...input, timeout: 5 })),
		).rejects.toThrow('renamed "timeoutMs"');
		await expect(
			extractMemories(untyped({ ...input, instruction: "x" })),
		).rejects.toThrow('"instruction"');
	});

	test("extractMemories accepts a spread MemoryTurn", async () => {
		await expect(
			extractMemories({
				...{ finishReason: "stop" },
				model,
				memory,
				prompt: [],
				text: "Hi.",
			}),
		).resolves.toEqual([]);
	});
});
