import {
	createFetchEmbedder,
	type KnownModelSize,
	parseIndexedEmbeddings,
	resolveApiKey,
	resolveBaseURL,
	resolveBoolean,
	resolveFetch,
	resolveHeaders,
	resolveMaxBatch,
	resolveModel,
	resolveModelDimensions,
} from "../http-embedder.js";
import { assertKnownKeys, RENAMED_BASE_URL } from "../options.js";
import type { Embedder } from "../types.js";

const NAME = "voyageEmbedder";

const FLEXIBLE: KnownModelSize = {
	dimensions: 1024,
	sizes: [256, 512, 1024, 2048],
};

/**
 * Default sizes from Voyage's embeddings docs. Models that take
 * `output_dimension` list the sizes they accept; the others are fixed.
 */
const KNOWN_MODELS: ReadonlyMap<string, KnownModelSize> = new Map([
	["voyage-4-large", FLEXIBLE],
	["voyage-4", FLEXIBLE],
	["voyage-4-lite", FLEXIBLE],
	["voyage-3-large", FLEXIBLE],
	["voyage-3.5", FLEXIBLE],
	["voyage-3.5-lite", FLEXIBLE],
	["voyage-code-3", FLEXIBLE],
	["voyage-finance-2", { dimensions: 1024 }],
	["voyage-law-2", { dimensions: 1024 }],
]);

export interface VoyageEmbedderOptions {
	/** Voyage API key. Defaults to `process.env.VOYAGE_API_KEY`. */
	readonly apiKey?: string | undefined;
	/** Voyage embedding model, such as `"voyage-4"`. */
	readonly model: string;
	/**
	 * Vector length. Known models default to theirs (1024), and those that
	 * take `output_dimension` accept 256, 512, 1024 or 2048, which is then
	 * sent. Required for other models, where it is not sent.
	 */
	readonly dimensions?: number | undefined;
	/**
	 * Cut texts longer than the model's context instead of failing the
	 * request. Sent as `truncation`. Defaults to `true`.
	 */
	readonly truncate?: boolean | undefined;
	/** API base URL. Defaults to `https://api.voyageai.com/v1`. */
	readonly baseURL?: string | undefined;
	/**
	 * Extra request headers, for proxies and gateways. `authorization` and
	 * `content-type` are set by the embedder and replace a caller's copy.
	 */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/**
	 * The `fetch` every request goes through, for tests and proxies. It is
	 * called with the URL as a string and a `RequestInit` that carries the
	 * call's `signal`. Defaults to the global `fetch`.
	 */
	readonly fetch?: typeof globalThis.fetch | undefined;
	/**
	 * Most texts per request. Defaults to `100`. Voyage also caps the tokens
	 * per request (120K for `voyage-4-large`), so lower it for long texts.
	 */
	readonly maxBatch?: number | undefined;
}

/**
 * Create a Voyage AI {@link Embedder} that calls `POST /v1/embeddings` with
 * `fetch`; there is no SDK. Queries are sent with `input_type: "query"` and
 * stored memories with `input_type: "document"`.
 *
 * @example
 * ```ts
 * const embedder = voyageEmbedder({ model: "voyage-4" });
 * ```
 */
export function voyageEmbedder(options: VoyageEmbedderOptions): Embedder {
	assertKnownKeys(
		"voyageEmbedder",
		options,
		[
			"apiKey",
			"model",
			"dimensions",
			"truncate",
			"baseURL",
			"headers",
			"fetch",
			"maxBatch",
		],
		RENAMED_BASE_URL,
	);
	const apiKey = resolveApiKey(options.apiKey, "VOYAGE_API_KEY", NAME);
	const headers = resolveHeaders(options.headers, NAME);
	const customFetch = resolveFetch(options.fetch, NAME);
	const model = resolveModel(options.model, NAME);
	const size = resolveModelDimensions({
		name: NAME,
		model,
		dimensions: options.dimensions,
		known: KNOWN_MODELS,
	});
	const truncation = resolveBoolean(options.truncate, "truncate", NAME, true);
	const baseURL = resolveBaseURL(
		options.baseURL ?? "https://api.voyageai.com/v1",
		NAME,
	);
	return createFetchEmbedder({
		name: NAME,
		provider: "Voyage",
		model,
		dimensions: size.dimensions,
		maxBatch: resolveMaxBatch(options.maxBatch, NAME, undefined),
		url: `${baseURL}/embeddings`,
		headers: { ...headers, authorization: `Bearer ${apiKey}` },
		fetch: customFetch,
		buildBody(texts, purpose) {
			return {
				model,
				input: [...texts],
				input_type: purpose,
				truncation,
				...(size.send ? { output_dimension: size.dimensions } : {}),
			};
		},
		parseResponse(body, expectedCount) {
			return parseIndexedEmbeddings(body, expectedCount, "Voyage");
		},
	});
}
