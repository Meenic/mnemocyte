import { createMemory, type Embedder, ProviderError } from "mnemocyte";
import { openaiCompatibleEmbedder } from "mnemocyte/embedders/openai-compatible";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	MAX_ERROR_BODY_LENGTH,
	parseRetryAfterMs,
} from "../../src/http-embedder.js";
import { expectMnemocyteError, testScope } from "../helpers.js";

const BASE = {
	baseUrl: "http://localhost:11434/v1/",
	model: "nomic-embed-text",
	dimensions: 2,
} as const;

describe("openaiCompatibleEmbedder", () => {
	const originalFetch = globalThis.fetch;
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.stubGlobal("fetch", originalFetch);
	});

	function okResponse(count: number): Response {
		return new Response(
			JSON.stringify({
				data: Array.from({ length: count }, (_, index) => ({
					index,
					embedding: [1, index + 1],
				})),
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	}

	function lastRequest(): { url: string; init: RequestInit } {
		const call = fetchMock.mock.calls.at(-1);
		if (!call) {
			throw new Error("fetch was not called");
		}
		return { url: String(call[0]), init: call[1] ?? {} };
	}

	function lastBody(): Record<string, unknown> {
		return JSON.parse(String(lastRequest().init.body));
	}

	async function rejection(promise: Promise<unknown>): Promise<unknown> {
		return promise.then(
			() => {
				throw new Error("Expected a rejection.");
			},
			(error: unknown) => error,
		);
	}

	test("sends a plain request without a key, dimensions or hints", async () => {
		fetchMock.mockResolvedValueOnce(okResponse(2));
		const embedder = openaiCompatibleEmbedder(BASE);

		expect(embedder).toMatchObject({
			model: "nomic-embed-text",
			dimensions: 2,
		});
		expect(embedder.maxBatch).toBeUndefined();
		await expect(
			embedder.embed(["a", "b"], { purpose: "document" }),
		).resolves.toEqual([
			[1, 1],
			[1, 2],
		]);

		const { url, init } = lastRequest();
		expect(url).toBe("http://localhost:11434/v1/embeddings");
		expect(init.headers).toEqual({ "content-type": "application/json" });
		expect(init.body).toBe(
			JSON.stringify({
				model: "nomic-embed-text",
				input: ["a", "b"],
				encoding_format: "float",
			}),
		);
	});

	test("sends the API key, extra headers, maxBatch and dimensions on request", async () => {
		fetchMock.mockResolvedValueOnce(okResponse(1));
		const embedder = openaiCompatibleEmbedder({
			...BASE,
			apiKey: "test-key",
			headers: { "X-Team": "memory" },
			maxBatch: 32,
			sendDimensions: true,
		});

		expect(embedder.maxBatch).toBe(32);
		await embedder.embed(["a"], { purpose: "query" });

		expect(lastRequest().init.headers).toEqual({
			"x-team": "memory",
			authorization: "Bearer test-key",
			"content-type": "application/json",
		});
		expect(lastBody()).toMatchObject({ dimensions: 2 });
	});

	test("applies each purpose's prefix and body fields", async () => {
		const embedder = openaiCompatibleEmbedder({
			...BASE,
			purposes: {
				query: { prefix: "search_query: ", body: { input_type: "query" } },
				document: {
					prefix: "search_document: ",
					body: { input_type: "passage" },
				},
			},
		});

		fetchMock.mockResolvedValueOnce(okResponse(1));
		await embedder.embed(["where?"], { purpose: "query" });
		expect(lastBody()).toEqual({
			input_type: "query",
			model: "nomic-embed-text",
			input: ["search_query: where?"],
			encoding_format: "float",
		});

		fetchMock.mockResolvedValueOnce(okResponse(2));
		await embedder.embed(["one", "two"], { purpose: "document" });
		expect(lastBody()).toEqual({
			input_type: "passage",
			model: "nomic-embed-text",
			input: ["search_document: one", "search_document: two"],
			encoding_format: "float",
		});
	});

	test("snapshots purpose hints and keeps stored content unprefixed", async () => {
		const body = { task: "retrieval.passage" };
		const embedder = openaiCompatibleEmbedder({
			...BASE,
			purposes: { document: { prefix: "passage: ", body } },
		});
		body.task = "changed";

		fetchMock.mockResolvedValueOnce(okResponse(1));
		const memory = createMemory({ embedder });
		const added = await memory.add({
			scope: testScope("alice"),
			content: "Likes tea.",
		});

		expect(added.content).toBe("Likes tea.");
		expect(lastBody()).toMatchObject({
			task: "retrieval.passage",
			input: ["passage: Likes tea."],
		});
	});

	test.each([
		["a missing baseUrl", { ...BASE, baseUrl: "" }],
		["a relative baseUrl", { ...BASE, baseUrl: "/v1" }],
		["a missing model", { ...BASE, model: " " }],
		["zero dimensions", { ...BASE, dimensions: 0 }],
		["a fractional maxBatch", { ...BASE, maxBatch: 1.5 }],
		["an empty apiKey", { ...BASE, apiKey: "" }],
		["a non-string header", { ...BASE, headers: { "x-a": 1 } }],
		["a non-boolean sendDimensions", { ...BASE, sendDimensions: "yes" }],
		["non-object purposes", { ...BASE, purposes: "query" }],
		["a non-string prefix", { ...BASE, purposes: { query: { prefix: 1 } } }],
		[
			"a reserved body field",
			{ ...BASE, purposes: { query: { body: { input: "x" } } } },
		],
		[
			"a dimensions body field",
			{ ...BASE, purposes: { document: { body: { dimensions: 2 } } } },
		],
		[
			"a body that is not JSON",
			{ ...BASE, purposes: { query: { body: { n: 1n } } } },
		],
	])("rejects %s with CONFIG", (_label, options) => {
		expect(() =>
			openaiCompatibleEmbedder(
				options as unknown as Parameters<typeof openaiCompatibleEmbedder>[0],
			),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});

	test("rejects a call without a purpose with VALIDATION", async () => {
		const embedder = openaiCompatibleEmbedder(BASE);
		const untyped = embedder.embed as (texts: string[]) => Promise<number[][]>;

		await expect(untyped.call(embedder, ["a"])).rejects.toMatchObject({
			code: "VALIDATION",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	test("keeps a JSON error body as the cause and labels it without its message", async () => {
		const body = {
			object: "error",
			message: "secret-ish detail",
			type: "BadRequestError",
			param: null,
			code: 400,
		};
		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(body), { status: 400 }),
		);

		const error = await rejection(
			openaiCompatibleEmbedder(BASE).embed(["a"], { purpose: "document" }),
		);

		expect(error).toBeInstanceOf(ProviderError);
		expect(error).toMatchObject({
			status: 400,
			retryAfterMs: undefined,
			cause: body,
			message:
				"Embedding provider embeddings request failed with status 400 (BadRequestError).",
		});
	});

	test("keeps a text body as the cause, cut to the length limit", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response("upstream unavailable", { status: 502 }),
		);
		const short = await rejection(
			openaiCompatibleEmbedder(BASE).embed(["a"], { purpose: "document" }),
		);
		expect(short).toMatchObject({ status: 502, cause: "upstream unavailable" });

		fetchMock.mockResolvedValueOnce(
			new Response("x".repeat(MAX_ERROR_BODY_LENGTH + 10), { status: 500 }),
		);
		const long = await rejection(
			openaiCompatibleEmbedder(BASE).embed(["a"], { purpose: "document" }),
		);
		expect((long as ProviderError).cause).toBe(
			"x".repeat(MAX_ERROR_BODY_LENGTH),
		);

		fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
		const empty = await rejection(
			openaiCompatibleEmbedder(BASE).embed(["a"], { purpose: "document" }),
		);
		expect(empty).toMatchObject({ status: 503, cause: undefined });
	});

	test("rejects a successful response that is not JSON with EMBEDDING", async () => {
		fetchMock.mockResolvedValueOnce(new Response("<html>", { status: 200 }));

		await expect(
			openaiCompatibleEmbedder(BASE).embed(["a"], { purpose: "document" }),
		).rejects.toMatchObject({ code: "EMBEDDING" });
	});

	test("retries a 503 after its Retry-After and passes a final ProviderError through", async () => {
		fetchMock
			.mockResolvedValueOnce(
				new Response('{"error":{"code":"overloaded"}}', {
					status: 503,
					headers: { "retry-after": "0" },
				}),
			)
			.mockResolvedValueOnce(okResponse(1));
		const memory = createMemory({
			embedder: openaiCompatibleEmbedder(BASE),
			provider: { baseDelayMs: 60_000, maxDelayMs: 60_000 },
		});

		const started = Date.now();
		await memory.add({ scope: testScope("alice"), content: "x" });
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// Retry-After: 0 replaces the one-minute backoff.
		expect(Date.now() - started).toBeLessThan(5_000);

		fetchMock.mockResolvedValueOnce(
			new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }),
		);
		const error = await expectMnemocyteError(
			memory.add({ scope: testScope("alice"), content: "y" }),
			"EMBEDDING",
		);
		expect(error).toBeInstanceOf(ProviderError);
		expect(error.cause).toEqual({ error: { code: "invalid_api_key" } });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

describe("parseRetryAfterMs", () => {
	const now = Date.parse("2026-11-13T12:00:00Z");

	test.each([
		["delay-seconds", { "retry-after": "3" }, 3000],
		["fractional seconds", { "retry-after": "1.5" }, 1500],
		[
			"an HTTP-date",
			{ "retry-after": "Fri, 13 Nov 2026 12:00:10 GMT" },
			10_000,
		],
		["a past HTTP-date", { "retry-after": "Fri, 13 Nov 2026 11:00:00 GMT" }, 0],
		[
			"retry-after-ms first",
			{ "retry-after-ms": "250", "retry-after": "9" },
			250,
		],
		[
			"an invalid retry-after-ms",
			{ "retry-after-ms": "soon", "retry-after": "2" },
			2000,
		],
		["a garbage value", { "retry-after": "later" }, undefined],
		["a negative value", { "retry-after": "-5" }, undefined],
		["no header", {}, undefined],
	])("reads %s", (_label, headers, expected) => {
		expect(parseRetryAfterMs(new Headers(headers), now)).toBe(expected);
	});
});

// Type-level check: an embedder that ignores options still satisfies the
// contract.
const minimal: Embedder = {
	model: "m",
	dimensions: 1,
	async embed(texts) {
		return texts.map(() => [1]);
	},
};
void minimal;
