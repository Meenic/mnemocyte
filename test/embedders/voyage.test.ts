import { createMemory, ProviderError } from "mnemocyte";
import { voyageEmbedder } from "mnemocyte/embedders/voyage";
import { describe, expect, test, vi } from "vitest";
import { testScope } from "../helpers.js";
import { rejection, useFetchMock } from "./fetch-mock.js";

function voyageResponse(vectors: number[][], order?: number[]) {
	const indexes = order ?? vectors.map((_, index) => index);
	return {
		object: "list",
		data: indexes.map((index) => ({
			object: "embedding",
			embedding: vectors[index],
			index,
		})),
		model: "voyage-4",
		usage: { total_tokens: 3 },
	};
}

describe("voyageEmbedder", () => {
	const { fetchMock, respondJson, lastRequest, lastBody } = useFetchMock();

	test("reads VOYAGE_API_KEY and sends input_type for each purpose", async () => {
		vi.stubEnv("VOYAGE_API_KEY", "env-key");
		const embedder = voyageEmbedder({ model: "voyage-4" });

		expect(embedder).toMatchObject({ model: "voyage-4", dimensions: 1024 });
		expect(embedder.maxBatch).toBeUndefined();

		respondJson(voyageResponse([[1], [2]], [1, 0]));
		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).resolves.toEqual([[1], [2]]);

		const { url, init } = lastRequest();
		expect(url).toBe("https://api.voyageai.com/v1/embeddings");
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({
			authorization: "Bearer env-key",
			"content-type": "application/json",
		});
		expect(lastBody()).toEqual({
			model: "voyage-4",
			input: ["a", "b"],
			input_type: "document",
			truncation: true,
		});

		respondJson(voyageResponse([[3]]));
		await embedder.embed(["where?"], { purpose: "query" });
		expect(lastBody()).toMatchObject({
			input: ["where?"],
			input_type: "query",
		});
	});

	test("prefers apiKey and sends output_dimension, truncation and baseUrl", async () => {
		vi.stubEnv("VOYAGE_API_KEY", "env-key");
		const embedder = voyageEmbedder({
			apiKey: "explicit-key",
			model: "voyage-3.5-lite",
			dimensions: 256,
			truncate: false,
			baseUrl: "https://proxy.example/voyage/v1/",
			maxBatch: 20,
		});
		expect(embedder).toMatchObject({ dimensions: 256, maxBatch: 20 });

		respondJson(voyageResponse([[1]]));
		await embedder.embed(["a"], { purpose: "document" });

		expect(lastRequest().url).toBe(
			"https://proxy.example/voyage/v1/embeddings",
		);
		expect(lastRequest().init.headers).toMatchObject({
			authorization: "Bearer explicit-key",
		});
		expect(lastBody()).toEqual({
			model: "voyage-3.5-lite",
			input: ["a"],
			input_type: "document",
			truncation: false,
			output_dimension: 256,
		});
	});

	test("does not send dimensions for fixed-size or unknown models", async () => {
		const fixed = voyageEmbedder({
			apiKey: "k",
			model: "voyage-law-2",
			dimensions: 1024,
		});
		respondJson(voyageResponse([[1]]));
		await fixed.embed(["a"], { purpose: "document" });
		expect(lastBody()).not.toHaveProperty("output_dimension");

		const unknown = voyageEmbedder({
			apiKey: "k",
			model: "voyage-code-4",
			dimensions: 1024,
		});
		expect(unknown.dimensions).toBe(1024);
		respondJson(voyageResponse([[1]]));
		await unknown.embed(["a"], { purpose: "document" });
		expect(lastBody()).not.toHaveProperty("output_dimension");
	});

	test.each([
		["no API key", { model: "voyage-4" }],
		["an empty API key", { apiKey: " ", model: "voyage-4" }],
		["a missing model", { apiKey: "k", model: "" }],
		["an unknown model without dimensions", { apiKey: "k", model: "x" }],
		[
			"an unsupported size",
			{ apiKey: "k", model: "voyage-4", dimensions: 768 },
		],
		[
			"another size for a fixed model",
			{ apiKey: "k", model: "voyage-finance-2", dimensions: 512 },
		],
		["fractional dimensions", { apiKey: "k", model: "x", dimensions: 1.5 }],
		[
			"a non-boolean truncate",
			{ apiKey: "k", model: "voyage-4", truncate: "yes" },
		],
		["a zero maxBatch", { apiKey: "k", model: "voyage-4", maxBatch: 0 }],
		["a relative baseUrl", { apiKey: "k", model: "voyage-4", baseUrl: "/v1" }],
	])("rejects %s with CONFIG", (_label, options) => {
		vi.stubEnv("VOYAGE_API_KEY", "");
		expect(() =>
			voyageEmbedder(options as Parameters<typeof voyageEmbedder>[0]),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});

	test("rejects a call without a purpose with VALIDATION", async () => {
		const embedder = voyageEmbedder({ apiKey: "k", model: "voyage-4" });
		const untyped = embedder.embed as (texts: string[]) => Promise<number[][]>;

		await expect(untyped.call(embedder, ["a"])).rejects.toMatchObject({
			code: "VALIDATION",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("rejects a malformed response with EMBEDDING", async () => {
		const embedder = voyageEmbedder({ apiKey: "k", model: "voyage-4" });
		respondJson({ data: [{ embedding: [1], index: 0 }] });

		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).rejects.toMatchObject({ code: "EMBEDDING" });
	});

	test("turns an error response into a ProviderError without its detail text", async () => {
		const body = { detail: "Provided API key is invalid." };
		respondJson(body, 401);

		const error = await rejection(
			voyageEmbedder({ apiKey: "k", model: "voyage-4" }).embed(["a"], {
				purpose: "document",
			}),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			code: "EMBEDDING",
			status: 401,
			cause: body,
			message: "Voyage embeddings request failed with status 401.",
		});
	});

	test("forwards the signal and retries a 429 through the client", async () => {
		const embedder = voyageEmbedder({
			apiKey: "k",
			model: "custom-voyage",
			dimensions: 2,
		});
		respondJson({ detail: "Rate limit exceeded." }, 429);
		respondJson(voyageResponse([[1, 2]]));
		const memory = createMemory({
			embedder,
			provider: { baseDelayMs: 1, maxDelayMs: 1, timeoutMs: 10_000 },
		});

		await memory.add({ scope: testScope("alice"), content: "Likes tea." });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(lastRequest().init.signal).toBeInstanceOf(AbortSignal);
		expect(lastBody()).toMatchObject({
			input: ["Likes tea."],
			input_type: "document",
		});
	});
});
