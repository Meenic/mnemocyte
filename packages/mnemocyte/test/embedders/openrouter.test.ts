import { createMemory, ProviderError } from "mnemocyte";
import { openrouterEmbedder } from "mnemocyte/embedders/openrouter";
import { describe, expect, test, vi } from "vitest";
import { testScope } from "../helpers.js";
import {
	jsonFetch,
	NOT_FETCH_FUNCTIONS,
	rejection,
	useFetchMock,
} from "./fetch-mock.js";

function openrouterResponse(vectors: number[][], order?: number[]) {
	const indexes = order ?? vectors.map((_, index) => index);
	return {
		id: "embd-1",
		object: "list",
		data: indexes.map((index) => ({
			object: "embedding",
			embedding: vectors[index],
			index,
		})),
		model: "openai/text-embedding-3-small",
		usage: { prompt_tokens: 3, total_tokens: 3 },
	};
}

describe("openrouterEmbedder", () => {
	const { fetchMock, respondJson, lastRequest, lastBody } = useFetchMock();

	test("reads OPENROUTER_API_KEY and reports the model without its vendor", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "env-key");
		const embedder = openrouterEmbedder({
			model: "openai/text-embedding-3-small",
		});

		expect(embedder).toMatchObject({
			model: "text-embedding-3-small",
			dimensions: 1536,
		});
		expect(embedder.maxBatch).toBeUndefined();

		respondJson(openrouterResponse([[1], [2]], [1, 0]));
		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).resolves.toEqual([[1], [2]]);

		const { url, init } = lastRequest();
		expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			authorization: "Bearer env-key",
			"content-type": "application/json",
		});
		expect(lastBody()).toEqual({
			model: "openai/text-embedding-3-small",
			input: ["a", "b"],
			encoding_format: "float",
		});
	});

	test("sends routing as provider and app as attribution headers", async () => {
		const routing = {
			order: ["deepinfra"],
			allow_fallbacks: false,
			data_collection: "deny" as const,
		};
		const embedder = openrouterEmbedder({
			apiKey: "or-key",
			model: "qwen/qwen3-embedding-8b",
			routing,
			app: { url: "https://memory.example", name: "Memory App" },
			headers: {
				"HTTP-Referer": "https://caller.example",
				"x-team": "memory",
				Authorization: "Bearer caller-key",
			},
		});
		routing.order.push("changed");

		expect(embedder).toMatchObject({
			model: "qwen3-embedding-8b",
			dimensions: 4096,
		});
		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["a"], { purpose: "query" });

		expect(lastRequest().init.headers).toEqual({
			"x-team": "memory",
			"http-referer": "https://memory.example",
			"x-openrouter-title": "Memory App",
			authorization: "Bearer or-key",
			"content-type": "application/json",
		});
		expect(lastBody()).toEqual({
			model: "qwen/qwen3-embedding-8b",
			input: ["a"],
			encoding_format: "float",
			provider: {
				order: ["deepinfra"],
				allow_fallbacks: false,
				data_collection: "deny",
			},
		});
	});

	test("sends the schema's options, sort object and max_price fields", async () => {
		const routing = {
			sort: { by: "price", partition: "none" },
			max_price: { prompt: "0.02", audio: 0.5 },
			options: { deepinfra: { priority: "high" } },
		} as const;
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: MODEL,
			routing,
		});
		respondJson(openrouterResponse([Array(1536).fill(0)]));

		await embedder.embed(["a"], { purpose: "document" });

		expect(lastBody()).toMatchObject({ provider: routing });
	});

	test("sends only http-referer when app has no name", async () => {
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "openai/text-embedding-3-small",
			app: { url: "https://memory.example" },
		});
		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["a"], { purpose: "query" });

		expect(lastRequest().init.headers).toEqual({
			"http-referer": "https://memory.example",
			authorization: "Bearer k",
			"content-type": "application/json",
		});
	});

	test("sends input_type for Perplexity v2 but not v1", async () => {
		const v2 = openrouterEmbedder({
			apiKey: "k",
			model: "perplexity/pplx-embed-v2-context-9b",
		});
		expect(v2).toMatchObject({
			model: "pplx-embed-v2-context-9b",
			dimensions: 2048,
		});
		respondJson(openrouterResponse([[1]]));
		await v2.embed(["a"], { purpose: "document" });
		expect(lastBody()).toMatchObject({ input: ["a"], input_type: "document" });
		respondJson(openrouterResponse([[1]]));
		await v2.embed(["where?"], { purpose: "query" });
		expect(lastBody()).toMatchObject({ input_type: "query" });

		const v1 = openrouterEmbedder({
			apiKey: "k",
			model: "perplexity/pplx-embed-v1-4b",
		});
		respondJson(openrouterResponse([[1]]));
		await v1.embed(["a"], { purpose: "document" });
		expect(lastBody()).not.toHaveProperty("input_type");

		const other = openrouterEmbedder({
			apiKey: "k",
			model: "qwen/qwen3-embedding-8b",
		});
		respondJson(openrouterResponse([[1]]));
		await other.embed(["a"], { purpose: "query" });
		expect(lastBody()).not.toHaveProperty("input_type");
	});

	test.each([
		["cohere/embed-5-pro", "search_query", "search_document"],
		["mongodb/voyage-4", "query", "document"],
		["mongodb/voyage-multimodal-3.5", "query", "document"],
	])(
		"sends %s the input_type its own API takes",
		async (model, query, document) => {
			const embedder = openrouterEmbedder({
				apiKey: "k",
				model,
				dimensions: 1024,
			});

			respondJson(openrouterResponse([[1]]));
			await embedder.embed(["a"], { purpose: "query" });
			expect(lastBody()).toMatchObject({ input: ["a"], input_type: query });
			respondJson(openrouterResponse([[1]]));
			await embedder.embed(["b"], { purpose: "document" });
			expect(lastBody()).toMatchObject({ input: ["b"], input_type: document });
		},
	);

	test("sends the Gemini prefixes for google/gemini-embedding-2", async () => {
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "google/gemini-embedding-2",
		});
		expect(embedder).toMatchObject({
			model: "gemini-embedding-2",
			dimensions: 3072,
		});

		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["Likes tea."], { purpose: "document" });
		expect(lastBody()).toEqual({
			model: "google/gemini-embedding-2",
			input: ["title: none | text: Likes tea."],
			encoding_format: "float",
		});

		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["tea?"], { purpose: "query" });
		expect(lastBody()).toMatchObject({
			input: ["task: search result | query: tea?"],
		});
	});

	test("purposes replace the built-in hints", async () => {
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "perplexity/pplx-embed-v2-context-0.6b",
			purposes: { query: { prefix: "query: " } },
		});

		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["a"], { purpose: "query" });
		expect(lastBody()).toEqual({
			model: "perplexity/pplx-embed-v2-context-0.6b",
			input: ["query: a"],
			encoding_format: "float",
		});

		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["b"], { purpose: "document" });
		expect(lastBody()).not.toHaveProperty("input_type");
	});

	test("sends purpose body fields", async () => {
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "intfloat/e5-large-v2",
			purposes: {
				query: { prefix: "query: ", body: { user: "u1" } },
				document: { prefix: "passage: " },
			},
		});

		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["a"], { purpose: "query" });
		expect(lastBody()).toEqual({
			model: "intfloat/e5-large-v2",
			input: ["query: a"],
			encoding_format: "float",
			user: "u1",
		});
	});

	test("sends a smaller size for a model that takes one", async () => {
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "openai/text-embedding-3-large",
			dimensions: 256,
			baseURL: "https://proxy.example/openrouter/v1/",
			maxBatch: 20,
		});
		expect(embedder).toMatchObject({ dimensions: 256, maxBatch: 20 });

		respondJson(openrouterResponse([[1]]));
		await embedder.embed(["a"], { purpose: "document" });
		expect(lastRequest().url).toBe(
			"https://proxy.example/openrouter/v1/embeddings",
		);
		expect(lastBody()).toMatchObject({ dimensions: 256 });
	});

	test("does not send dimensions for fixed-size or unknown models", async () => {
		const fixed = openrouterEmbedder({
			apiKey: "k",
			model: "baai/bge-m3",
			dimensions: 1024,
		});
		respondJson(openrouterResponse([[1]]));
		await fixed.embed(["a"], { purpose: "document" });
		expect(lastBody()).not.toHaveProperty("dimensions");

		const unknown = openrouterEmbedder({
			apiKey: "k",
			model: "nvidia/nemotron-3-embed-1b:free",
			dimensions: 2048,
		});
		expect(unknown).toMatchObject({
			model: "nemotron-3-embed-1b:free",
			dimensions: 2048,
		});
		respondJson(openrouterResponse([[1]]));
		await unknown.embed(["a"], { purpose: "document" });
		expect(lastBody()).not.toHaveProperty("dimensions");
	});

	test("sends every request through a custom fetch, with the call's signal", async () => {
		const customFetch = jsonFetch(openrouterResponse([[1]]));
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "openai/text-embedding-3-small",
			fetch: customFetch,
		});
		const controller = new AbortController();

		await embedder.embed(["a"], {
			purpose: "query",
			signal: controller.signal,
		});

		expect(fetchMock).not.toHaveBeenCalled();
		const [url, init] = customFetch.mock.calls[0] ?? [];
		expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
		expect(init).toMatchObject({ method: "POST", signal: controller.signal });
	});

	test.each([...NOT_FETCH_FUNCTIONS])(
		"rejects a fetch that is %s with CONFIG",
		(_label, value) => {
			expect(() =>
				openrouterEmbedder({
					apiKey: "k",
					model: "openai/text-embedding-3-small",
					fetch: value as typeof fetch,
				}),
			).toThrow(
				expect.objectContaining({
					code: "CONFIG",
					message: "openrouterEmbedder fetch must be a function.",
				}),
			);
		},
	);

	const MODEL = "openai/text-embedding-3-small";

	test.each([
		["no API key", { model: MODEL }],
		["an empty API key", { apiKey: " ", model: MODEL }],
		["a missing model", { apiKey: "k", model: "" }],
		["a vendor without a model", { apiKey: "k", model: "openai/" }],
		["an unknown model without dimensions", { apiKey: "k", model: "x/y" }],
		[
			"a size a fixed model cannot take",
			{ apiKey: "k", model: "baai/bge-m3", dimensions: 512 },
		],
		["a size out of range", { apiKey: "k", model: MODEL, dimensions: 2048 }],
		[
			"an unsupported size",
			{ apiKey: "k", model: "cohere/embed-5-pro", dimensions: 100 },
		],
		[
			"routing that is not an object",
			{ apiKey: "k", model: MODEL, routing: [] },
		],
		[
			"a routing field OpenRouter would ignore",
			{ apiKey: "k", model: MODEL, routing: { allow_fallback: false } },
		],
		[
			"routing that is not JSON",
			{ apiKey: "k", model: MODEL, routing: { max_price: { prompt: 1n } } },
		],
		["app that is not an object", { apiKey: "k", model: MODEL, app: "x" }],
		["app without url", { apiKey: "k", model: MODEL, app: { name: "A" } }],
		["a relative app.url", { apiKey: "k", model: MODEL, app: { url: "/app" } }],
		[
			"an empty app.name",
			{
				apiKey: "k",
				model: MODEL,
				app: { url: "https://a.example", name: "" },
			},
		],
		[
			"an app.name HTTP cannot carry",
			{
				apiKey: "k",
				model: MODEL,
				app: { url: "https://a.example", name: "Tea\napp" },
			},
		],
		[
			"an unknown app key",
			{
				apiKey: "k",
				model: MODEL,
				app: { url: "https://a.example", title: "A" },
			},
		],
		[
			"a purpose body that sets model",
			{
				apiKey: "k",
				model: MODEL,
				purposes: { query: { body: { model: "x" } } },
			},
		],
		["a zero maxBatch", { apiKey: "k", model: MODEL, maxBatch: 0 }],
		["a relative baseURL", { apiKey: "k", model: MODEL, baseURL: "/v1" }],
		["baseUrl", { apiKey: "k", model: MODEL, baseUrl: "https://a.example" }],
		[
			"a non-string header",
			{ apiKey: "k", model: MODEL, headers: { "x-a": 1 } },
		],
		["an unknown option", { apiKey: "k", model: MODEL, provider: {} }],
	])("rejects %s with CONFIG", (_label, options) => {
		vi.stubEnv("OPENROUTER_API_KEY", "");
		expect(() =>
			openrouterEmbedder(options as Parameters<typeof openrouterEmbedder>[0]),
		).toThrow(
			expect.objectContaining({ code: "CONFIG", reason: "INVALID_OPTION" }),
		);
	});

	test("rejects a call without a purpose with VALIDATION", async () => {
		const embedder = openrouterEmbedder({ apiKey: "k", model: MODEL });
		const untyped = embedder.embed as (texts: string[]) => Promise<number[][]>;

		await expect(untyped.call(embedder, ["a"])).rejects.toMatchObject({
			code: "VALIDATION",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("reads a response without indexes in order", async () => {
		const embedder = openrouterEmbedder({ apiKey: "k", model: MODEL });
		respondJson({
			object: "list",
			data: [
				{ object: "embedding", embedding: [1] },
				{ object: "embedding", embedding: [2] },
			],
			model: MODEL,
		});

		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).resolves.toEqual([[1], [2]]);
	});

	test.each([
		["one embedding short", { data: [{ embedding: [1], index: 0 }] }],
		["no indexes and one short", { data: [{ embedding: [1] }] }],
		[
			"indexes on only some items",
			{ data: [{ embedding: [1], index: 1 }, { embedding: [2] }] },
		],
		[
			"a non-array embedding",
			{ data: [{ embedding: "x" }, { embedding: [2] }] },
		],
		[
			"an error whose code is not an HTTP status",
			{ error: { code: "overloaded", message: "x" } },
		],
	])(
		"rejects a malformed response (%s) with EMBEDDING",
		async (_label, body) => {
			const embedder = openrouterEmbedder({ apiKey: "k", model: MODEL });
			respondJson(body);

			await expect(
				embedder.embed(["a", "b"], { purpose: "document" }),
			).rejects.toMatchObject({ code: "EMBEDDING" });
		},
	);

	test("turns an error response into a ProviderError without its message", async () => {
		const body = { error: { code: 401, message: "No auth credentials found" } };
		respondJson(body, 401);

		const error = await rejection(
			openrouterEmbedder({ apiKey: "k", model: MODEL }).embed(["a"], {
				purpose: "document",
			}),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			code: "EMBEDDING",
			status: 401,
			cause: body,
			message: "OpenRouter embeddings request failed with status 401.",
		});
	});

	test("turns a 200 that holds only an error into a ProviderError", async () => {
		const body = {
			error: { code: 502, message: "Provider returned error" },
			user_id: "user_1",
		};
		respondJson(body);

		const error = await rejection(
			openrouterEmbedder({ apiKey: "k", model: MODEL }).embed(["a"], {
				purpose: "document",
			}),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			code: "EMBEDDING",
			status: 502,
			cause: body,
			message: "OpenRouter embeddings request failed with status 502.",
		});
	});

	test("retries a 200 that holds only a retryable error", async () => {
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "acme/custom-embed",
			dimensions: 2,
		});
		respondJson({ error: { code: 503, message: "No provider available" } });
		respondJson(openrouterResponse([[1, 2]]));
		const memory = createMemory({
			embedder,
			provider: { baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 10_000 },
		});

		await memory.add({ scope: testScope("alice"), content: "Likes tea." });

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	test("retries a 529 through the client", async () => {
		const embedder = openrouterEmbedder({
			apiKey: "k",
			model: "acme/custom-embed",
			dimensions: 2,
		});
		respondJson({ error: { code: 529, message: "Provider overloaded" } }, 529);
		respondJson(openrouterResponse([[1, 2]]));
		const memory = createMemory({
			embedder,
			provider: { baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 10_000 },
		});

		await memory.add({ scope: testScope("alice"), content: "Likes tea." });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(lastBody()).toMatchObject({ input: ["Likes tea."] });
	});
});
