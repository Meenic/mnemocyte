import { createMemory, ProviderError } from "mnemocyte";
import { cohereEmbedder } from "mnemocyte/embedders/cohere";
import { describe, expect, test, vi } from "vitest";
import { testScope } from "../helpers.js";
import { rejection, useFetchMock } from "./fetch-mock.js";

function cohereResponse(vectors: number[][]) {
	return {
		id: "req_1",
		embeddings: { float: vectors },
		texts: vectors.map(() => "t"),
		meta: { api_version: { version: "2" } },
	};
}

describe("cohereEmbedder", () => {
	const { fetchMock, respondJson, lastRequest, lastBody } = useFetchMock();

	test("reads COHERE_API_KEY and sends input_type for each purpose", async () => {
		vi.stubEnv("COHERE_API_KEY", "env-key");
		const embedder = cohereEmbedder({ model: "embed-v4.0" });

		expect(embedder).toMatchObject({
			model: "embed-v4.0",
			dimensions: 1536,
			maxBatch: 96,
		});

		respondJson(cohereResponse([[1], [2]]));
		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).resolves.toEqual([[1], [2]]);

		const { url, init } = lastRequest();
		expect(url).toBe("https://api.cohere.com/v2/embed");
		expect(init.headers).toEqual({
			authorization: "Bearer env-key",
			"content-type": "application/json",
		});
		expect(lastBody()).toEqual({
			model: "embed-v4.0",
			texts: ["a", "b"],
			input_type: "search_document",
			embedding_types: ["float"],
			truncate: "END",
		});

		respondJson(cohereResponse([[3]]));
		await embedder.embed(["where?"], { purpose: "query" });
		expect(lastBody()).toMatchObject({ input_type: "search_query" });
	});

	test("sends output_dimension, truncate NONE and the baseUrl", async () => {
		const embedder = cohereEmbedder({
			apiKey: "explicit-key",
			model: "embed-v5.0-fast",
			dimensions: 768,
			truncate: false,
			baseUrl: "https://proxy.example/cohere/v2",
			maxBatch: 50,
		});
		expect(embedder).toMatchObject({ dimensions: 768, maxBatch: 50 });

		respondJson(cohereResponse([[1]]));
		await embedder.embed(["a"], { purpose: "query" });

		expect(lastRequest().url).toBe("https://proxy.example/cohere/v2/embed");
		expect(lastBody()).toEqual({
			model: "embed-v5.0-fast",
			texts: ["a"],
			input_type: "search_query",
			embedding_types: ["float"],
			truncate: "NONE",
			output_dimension: 768,
		});
	});

	test("knows the fixed v3 sizes and sends none", async () => {
		const light = cohereEmbedder({
			apiKey: "k",
			model: "embed-multilingual-light-v3.0",
		});
		expect(light.dimensions).toBe(384);

		respondJson(cohereResponse([[1]]));
		await light.embed(["a"], { purpose: "document" });
		expect(lastBody()).not.toHaveProperty("output_dimension");
	});

	test.each([
		["no API key", { model: "embed-v4.0" }],
		["an unknown model without dimensions", { apiKey: "k", model: "x" }],
		[
			"an unsupported size",
			{ apiKey: "k", model: "embed-v4.0", dimensions: 768 },
		],
		[
			"another size for a fixed model",
			{ apiKey: "k", model: "embed-english-v3.0", dimensions: 384 },
		],
		["a maxBatch over 96", { apiKey: "k", model: "embed-v4.0", maxBatch: 97 }],
		[
			"a non-boolean truncate",
			{ apiKey: "k", model: "embed-v4.0", truncate: "END" },
		],
	])("rejects %s with CONFIG", (_label, options) => {
		vi.stubEnv("COHERE_API_KEY", "");
		expect(() =>
			cohereEmbedder(options as Parameters<typeof cohereEmbedder>[0]),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});

	test.each([
		["no embeddings object", { id: "x" }],
		["no float list", { embeddings: { int8: [[1]] } }],
		["too few vectors", { embeddings: { float: [] } }],
		["a vector that is not an array", { embeddings: { float: ["1"] } }],
	])("rejects a response with %s with EMBEDDING", async (_label, body) => {
		respondJson(body);

		await expect(
			cohereEmbedder({ apiKey: "k", model: "embed-v4.0" }).embed(["a"], {
				purpose: "document",
			}),
		).rejects.toMatchObject({ code: "EMBEDDING" });
	});

	test("turns an error response into a ProviderError without its message", async () => {
		const body = {
			id: "req_2",
			message:
				"invalid request: total number of texts must be at most 96 - received 104",
		};
		respondJson(body, 400);

		const error = await rejection(
			cohereEmbedder({ apiKey: "k", model: "embed-v4.0" }).embed(["a"], {
				purpose: "document",
			}),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			status: 400,
			cause: body,
			message: "Cohere embeddings request failed with status 400.",
		});
	});

	test("embeds through the client in batches of 96", async () => {
		const embedder = cohereEmbedder({
			apiKey: "k",
			model: "custom-embed",
			dimensions: 2,
		});
		fetchMock.mockImplementation(async (_url, init) => {
			const { texts } = JSON.parse(String(init?.body)) as { texts: string[] };
			return new Response(
				JSON.stringify(cohereResponse(texts.map(() => [1, 2]))),
				{ status: 200 },
			);
		});
		const memory = createMemory({ embedder });

		await memory.addMany({
			scope: testScope("alice"),
			memories: Array.from({ length: 100 }, (_, index) => ({
				content: `Fact ${index}.`,
			})),
		});

		const sizes = fetchMock.mock.calls.map(
			([, init]) =>
				(JSON.parse(String(init?.body)) as { texts: string[] }).texts.length,
		);
		expect(sizes).toEqual([96, 4]);
	});
});
