import { MnemocyteError } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders/openai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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
		await embedder.embed(["hello"]);

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
			baseUrl: "https://example.test/v1",
		});
		const embeddings = await embedder.embed(["first", "second"], {
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

		await expect(embedder.embed(["first", "second"])).rejects.toMatchObject({
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
	] as const)("rejects OpenAI embedding responses with %s", async (_label, data) => {
		mockEmbeddingResponse(data);
		const embedder = openaiEmbedder({
			apiKey: "test-key",
			model: "text-embedding-3-small",
		});

		await expect(embedder.embed(["first", "second"])).rejects.toMatchObject({
			code: "EMBEDDING",
		});
	});

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

		await embedder.embed(["custom dimensions"]);

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

	test("surfaces failed HTTP statuses for provider retry handling", async () => {
		vi.stubEnv("OPENAI_API_KEY", "env-key");
		fetchMock.mockResolvedValueOnce(
			new Response("rate limited", { status: 429 }),
		);

		const embedder = openaiEmbedder({ model: "text-embedding-3-small" });

		await expect(embedder.embed(["hello"])).rejects.toMatchObject({
			status: 429,
		});
	});
});
