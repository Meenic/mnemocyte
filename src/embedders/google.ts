import { MnemocyteError } from "../errors.js";
import {
	assertVectorList,
	createFetchEmbedder,
	isRecord,
	type KnownModelSize,
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
import type { Embedder, EmbeddingPurpose } from "../types.js";

const NAME = "googleEmbedder";

/** How a Gemini model is told whether a text is a query or a document. */
type PurposeStyle = "taskType" | "prefix";

interface GoogleModel extends KnownModelSize {
	readonly purposeStyle: PurposeStyle;
}

/**
 * Default sizes from the Gemini API embeddings guide: 3072, and any
 * `outputDimensionality` from 128 up. `gemini-embedding-2` does not take
 * `taskType` and reads the purpose from a text prefix instead.
 */
const KNOWN_MODELS: ReadonlyMap<string, GoogleModel> = new Map([
	[
		"gemini-embedding-001",
		{ dimensions: 3072, range: [128, 3072], purposeStyle: "taskType" },
	],
	[
		"gemini-embedding-2",
		{ dimensions: 3072, range: [128, 3072], purposeStyle: "prefix" },
	],
]);

const TASK_TYPES: Record<EmbeddingPurpose, string> = {
	query: "RETRIEVAL_QUERY",
	document: "RETRIEVAL_DOCUMENT",
};

/** The retrieval prefixes the guide gives for `gemini-embedding-2`. */
const PREFIXES: Record<EmbeddingPurpose, string> = {
	query: "task: search result | query: ",
	document: "title: none | text: ",
};

/**
 * Options for {@link googleEmbedder}. Only `model` is required; a model it
 * does not know also needs `dimensions`.
 */
export interface GoogleEmbedderOptions {
	/** Gemini API key. Defaults to `process.env.GEMINI_API_KEY`. */
	readonly apiKey?: string | undefined;
	/**
	 * Gemini embedding model, such as `"gemini-embedding-001"`. A `models/`
	 * prefix is accepted and left out of the embedder's `model`.
	 */
	readonly model: string;
	/**
	 * Vector length. Known models default to 3072 and accept 128 to 3072,
	 * which is then sent as `outputDimensionality`. Required for other
	 * models, where it is not sent.
	 */
	readonly dimensions?: number | undefined;
	/**
	 * Cut texts longer than the model's context instead of failing the
	 * request. Sent as `autoTruncate`. Defaults to `true`.
	 */
	readonly truncate?: boolean | undefined;
	/**
	 * API base URL. Defaults to
	 * `https://generativelanguage.googleapis.com/v1beta`.
	 */
	readonly baseURL?: string | undefined;
	/**
	 * Extra request headers, for proxies and gateways. `x-goog-api-key` and
	 * `content-type` are set by the embedder and replace a caller's copy;
	 * an `authorization` header is sent as given.
	 */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	/**
	 * The `fetch` every request goes through, for tests and proxies. It is
	 * called with the URL as a string and a `RequestInit` that carries the
	 * call's `signal`. Defaults to the global `fetch`.
	 */
	readonly fetch?: typeof globalThis.fetch | undefined;
	/** Most texts per request. Defaults to `100`. */
	readonly maxBatch?: number | undefined;
}

/**
 * Create a Gemini API (Google AI Studio) {@link Embedder} that calls
 * `POST /models/{model}:batchEmbedContents` with `fetch`; there is no SDK.
 * Vertex AI is not supported.
 *
 * Queries and stored memories are marked with `taskType`
 * `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`, or for `gemini-embedding-2`
 * with the text prefixes Google documents for it.
 *
 * @example
 * ```ts
 * const embedder = googleEmbedder({
 *   model: "gemini-embedding-001",
 *   dimensions: 768,
 * });
 * ```
 */
export function googleEmbedder(options: GoogleEmbedderOptions): Embedder {
	assertKnownKeys(
		"googleEmbedder",
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
	const apiKey = resolveApiKey(options.apiKey, "GEMINI_API_KEY", NAME);
	const headers = resolveHeaders(options.headers, NAME);
	const customFetch = resolveFetch(options.fetch, NAME);
	const given = resolveModel(options.model, NAME);
	const model = given.startsWith("models/")
		? resolveModel(given.slice("models/".length), NAME)
		: given;
	const size = resolveModelDimensions({
		name: NAME,
		model,
		dimensions: options.dimensions,
		known: KNOWN_MODELS,
	});
	const purposeStyle: PurposeStyle =
		KNOWN_MODELS.get(model)?.purposeStyle ?? "taskType";
	const autoTruncate = resolveBoolean(options.truncate, "truncate", NAME, true);
	const baseURL = resolveBaseURL(
		options.baseURL ?? "https://generativelanguage.googleapis.com/v1beta",
		NAME,
	);
	const resource = `models/${model}`;
	return createFetchEmbedder({
		name: NAME,
		provider: "Google",
		model,
		dimensions: size.dimensions,
		maxBatch: resolveMaxBatch(options.maxBatch, NAME, 100),
		url: `${baseURL}/models/${encodeURIComponent(model)}:batchEmbedContents`,
		headers: { ...headers, "x-goog-api-key": apiKey },
		fetch: customFetch,
		buildBody(texts, purpose) {
			const prefix = purposeStyle === "prefix" ? PREFIXES[purpose] : "";
			const config = {
				...(purposeStyle === "taskType"
					? { taskType: TASK_TYPES[purpose] }
					: {}),
				...(size.send ? { outputDimensionality: size.dimensions } : {}),
				autoTruncate,
			};
			return {
				requests: texts.map((text) => ({
					model: resource,
					content: { parts: [{ text: `${prefix}${text}` }] },
					embedContentConfig: config,
				})),
			};
		},
		parseResponse(body, expectedCount) {
			if (!isRecord(body) || !Array.isArray(body.embeddings)) {
				throw new MnemocyteError({
					message: "Google returned malformed embedding response data.",
					code: "EMBEDDING",
				});
			}
			return assertVectorList(
				body.embeddings.map((item: unknown) =>
					isRecord(item) ? item.values : undefined,
				),
				expectedCount,
				"Google",
			);
		},
	});
}
