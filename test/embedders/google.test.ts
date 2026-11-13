import { createMemory, ProviderError } from "mnemocyte";
import { googleEmbedder } from "mnemocyte/embedders/google";
import { describe, expect, test, vi } from "vitest";
import { testScope } from "../helpers.js";
import { rejection, useFetchMock } from "./fetch-mock.js";

function googleResponse(vectors: number[][]) {
	return { embeddings: vectors.map((values) => ({ values })) };
}

describe("googleEmbedder", () => {
	const { fetchMock, respondJson, lastRequest, lastBody } = useFetchMock();

	test("reads GEMINI_API_KEY and sends taskType for each purpose", async () => {
		vi.stubEnv("GEMINI_API_KEY", "env-key");
		const embedder = googleEmbedder({ model: "gemini-embedding-001" });

		expect(embedder).toMatchObject({
			model: "gemini-embedding-001",
			dimensions: 3072,
			maxBatch: 100,
		});

		respondJson(googleResponse([[1], [2]]));
		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).resolves.toEqual([[1], [2]]);

		const { url, init } = lastRequest();
		expect(url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents",
		);
		// The key goes in a header, never in the URL.
		expect(url).not.toContain("key=");
		expect(init.headers).toEqual({
			"x-goog-api-key": "env-key",
			"content-type": "application/json",
		});
		const config = { taskType: "RETRIEVAL_DOCUMENT", autoTruncate: true };
		expect(lastBody()).toEqual({
			requests: [
				{
					model: "models/gemini-embedding-001",
					content: { parts: [{ text: "a" }] },
					embedContentConfig: config,
				},
				{
					model: "models/gemini-embedding-001",
					content: { parts: [{ text: "b" }] },
					embedContentConfig: config,
				},
			],
		});

		respondJson(googleResponse([[3]]));
		await embedder.embed(["where?"], { purpose: "query" });
		expect(lastBody()).toMatchObject({
			requests: [{ embedContentConfig: { taskType: "RETRIEVAL_QUERY" } }],
		});
	});

	test("marks gemini-embedding-2 purposes with text prefixes, not taskType", async () => {
		const embedder = googleEmbedder({
			apiKey: "k",
			model: "models/gemini-embedding-2",
			dimensions: 768,
			truncate: false,
		});
		expect(embedder).toMatchObject({
			model: "gemini-embedding-2",
			dimensions: 768,
		});

		respondJson(googleResponse([[1]]));
		await embedder.embed(["Likes tea."], { purpose: "document" });
		expect(lastRequest().url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents",
		);
		expect(lastBody()).toEqual({
			requests: [
				{
					model: "models/gemini-embedding-2",
					content: { parts: [{ text: "title: none | text: Likes tea." }] },
					embedContentConfig: {
						outputDimensionality: 768,
						autoTruncate: false,
					},
				},
			],
		});

		respondJson(googleResponse([[1]]));
		await embedder.embed(["tea?"], { purpose: "query" });
		expect(lastBody()).toMatchObject({
			requests: [
				{
					content: {
						parts: [{ text: "task: search result | query: tea?" }],
					},
				},
			],
		});
	});

	test("sends taskType but no size for unknown models, and uses the baseUrl", async () => {
		const embedder = googleEmbedder({
			apiKey: "k",
			model: "gemini-embedding-next",
			dimensions: 1024,
			baseUrl: "https://proxy.example/gemini/v1beta/",
			maxBatch: 10,
		});
		expect(embedder.maxBatch).toBe(10);

		respondJson(googleResponse([[1]]));
		await embedder.embed(["a"], { purpose: "query" });

		expect(lastRequest().url).toBe(
			"https://proxy.example/gemini/v1beta/models/gemini-embedding-next:batchEmbedContents",
		);
		expect(lastBody()).toMatchObject({
			requests: [
				{
					embedContentConfig: {
						taskType: "RETRIEVAL_QUERY",
						autoTruncate: true,
					},
				},
			],
		});
		expect(
			(lastBody().requests as { embedContentConfig: object }[])[0]
				?.embedContentConfig,
		).not.toHaveProperty("outputDimensionality");
	});

	test.each([
		["no API key", { model: "gemini-embedding-001" }],
		["an empty model after models/", { apiKey: "k", model: "models/" }],
		["an unknown model without dimensions", { apiKey: "k", model: "x" }],
		[
			"a size below 128",
			{ apiKey: "k", model: "gemini-embedding-001", dimensions: 64 },
		],
		[
			"a size above 3072",
			{ apiKey: "k", model: "gemini-embedding-2", dimensions: 4096 },
		],
		[
			"a non-boolean truncate",
			{ apiKey: "k", model: "gemini-embedding-001", truncate: 1 },
		],
	])("rejects %s with CONFIG", (_label, options) => {
		vi.stubEnv("GEMINI_API_KEY", "");
		expect(() =>
			googleEmbedder(options as Parameters<typeof googleEmbedder>[0]),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});

	test.each([
		["no embeddings list", { embedding: { values: [1] } }],
		["too many vectors", googleResponse([[1], [2]])],
		["an item without values", { embeddings: [{}] }],
	])("rejects a response with %s with EMBEDDING", async (_label, body) => {
		respondJson(body);

		await expect(
			googleEmbedder({ apiKey: "k", model: "gemini-embedding-001" }).embed(
				["a"],
				{ purpose: "document" },
			),
		).rejects.toMatchObject({ code: "EMBEDDING" });
	});

	test("labels an error response with its canonical status", async () => {
		const body = {
			error: {
				code: 429,
				message: "Resource has been exhausted (e.g. check quota).",
				status: "RESOURCE_EXHAUSTED",
				details: [],
			},
		};
		respondJson(body, 429);

		const error = await rejection(
			googleEmbedder({ apiKey: "k", model: "gemini-embedding-001" }).embed(
				["a"],
				{ purpose: "document" },
			),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			status: 429,
			cause: body,
			message:
				"Google embeddings request failed with status 429 (RESOURCE_EXHAUSTED).",
		});
	});

	test("retries a 503 through the client and stops on a 400", async () => {
		const embedder = googleEmbedder({
			apiKey: "k",
			model: "custom-gemini",
			dimensions: 2,
		});
		respondJson(
			{ error: { code: 503, message: "busy", status: "UNAVAILABLE" } },
			503,
		);
		respondJson(googleResponse([[1, 2]]));
		const memory = createMemory({
			embedder,
			provider: { baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 10_000 },
		});

		await memory.search({ scope: testScope("alice"), query: "tea" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(lastRequest().init.signal).toBeInstanceOf(AbortSignal);

		respondJson(
			{
				error: { code: 400, message: "bad", status: "INVALID_ARGUMENT" },
			},
			400,
		);
		await expect(
			memory.add({ scope: testScope("alice"), content: "x" }),
		).rejects.toBeInstanceOf(ProviderError);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
