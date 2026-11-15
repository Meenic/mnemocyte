import { MnemocyteError, ProviderError } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders/openai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { jsonFetch, NOT_FETCH_FUNCTIONS } from "./fetch-mock.js";

describe("openaiEmbedder", () => {
	const originalFetch = globalThis.fetch;
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		vi.stubGlobal("fetch", originalFetch);
	});

	function mockEmbeddingResponse(data: unknown): void {
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify({ data }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	}

	test("defaults the API key from OPENAI_API_KEY", () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");

		const embedder = openaiEmbedder({ model: "text-embedding-3-small" });

		expect(embedder.model).toBe("text-embedding-3-small");
		expect(embedder.dimensions).toBe(1536);
	});

	test("uses explicit apiKey over OPENAI_API_KEY", async () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");
		mockEmbeddingResponse([{ index: 0, embedding: [1] }]);

		const embedder = openaiEmbedder({
			apiKey: "explicit-key",
			model: "text-embedding-3-large",
			dimensions: 1,
		});
		await embedder.embed(["hello"], { purpose: "document" });

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.openai.com/v1/embeddings",
			expect.objectContaining({
				headers: expect.objectContaining({
					authorization: "Bearer explicit-key",
				}),
			}),
		);
	});

	test("throws CONFIG when no API key is available", () => {
		vi.stubEnv("OPENAI_API_KEY", "");

		expect(() => openaiEmbedder({ model: "text-embedding-3-small" })).toThrow(
			MnemocyteError,
		);
		try {
			openaiEmbedder({ model: "text-embedding-3-small" });
		} catch (error) {
			expect(error).toBeInstanceOf(MnemocyteError);
			expect((error as MnemocyteError).code).toBe("CONFIG");
		}
	});

	test("forwards AbortSignal, sends the expected request, and restores index order", async () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");
		const controller = new AbortController();
		mockEmbeddingResponse([
			{ index: 1, embedding: [0, 1] },
			{ index: 0, embedding: [1, 0] },
		]);

		const embedder = openaiEmbedder({
			apiKey: "explicit-key",
			model: "text-embedding-3-small",
			baseURL: "https://example.test/v1",
		});
		const embeddings = await embedder.embed(["first", "second"], {
			purpose: "document",
			signal: controller.signal,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://example.test/v1/embeddings",
			{
				method: "POST",
				headers: {
					authorization: "Bearer explicit-key",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: "text-embedding-3-small",
					input: ["first", "second"],
					encoding_format: "float",
				}),
				signal: controller.signal,
			},
		);
		expect(embeddings).toEqual([
			[1, 0],
			[0, 1],
		]);
	});

	test("rejects the documented duplicate-index overwrite response", async () => {
		mockEmbeddingResponse([
			{ index: 0, embedding: [1, 0] },
			{ index: 0, embedding: [0, 1] },
			{ index: 1, embedding: [1, 1] },
		]);
		const embedder = openaiEmbedder({
			apiKey: "test-key",
			model: "text-embedding-3-small",
		});

		await expect(
			embedder.embed(["first", "second"], { purpose: "document" }),
		).rejects.toMatchObject({
			code: "EMBEDDING",
		});
	});

	test.each([
		[
			"duplicate indices",
			[
				{ index: 0, embedding: [1, 0] },
				{ index: 0, embedding: [0, 1] },
			],
		],
		[
			"an extra item",
			[
				{ index: 0, embedding: [1, 0] },
				{ index: 1, embedding: [0, 1] },
				{ index: 0, embedding: [1, 1] },
			],
		],
		["a missing item", [{ index: 0, embedding: [1, 0] }]],
		[
			"non-array data",
			{
				first: { index: 0, embedding: [1, 0] },
				second: { index: 1, embedding: [0, 1] },
			},
		],
		["a null item", [null, { index: 1, embedding: [0, 1] }]],
		[
			"a non-array embedding",
			[
				{ index: 0, embedding: "not-an-array" },
				{ index: 1, embedding: [0, 1] },
			],
		],
		[
			"a non-integer index",
			[
				{ index: 0.5, embedding: [1, 0] },
				{ index: 1, embedding: [0, 1] },
			],
		],
		[
			"an out-of-range index",
			[
				{ index: 0, embedding: [1, 0] },
				{ index: 2, embedding: [0, 1] },
			],
		],
	] as const)(
		"rejects OpenAI embedding responses with %s",
		async (_label, data) => {
			mockEmbeddingResponse(data);
			const embedder = openaiEmbedder({
				apiKey: "test-key",
				model: "text-embedding-3-small",
			});

			await expect(
				embedder.embed(["first", "second"], { purpose: "document" }),
			).rejects.toMatchObject({
				code: "EMBEDDING",
			});
		},
	);

	test("uses known model dimensions and sends supported dimension overrides", async () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");
		mockEmbeddingResponse([{ index: 0, embedding: [1, 2, 3] }]);

		expect(openaiEmbedder({ model: "text-embedding-3-large" }).dimensions).toBe(
			3072,
		);
		expect(openaiEmbedder({ model: "text-embedding-ada-002" }).dimensions).toBe(
			1536,
		);

		const embedder = openaiEmbedder({
			model: "text-embedding-3-large",
			dimensions: 3,
		});
		expect(embedder.dimensions).toBe(3);

		await embedder.embed(["custom dimensions"], { purpose: "document" });

		const [, init] = fetchMock.mock.calls.at(-1) ?? [];
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "text-embedding-3-large",
			input: ["custom dimensions"],
			encoding_format: "float",
			dimensions: 3,
		});
	});

	test("requires dimensions for unknown models", () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");

		expect(() => openaiEmbedder({ model: "future-embedding-model" })).toThrow(
			MnemocyteError,
		);

		const embedder = openaiEmbedder({
			model: "future-embedding-model",
			dimensions: 2048,
		});

		expect(embedder.dimensions).toBe(2048);
	});

	test("rejects dimension overrides for models that do not support them", () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");

		expect(() =>
			openaiEmbedder({
				model: "text-embedding-ada-002",
				dimensions: 1536,
			}),
		).toThrow(MnemocyteError);
	});

	test("throws ProviderError with status, Retry-After and the body as cause", async () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");
		const body = {
			error: {
				message: "Rate limit reached for requests",
				type: "requests",
				param: null,
				code: "rate_limit_exceeded",
			},
		};
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(body), {
				status: 429,
				headers: { "retry-after": "2" },
			}),
		);

		const embedder = openaiEmbedder({ model: "text-embedding-3-small" });
		const error = await embedder.embed(["hello"], { purpose: "document" }).then(
			() => undefined,
			(caught: unknown) => caught,
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toBeInstanceOf(MnemocyteError);
		expect(error).toMatchObject({
			code: "EMBEDDING",
			status: 429,
			retryAfterMs: 2000,
			cause: body,
			message:
				"OpenAI embeddings request failed with status 429 (rate_limit_exceeded).",
		});
	});

	test("sends maxBatch through and ignores purpose", async () => {
		const embedder = openaiEmbedder({
			apiKey: "test-key",
			model: "text-embedding-3-small",
			maxBatch: 16,
		});
		expect(embedder.maxBatch).toBe(16);
		expect(() =>
			openaiEmbedder({
				apiKey: "test-key",
				model: "text-embedding-3-small",
				maxBatch: 0,
			}),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));

		mockEmbeddingResponse([{ index: 0, embedding: [1] }]);
		await embedder.embed(["question"], { purpose: "query" });
		const [, init] = fetchMock.mock.calls.at(-1) ?? [];
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "text-embedding-3-small",
			input: ["question"],
			encoding_format: "float",
		});
	});

	test("sends extra headers lower-cased, with its own key and content-type winning", async () => {
		const embedder = openaiEmbedder({
			apiKey: "openai-key",
			model: "text-embedding-3-small",
			headers: {
				"OpenAI-Project": "proj_1",
				Authorization: "Bearer caller-key",
				"content-type": "text/plain",
			},
		});

		mockEmbeddingResponse([{ index: 0, embedding: [1] }]);
		await embedder.embed(["a"], { purpose: "document" });

		const [, init] = fetchMock.mock.calls.at(-1) ?? [];
		expect(init?.headers).toEqual({
			"openai-project": "proj_1",
			authorization: "Bearer openai-key",
			"content-type": "application/json",
		});
	});

	test.each([
		["non-object headers", []],
		["a non-string header", { "x-a": 1 }],
		["an invalid header name", { "x a": "v" }],
	])("rejects %s with CONFIG", (_label, headers) => {
		expect(() =>
			openaiEmbedder({
				apiKey: "k",
				model: "text-embedding-3-small",
				headers: headers as unknown as Record<string, string>,
			}),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});

	test("sends every request through a custom fetch, with the call's signal", async () => {
		const customFetch = jsonFetch({ data: [{ index: 0, embedding: [1] }] });
		const embedder = openaiEmbedder({
			apiKey: "openai-key",
			model: "text-embedding-3-small",
			fetch: customFetch,
		});
		const controller = new AbortController();

		await expect(
			embedder.embed(["a"], { purpose: "query", signal: controller.signal }),
		).resolves.toEqual([[1]]);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(customFetch).toHaveBeenCalledTimes(1);
		const [url, init] = customFetch.mock.calls[0] ?? [];
		expect(url).toBe("https://api.openai.com/v1/embeddings");
		expect(init).toMatchObject({
			method: "POST",
			headers: {
				authorization: "Bearer openai-key",
				"content-type": "application/json",
			},
			signal: controller.signal,
		});
		expect(JSON.parse(String(init?.body))).toEqual({
			model: "text-embedding-3-small",
			input: ["a"],
			encoding_format: "float",
		});
	});

	test.each([...NOT_FETCH_FUNCTIONS])(
		"rejects a fetch that is %s with CONFIG",
		(_label, value) => {
			expect(() =>
				openaiEmbedder({
					apiKey: "k",
					model: "text-embedding-3-small",
					fetch: value as typeof fetch,
				}),
			).toThrow(
				expect.objectContaining({
					code: "CONFIG",
					reason: "INVALID_OPTION",
					message: "openaiEmbedder fetch must be a function.",
				}),
			);
		},
	);
});
