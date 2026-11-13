import { MnemocyteError } from "../errors.js";
import { createHttpEmbedder } from "../http-embedder.js";
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
	readonly apiKey?: string;
	/**
	 * OpenAI embedding model name.
	 */
	readonly model: string;
	/**
	 * Output dimensions. Required for unknown/future model names and accepted
	 * only for OpenAI models that support configurable dimensions.
	 */
	readonly dimensions?: number;
	/**
	 * Override the OpenAI API base URL; defaults to
	 * `https://api.openai.com/v1`. For other providers, use
	 * `openaiCompatibleEmbedder`.
	 */
	readonly baseUrl?: string;
	/** Most texts per request. Defaults to `100`. */
	readonly maxBatch?: number;
}

function assertDimensions(dimensions: number): void {
	if (!Number.isInteger(dimensions) || dimensions < 1) {
		throw new MnemocyteError(
			"openaiEmbedder dimensions must be a positive integer.",
			"CONFIG",
		);
	}
}

function resolveApiKey(apiKey: string | undefined): string {
	const resolved = apiKey ?? process.env.OPENAI_API_KEY;
	if (!resolved || resolved.trim().length === 0) {
		throw new MnemocyteError(
			"openaiEmbedder requires an API key. Pass apiKey or set OPENAI_API_KEY.",
			"CONFIG",
		);
	}
	return resolved;
}

function resolveDimensions(options: OpenAIEmbedderOptions): {
	embedderDimensions: number;
	requestDimensions?: number;
} {
	const defaultDimensions = KNOWN_MODEL_DIMENSIONS[options.model];
	if (defaultDimensions === undefined) {
		if (options.dimensions === undefined) {
			throw new MnemocyteError(
				`openaiEmbedder requires dimensions for unknown model "${options.model}".`,
				"CONFIG",
			);
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
		throw new MnemocyteError(
			`openaiEmbedder does not support a dimensions override for "${options.model}".`,
			"CONFIG",
		);
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
	const apiKey = resolveApiKey(options.apiKey);
	const { embedderDimensions, requestDimensions } = resolveDimensions(options);
	return createHttpEmbedder({
		name: "openaiEmbedder",
		provider: "OpenAI",
		baseUrl: options.baseUrl ?? "https://api.openai.com/v1",
		model: options.model,
		dimensions: embedderDimensions,
		apiKey,
		headers: undefined,
		maxBatch: options.maxBatch,
		sendDimensions: requestDimensions !== undefined,
		purposes: undefined,
	});
}
