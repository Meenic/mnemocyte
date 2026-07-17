import { MnemocyteError } from "../errors.js";
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
	 * Override the OpenAI API base URL. Intended for tests and compatible
	 * deployments; defaults to `https://api.openai.com/v1`.
	 */
	readonly baseUrl?: string;
}

interface OpenAIEmbeddingItem {
	readonly embedding: number[];
	readonly index: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateEmbeddingResponse(
	body: unknown,
	expectedCount: number,
): OpenAIEmbeddingItem[] {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new MnemocyteError(
			"OpenAI returned malformed embedding response data.",
			"EMBEDDING",
		);
	}
	if (body.data.length !== expectedCount) {
		throw new MnemocyteError(
			"OpenAI returned an unexpected number of embeddings.",
			"EMBEDDING",
		);
	}

	const indices = new Set<number>();
	const items: OpenAIEmbeddingItem[] = [];
	for (const item of body.data) {
		if (!isRecord(item)) {
			throw new MnemocyteError(
				"OpenAI returned a malformed embedding item.",
				"EMBEDDING",
			);
		}
		const { embedding, index } = item;
		if (
			typeof index !== "number" ||
			!Number.isInteger(index) ||
			index < 0 ||
			index >= expectedCount
		) {
			throw new MnemocyteError(
				"OpenAI returned an embedding with an invalid index.",
				"EMBEDDING",
			);
		}
		if (indices.has(index)) {
			throw new MnemocyteError(
				"OpenAI returned a duplicate embedding index.",
				"EMBEDDING",
			);
		}
		if (!Array.isArray(embedding)) {
			throw new MnemocyteError(
				"OpenAI returned an embedding that is not an array.",
				"EMBEDDING",
			);
		}
		indices.add(index);
		items.push({ embedding: embedding as number[], index });
	}
	return items;
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
 */
export function openaiEmbedder(options: OpenAIEmbedderOptions): Embedder {
	const apiKey = resolveApiKey(options.apiKey);
	const { embedderDimensions, requestDimensions } = resolveDimensions(options);
	const baseUrl = options.baseUrl ?? "https://api.openai.com/v1";

	return {
		model: options.model,
		dimensions: embedderDimensions,
		async embed(texts, embedOptions) {
			const response = await fetch(`${baseUrl}/embeddings`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					model: options.model,
					input: [...texts],
					encoding_format: "float",
					...(requestDimensions === undefined
						? {}
						: { dimensions: requestDimensions }),
				}),
				...(embedOptions?.signal === undefined
					? {}
					: { signal: embedOptions.signal }),
			});

			if (!response.ok) {
				throw Object.assign(
					new Error(
						`OpenAI embeddings request failed with status ${response.status}.`,
					),
					{ status: response.status },
				);
			}

			const items = validateEmbeddingResponse(
				await response.json(),
				texts.length,
			);
			return items
				.sort((left, right) => left.index - right.index)
				.map((item) => item.embedding);
		},
	};
}
