import { MnemocyteError } from "../errors.js";
import { createHttpEmbedder, type PurposeHints } from "../http-embedder.js";
import { assertKnownKeys, RENAMED_BASE_URL } from "../options.js";
import type { Embedder } from "../types.js";

export type { PurposeHint, PurposeHints } from "../http-embedder.js";

/**
 * Options for {@link openaiCompatibleEmbedder}. `baseURL`, `model` and
 * `dimensions` are required; the API key is optional, for local servers.
 */
export interface OpenAICompatibleEmbedderOptions {
	/**
	 * Base URL of the API; requests go to `{baseURL}/embeddings`. For example
	 * `http://localhost:11434/v1` for Ollama.
	 */
	readonly baseURL: string;
	/** Embedding model id, as the server names it. */
	readonly model: string;
	/** Length of the vectors the model returns. */
	readonly dimensions: number;
	/**
	 * Sent as `Authorization: Bearer <apiKey>`. Leave it out for servers that
	 * need no key, such as a local Ollama or LM Studio.
	 */
	readonly apiKey?: string | undefined;
	/**
	 * Extra request headers, such as `{ "api-key": "…" }` for Azure.
	 * `content-type`, and `authorization` when `apiKey` is set, are set by
	 * the embedder and replace a caller's copy.
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
	/**
	 * Send `dimensions` in the request, for models that can shorten their
	 * vectors. Off by default, because servers reject it for models that
	 * cannot. Defaults to `false`.
	 */
	readonly sendDimensions?: boolean | undefined;
	/**
	 * How to mark queries and documents for models that embed them
	 * differently: a text `prefix` (nomic, E5) and/or request `body` fields
	 * (NVIDIA NIM `input_type`, Jina `task`). Nothing is sent by default.
	 */
	readonly purposes?: PurposeHints | undefined;
}

/**
 * Create an {@link Embedder} for any server with an OpenAI-shaped
 * `POST /embeddings` endpoint: OpenAI, Azure OpenAI, Mistral, Together,
 * Ollama, LM Studio, vLLM and others. Uses `fetch`; there is no SDK.
 *
 * A non-2xx response throws a `ProviderError` with the response body as its
 * `cause`; retries and `Retry-After` are handled by the client's `provider`
 * settings.
 *
 * @example
 * ```ts
 * const embedder = openaiCompatibleEmbedder({
 *   baseURL: "http://localhost:11434/v1",
 *   model: "nomic-embed-text",
 *   dimensions: 768,
 *   purposes: {
 *     query: { prefix: "search_query: " },
 *     document: { prefix: "search_document: " },
 *   },
 * });
 * ```
 */
export function openaiCompatibleEmbedder(
	options: OpenAICompatibleEmbedderOptions,
): Embedder {
	assertKnownKeys(
		"openaiCompatibleEmbedder",
		options,
		[
			"baseURL",
			"model",
			"dimensions",
			"apiKey",
			"headers",
			"fetch",
			"maxBatch",
			"sendDimensions",
			"purposes",
		],
		RENAMED_BASE_URL,
	);
	if (
		options.sendDimensions !== undefined &&
		typeof options.sendDimensions !== "boolean"
	) {
		throw new MnemocyteError({
			message: "openaiCompatibleEmbedder sendDimensions must be a boolean.",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
	return createHttpEmbedder({
		name: "openaiCompatibleEmbedder",
		provider: "Embedding provider",
		baseURL: options.baseURL,
		model: options.model,
		dimensions: options.dimensions,
		apiKey: options.apiKey,
		headers: options.headers,
		fetch: options.fetch,
		maxBatch: options.maxBatch,
		sendDimensions: options.sendDimensions === true,
		purposes: options.purposes,
	});
}
