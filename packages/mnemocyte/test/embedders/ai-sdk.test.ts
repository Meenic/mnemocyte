import { APICallError, createGateway, customProvider } from "ai";
import { MockEmbeddingModelV4 } from "ai/test";
import { createMemory, ProviderError } from "mnemocyte";
import { aiSdkEmbedder } from "mnemocyte/ai-sdk";
import { afterEach, describe, expect, test, vi } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

type DoEmbed = MockEmbeddingModelV4["doEmbed"];

function vectorsFor(values: readonly string[]): number[][] {
	return values.map((_, index) => [1, index + 1]);
}

function mockModel(
	options: {
		provider?: string;
		modelId?: string;
		maxEmbeddingsPerCall?: number;
		supportsParallelCalls?: boolean;
		doEmbed?: DoEmbed;
	} = {},
): MockEmbeddingModelV4 {
	return new MockEmbeddingModelV4({
		provider: options.provider ?? "mock",
		modelId: options.modelId ?? "mock-embed",
		maxEmbeddingsPerCall: options.maxEmbeddingsPerCall ?? null,
		supportsParallelCalls: options.supportsParallelCalls ?? false,
		doEmbed:
			options.doEmbed ??
			(async ({ values }) => ({
				embeddings: vectorsFor(values),
				warnings: [],
			})),
	});
}

function apiCallError(
	input: {
		statusCode?: number;
		responseHeaders?: Record<string, string>;
		responseBody?: string;
		data?: unknown;
	} = {},
): APICallError {
	return new APICallError({
		message: "Incorrect API key provided: sk-secret",
		url: "https://provider.test/embeddings",
		requestBodyValues: {},
		...input,
	});
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => {
			throw new Error("Expected a rejection.");
		},
		(error: unknown) => error,
	);
}

afterEach(() => {
	globalThis.AI_SDK_DEFAULT_PROVIDER = undefined;
});

describe("aiSdkEmbedder models", () => {
	test("resolves a provider/model string through the global provider on each call", async () => {
		const model = mockModel();
		const embedder = aiSdkEmbedder({ model: "openai/text-embedding-3-small" });

		expect(embedder).toMatchObject({
			model: "text-embedding-3-small",
			dimensions: 1536,
		});
		expect(embedder.maxBatch).toBeUndefined();

		// Set after the embedder exists: the string is resolved per call.
		globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
			embeddingModels: { "openai/text-embedding-3-small": model },
		});
		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).resolves.toEqual([
			[1, 1],
			[1, 2],
		]);

		const call = model.doEmbedCalls[0];
		expect(call?.values).toEqual(["a", "b"]);
		expect(call?.dimensions).toBeUndefined();
		expect(call?.providerOptions).toBeUndefined();
	});

	test("takes a model object and reports its id", async () => {
		const model = mockModel({
			provider: "openai.embedding",
			modelId: "text-embedding-3-large",
		});
		const embedder = aiSdkEmbedder({ model, maxBatch: 10 });

		expect(embedder).toMatchObject({
			model: "text-embedding-3-large",
			dimensions: 3072,
			maxBatch: 10,
		});
		await embedder.embed(["a"], { purpose: "query" });
		expect(model.doEmbedCalls).toHaveLength(1);
	});

	test("strips the provider from a gateway model object's id", () => {
		const embedder = aiSdkEmbedder({
			model: mockModel({
				provider: "gateway",
				modelId: "amazon/titan-embed-text-v2",
			}),
		});
		expect(embedder).toMatchObject({
			model: "titan-embed-text-v2",
			dimensions: 1024,
		});
	});

	test.each([
		["an empty string", ""],
		["a provider without a model", "openai/"],
		["a plain object", {}],
		[
			"an unsupported specification",
			{ ...mockModel(), specificationVersion: "v1" },
		],
		["a model without doEmbed", { ...mockModel(), doEmbed: undefined }],
		["null", null],
	])("rejects %s as model with CONFIG", (_label, model) => {
		expect(() => aiSdkEmbedder({ model: model as never })).toThrow(
			expect.objectContaining({ code: "CONFIG" }),
		);
	});

	test("rejects options that are not an object with CONFIG", () => {
		expect(() => aiSdkEmbedder(undefined as never)).toThrow(
			expect.objectContaining({ code: "CONFIG" }),
		);
	});
});

describe("aiSdkEmbedder dimensions", () => {
	test("requires dimensions for an unknown model", () => {
		expect(() => aiSdkEmbedder({ model: "voyage/voyage-3.5" })).toThrow(
			expect.objectContaining({
				code: "CONFIG",
				message: expect.stringContaining('unknown model "voyage-3.5"'),
			}),
		);
		expect(
			aiSdkEmbedder({ model: "voyage/voyage-3.5", dimensions: 1024 }),
		).toMatchObject({ model: "voyage-3.5", dimensions: 1024 });
	});

	test("does not send dimensions for an unknown model or a known model's own size", async () => {
		for (const options of [
			{ modelId: "nomic-embed-text", dimensions: 2 },
			{ modelId: "text-embedding-3-small", dimensions: 1536 },
		]) {
			const model = mockModel({ modelId: options.modelId });
			await aiSdkEmbedder({ model, dimensions: options.dimensions }).embed(
				["a"],
				{ purpose: "document" },
			);
			expect(model.doEmbedCalls[0]?.dimensions).toBeUndefined();
		}
	});

	test("sends a smaller size for a known model", async () => {
		const model = mockModel({ modelId: "gemini-embedding-001" });
		const embedder = aiSdkEmbedder({ model, dimensions: 768 });

		expect(embedder.dimensions).toBe(768);
		await embedder.embed(["a"], { purpose: "document" });
		expect(model.doEmbedCalls[0]?.dimensions).toBe(768);
	});

	test.each([
		[
			"a fixed-size model",
			{ model: "openai/text-embedding-ada-002", dimensions: 512 },
		],
		[
			"zero dimensions",
			{ model: "openai/text-embedding-3-small", dimensions: 0 },
		],
		[
			"fractional dimensions",
			{ model: "mistral/mistral-embed", dimensions: 1.5 },
		],
		[
			"a zero maxBatch",
			{ model: "openai/text-embedding-3-small", maxBatch: 0 },
		],
	])("rejects %s with CONFIG", (_label, options) => {
		expect(() => aiSdkEmbedder(options)).toThrow(
			expect.objectContaining({ code: "CONFIG" }),
		);
	});
});

describe("aiSdkEmbedder purposes", () => {
	test.each([
		[
			"google.generative-ai",
			"gemini-embedding-001",
			{ google: { taskType: "RETRIEVAL_QUERY" } },
			{ google: { taskType: "RETRIEVAL_DOCUMENT" } },
		],
		[
			"google.vertex.embedding",
			"gemini-embedding-001",
			{ google: { taskType: "RETRIEVAL_QUERY" } },
			{ google: { taskType: "RETRIEVAL_DOCUMENT" } },
		],
		[
			"cohere.textEmbedding",
			"embed-v4.0",
			{ cohere: { inputType: "search_query" } },
			{ cohere: { inputType: "search_document" } },
		],
		[
			"voyage.embedding",
			"voyage-3.5",
			{ voyage: { inputType: "query" } },
			{ voyage: { inputType: "document" } },
		],
		["openai.embedding", "text-embedding-3-small", undefined, undefined],
		["mistral.embedding", "mistral-embed", undefined, undefined],
	])(
		"sends the built-in hints for %s",
		async (provider, modelId, query, document) => {
			const model = mockModel({ provider, modelId });
			const embedder = aiSdkEmbedder({ model, dimensions: 8 });

			await embedder.embed(["q"], { purpose: "query" });
			await embedder.embed(["d"], { purpose: "document" });
			expect(model.doEmbedCalls.map((call) => call.providerOptions)).toEqual([
				query,
				document,
			]);
		},
	);

	test("reads the provider from a gateway string or a gateway model", async () => {
		const model = mockModel();
		globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
			embeddingModels: { "cohere/embed-v4.0": model },
		});
		await aiSdkEmbedder({ model: "cohere/embed-v4.0" }).embed(["d"], {
			purpose: "document",
		});
		expect(model.doEmbedCalls[0]?.providerOptions).toEqual({
			cohere: { inputType: "search_document" },
		});

		const gatewayModel = mockModel({
			provider: "gateway",
			modelId: "google/gemini-embedding-001",
		});
		await aiSdkEmbedder({ model: gatewayModel }).embed(["q"], {
			purpose: "query",
		});
		expect(gatewayModel.doEmbedCalls[0]?.providerOptions).toEqual({
			google: { taskType: "RETRIEVAL_QUERY" },
		});
	});

	test("merges purposes over providerOptions and replaces the built-in hints", async () => {
		const providerOptions = { cohere: { truncate: "END" } };
		const purposes = {
			document: { cohere: { inputType: "classification" } },
		};
		const model = mockModel({
			provider: "cohere.textEmbedding",
			modelId: "embed-v4.0",
		});
		const embedder = aiSdkEmbedder({ model, providerOptions, purposes });
		// Options are snapshotted when the embedder is created.
		providerOptions.cohere.truncate = "NONE";
		purposes.document.cohere.inputType = "clustering";

		await embedder.embed(["d"], { purpose: "document" });
		await embedder.embed(["q"], { purpose: "query" });
		expect(model.doEmbedCalls.map((call) => call.providerOptions)).toEqual([
			{ cohere: { truncate: "END", inputType: "classification" } },
			{ cohere: { truncate: "END" } },
		]);
	});

	test("sends no hints with empty purposes", async () => {
		const model = mockModel({
			provider: "google.generative-ai",
			modelId: "gemini-embedding-001",
		});
		await aiSdkEmbedder({ model, purposes: {} }).embed(["q"], {
			purpose: "query",
		});
		expect(model.doEmbedCalls[0]?.providerOptions).toBeUndefined();
	});

	test.each([
		["the Gemini API", "google.generative-ai", "gemini-embedding-2"],
		["Vertex AI", "google.vertex.embedding", "gemini-embedding-2"],
		["a gateway model", "gateway", "google/gemini-embedding-2"],
	])(
		"marks gemini-embedding-2 purposes with text prefixes, not taskType, for %s",
		async (_label, provider, modelId) => {
			const model = mockModel({ provider, modelId });
			const embedder = aiSdkEmbedder({
				model,
				providerOptions: { google: { outputDimensionality: 3072 } },
			});
			expect(embedder).toMatchObject({
				model: "gemini-embedding-2",
				dimensions: 3072,
			});

			await embedder.embed(["Which tea?", "And coffee?"], { purpose: "query" });
			await embedder.embed(["Likes tea."], { purpose: "document" });
			expect(model.doEmbedCalls.map((call) => call.values)).toEqual([
				[
					"task: search result | query: Which tea?",
					"task: search result | query: And coffee?",
				],
				["title: none | text: Likes tea."],
			]);
			// providerOptions still go out, without a taskType.
			expect(model.doEmbedCalls.map((call) => call.providerOptions)).toEqual([
				{ google: { outputDimensionality: 3072 } },
				{ google: { outputDimensionality: 3072 } },
			]);
		},
	);

	test("sends gemini-embedding-2 through a gateway string with prefixes", async () => {
		const model = mockModel();
		globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
			embeddingModels: { "google/gemini-embedding-2": model },
		});
		await aiSdkEmbedder({
			model: "google/gemini-embedding-2",
			dimensions: 768,
		}).embed(["q"], { purpose: "query" });
		const call = model.doEmbedCalls[0];
		expect(call?.values).toEqual(["task: search result | query: q"]);
		expect(call?.dimensions).toBe(768);
		expect(call?.providerOptions).toBeUndefined();
	});

	test("purposes replace the gemini-embedding-2 prefixes", async () => {
		for (const purposes of [
			{},
			{ query: { google: { taskType: "QUESTION_ANSWERING" } } },
		]) {
			const model = mockModel({
				provider: "google.generative-ai",
				modelId: "gemini-embedding-2",
			});
			await aiSdkEmbedder({ model, purposes }).embed(["q"], {
				purpose: "query",
			});
			expect(model.doEmbedCalls[0]?.values).toEqual(["q"]);
			expect(model.doEmbedCalls[0]?.providerOptions).toEqual(purposes.query);
		}
	});

	test("prefixes only gemini-embedding-2 from a google provider", async () => {
		for (const [provider, modelId] of [
			["google.generative-ai", "gemini-embedding-001"],
			["google.generative-ai", "gemini-embedding-2-preview"],
			["mock", "gemini-embedding-2"],
		] as const) {
			const model = mockModel({ provider, modelId });
			await aiSdkEmbedder({ model, dimensions: 3072 }).embed(["d"], {
				purpose: "document",
			});
			expect(model.doEmbedCalls[0]?.values).toEqual(["d"]);
		}
	});

	test.each([
		["providerOptions that are not an object", { providerOptions: "x" }],
		[
			"a provider entry that is not an object",
			{ providerOptions: { google: 1 } },
		],
		["purposes that are not an object", { purposes: [] }],
		[
			"a purpose entry that is not an object",
			{ purposes: { query: { google: null } } },
		],
		[
			"providerOptions that are not JSON",
			{ providerOptions: { google: { n: 1n } } },
		],
	])("rejects %s with CONFIG", (_label, options) => {
		expect(() =>
			aiSdkEmbedder({
				model: "openai/text-embedding-3-small",
				...(options as object),
			}),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});

	test("rejects a call without a purpose with VALIDATION", async () => {
		const embedder = aiSdkEmbedder({ model: mockModel(), dimensions: 2 });
		await expectMnemocyteError(
			embedder.embed(["a"], undefined as never),
			"VALIDATION",
		);
		await expectMnemocyteError(
			embedder.embed(["a"], { purpose: "passage" as never }),
			"VALIDATION",
		);
	});
});

describe("aiSdkEmbedder calls", () => {
	test("forwards the signal", async () => {
		const model = mockModel();
		const controller = new AbortController();
		await aiSdkEmbedder({ model, dimensions: 2 }).embed(["a"], {
			purpose: "query",
			signal: controller.signal,
		});
		expect(model.doEmbedCalls[0]?.abortSignal).toBe(controller.signal);
	});

	test("an abort from the caller stops the call with ABORTED", async () => {
		const model = mockModel({
			doEmbed: ({ abortSignal }) =>
				new Promise((_resolve, reject) => {
					abortSignal?.addEventListener("abort", () =>
						reject(abortSignal.reason),
					);
				}),
		});
		const memory = createMemory({
			embedder: aiSdkEmbedder({ model, dimensions: 2 }),
		});
		const controller = new AbortController();
		const pending = memory.add({
			scope: testScope("alice"),
			content: "x",
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(model.doEmbedCalls).toHaveLength(1));
		controller.abort();

		await expectMnemocyteError(pending, "ABORTED");
		expect(model.doEmbedCalls[0]?.abortSignal?.aborted).toBe(true);
	});

	test("sends a provider's sub-batches one at a time", async () => {
		let running = 0;
		let peak = 0;
		const model = mockModel({
			maxEmbeddingsPerCall: 2,
			supportsParallelCalls: true,
			doEmbed: async ({ values }) => {
				running += 1;
				peak = Math.max(peak, running);
				await new Promise((resolve) => setTimeout(resolve, 5));
				running -= 1;
				return { embeddings: vectorsFor(values), warnings: [] };
			},
		});
		const embeddings = await aiSdkEmbedder({ model, dimensions: 2 }).embed(
			["a", "b", "c", "d", "e"],
			{ purpose: "document" },
		);

		expect(embeddings).toHaveLength(5);
		expect(model.doEmbedCalls.map((call) => call.values)).toEqual([
			["a", "b"],
			["c", "d"],
			["e"],
		]);
		expect(peak).toBe(1);
	});

	test("addMany sends at most maxBatch texts per embedder call", async () => {
		const model = mockModel();
		const memory = createMemory({
			embedder: aiSdkEmbedder({ model, dimensions: 2, maxBatch: 2 }),
		});
		await memory.addMany({
			scope: testScope("alice"),
			memories: [{ content: "a" }, { content: "b" }, { content: "c" }],
		});
		expect(model.doEmbedCalls.map((call) => call.values)).toEqual([
			["a", "b"],
			["c"],
		]);
	});
});

describe("aiSdkEmbedder errors", () => {
	test("turns an APICallError into a ProviderError without retrying it itself", async () => {
		const model = mockModel({
			doEmbed: async () => {
				throw apiCallError({
					statusCode: 429,
					responseHeaders: { "retry-after-ms": "250" },
					responseBody: '{"error":{"code":"rate_limit_exceeded"}}',
					data: { error: { code: "rate_limit_exceeded" } },
				});
			},
		});
		const error = await rejection(
			aiSdkEmbedder({ model, dimensions: 2 }).embed(["a"], {
				purpose: "document",
			}),
		);

		expect(model.doEmbedCalls).toHaveLength(1);
		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			code: "EMBEDDING",
			status: 429,
			retryAfterMs: 250,
			cause: { error: { code: "rate_limit_exceeded" } },
			message:
				"AI SDK embeddings request failed with status 429 (rate_limit_exceeded).",
		});
		expect((error as Error).message).not.toContain("sk-secret");
	});

	test("keeps the response body, or the error itself, as the cause", async () => {
		const withBody = await rejection(
			aiSdkEmbedder({
				model: mockModel({
					doEmbed: async () => {
						throw apiCallError({
							statusCode: 500,
							responseBody: "upstream down",
						});
					},
				}),
				dimensions: 2,
			}).embed(["a"], { purpose: "document" }),
		);
		expect(withBody).toMatchObject({ status: 500, cause: "upstream down" });

		const original = apiCallError({ statusCode: 502 });
		const withoutBody = await rejection(
			aiSdkEmbedder({
				model: mockModel({
					doEmbed: async () => {
						throw original;
					},
				}),
				dimensions: 2,
			}).embed(["a"], { purpose: "document" }),
		);
		expect(withoutBody).toMatchObject({ status: 502, cause: original });
	});

	test("throws errors without a status unchanged", async () => {
		const network = apiCallError({});
		const other = new Error("no such model");
		for (const thrown of [network, other]) {
			const error = await rejection(
				aiSdkEmbedder({
					model: mockModel({
						doEmbed: async () => {
							throw thrown;
						},
					}),
					dimensions: 2,
				}).embed(["a"], { purpose: "document" }),
			);
			expect(error).toBe(thrown);
		}
	});

	test("retries through the client's provider settings and honours Retry-After", async () => {
		const model = mockModel({
			doEmbed: vi
				.fn<DoEmbed>()
				.mockRejectedValueOnce(
					apiCallError({
						statusCode: 503,
						responseHeaders: { "retry-after": "0" },
					}),
				)
				.mockImplementation(async ({ values }) => ({
					embeddings: vectorsFor(values),
					warnings: [],
				})),
		});
		const memory = createMemory({
			embedder: aiSdkEmbedder({ model, dimensions: 2 }),
			provider: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
		});

		const started = Date.now();
		await memory.add({ scope: testScope("alice"), content: "x" });
		expect(model.doEmbedCalls).toHaveLength(2);
		// Retry-After: 0 replaces the one-minute backoff.
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("does not retry a 401", async () => {
		const model = mockModel({
			doEmbed: async () => {
				throw apiCallError({ statusCode: 401 });
			},
		});
		const memory = createMemory({
			embedder: aiSdkEmbedder({ model, dimensions: 2 }),
		});
		const error = await expectMnemocyteError(
			memory.add({ scope: testScope("alice"), content: "x" }),
			"EMBEDDING",
		);
		expect(error).toBeInstanceOf(ProviderError);
		expect(model.doEmbedCalls).toHaveLength(1);
	});
});

describe("aiSdkEmbedder through the AI Gateway provider", () => {
	const BASE_URL = "https://gateway.test/v1/ai";

	function gatewayWith(fetchMock: typeof fetch) {
		return createGateway({
			apiKey: "test-gateway-key",
			baseURL: BASE_URL,
			fetch: fetchMock,
		});
	}

	test("sends the upstream provider's hints in the gateway request", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ embeddings: [[0.5, 0.5]] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		const embedder = aiSdkEmbedder({
			model: gatewayWith(fetchMock).embeddingModel(
				"google/gemini-embedding-001",
			),
			dimensions: 2,
		});

		expect(embedder.model).toBe("gemini-embedding-001");
		await expect(
			embedder.embed(["a"], { purpose: "document" }),
		).resolves.toEqual([[0.5, 0.5]]);

		const [url, init] = fetchMock.mock.calls[0] ?? [];
		expect(String(url)).toBe(`${BASE_URL}/embedding-model`);
		expect(JSON.parse(String(init?.body))).toMatchObject({
			values: ["a"],
			dimensions: 2,
			providerOptions: { google: { taskType: "RETRIEVAL_DOCUMENT" } },
		});
	});

	test("turns a gateway error into a ProviderError with the wait it asks for", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "Too many requests",
							type: "rate_limit_exceeded",
						},
					}),
					{
						status: 429,
						headers: {
							"content-type": "application/json",
							"retry-after": "2",
						},
					},
				),
		);
		const error = await rejection(
			aiSdkEmbedder({
				model: gatewayWith(fetchMock).embeddingModel(
					"openai/text-embedding-3-small",
				),
			}).embed(["a"], { purpose: "query" }),
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			status: 429,
			retryAfterMs: 2000,
			message:
				"AI SDK embeddings request failed with status 429 (rate_limit_exceeded).",
		});
	});
});
