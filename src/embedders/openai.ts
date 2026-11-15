import { MnemocyteError } from "../errors.js";
import { createHttpEmbedder, resolveApiKey } from "../http-embedder.js";
import { assertKnownKeys, RENAMED_BASE_URL } from "../options.js";
import type { Embedder } from "../types.js";

const KNOWN_MODEL_DIMENSIONS: Record<string, number> = {
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"text-embedding-ada-002": 1536,
};

const CONFIGURABLE_DIMENSION_MODELS = new Set([
	"text-embedding-3-small",
	"text-embedding-3-large",
]);

export interface OpenAIEmbedderOptions {
	/**
	 * OpenAI API key. Defaults to `process.env.OPENAI_API_KEY`.
	 */
	readonly apiKey?: string | undefined;
	/**
	 * OpenAI embedding model name.
	 */
	readonly model: string;
	/**
	 * Output dimensions. Required for unknown/future model names and accepted
	 * only for OpenAI models that support configurable dimensions.
	 */
	readonly dimensions?: number | undefined;
	/**
	 * Override the OpenAI API base URL; defaults to
	 * `https://api.openai.com/v1`. For other providers, use
	 * `openaiCompatibleEmbedder`.
	 */
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
	/** Most texts per request. Defaults to `100`. */
	readonly maxBatch?: number | undefined;
}

function assertDimensions(dimensions: number): void {
	if (!Number.isInteger(dimensions) || dimensions < 1) {
		throw new MnemocyteError({
			message: "openaiEmbedder dimensions must be a positive integer.",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
}

function resolveDimensions(options: OpenAIEmbedderOptions): {
	embedderDimensions: number;
	requestDimensions?: number;
} {
	const defaultDimensions = KNOWN_MODEL_DIMENSIONS[options.model];
	if (defaultDimensions === undefined) {
		if (options.dimensions === undefined) {
			throw new MnemocyteError({
				message: `openaiEmbedder requires dimensions for unknown model "${options.model}".`,
				code: "CONFIG",
				reason: "INVALID_OPTION",
			});
		}
		assertDimensions(options.dimensions);
		return {
			embedderDimensions: options.dimensions,
			requestDimensions: options.dimensions,
		};
	}

	if (
		options.dimensions !== undefined &&
		!CONFIGURABLE_DIMENSION_MODELS.has(options.model)
	) {
		throw new MnemocyteError({
			message: `openaiEmbedder does not support a dimensions override for "${options.model}".`,
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}

	if (options.dimensions !== undefined) {
		assertDimensions(options.dimensions);
		return {
			embedderDimensions: options.dimensions,
			requestDimensions: options.dimensions,
		};
	}

	return { embedderDimensions: defaultDimensions };
}

/**
 * Create an OpenAI-backed {@link Embedder}. This adapter uses `fetch`
 * directly so provider SDKs never become part of Mnemocyte's dependency graph.
 * It is `openaiCompatibleEmbedder` with OpenAI's base URL, `OPENAI_API_KEY`
 * and known model sizes.
 */
export function openaiEmbedder(options: OpenAIEmbedderOptions): Embedder {
	assertKnownKeys(
		"openaiEmbedder",
		options,
		[
			"apiKey",
			"model",
			"dimensions",
			"baseURL",
			"headers",
			"fetch",
			"maxBatch",
		],
		RENAMED_BASE_URL,
	);
	const apiKey = resolveApiKey(
		options.apiKey,
		"OPENAI_API_KEY",
		"openaiEmbedder",
	);
	const { embedderDimensions, requestDimensions } = resolveDimensions(options);
	return createHttpEmbedder({
		name: "openaiEmbedder",
		provider: "OpenAI",
		baseURL: options.baseURL ?? "https://api.openai.com/v1",
		model: options.model,
		dimensions: embedderDimensions,
		apiKey,
		headers: options.headers,
		fetch: options.fetch,
		maxBatch: options.maxBatch,
		sendDimensions: requestDimensions !== undefined,
		purposes: undefined,
	});
}
