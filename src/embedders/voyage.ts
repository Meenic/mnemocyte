import {
	createFetchEmbedder,
	type KnownModelSize,
	parseIndexedEmbeddings,
	resolveApiKey,
	resolveBaseUrl,
	resolveBoolean,
	resolveMaxBatch,
	resolveModel,
	resolveModelDimensions,
} from "../http-embedder.js";
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
	readonly apiKey?: string;
	/** Voyage embedding model, such as `"voyage-4"`. */
	readonly model: string;
	/**
	 * Vector length. Known models default to theirs (1024), and those that
	 * take `output_dimension` accept 256, 512, 1024 or 2048, which is then
	 * sent. Required for other models, where it is not sent.
	 */
	readonly dimensions?: number;
	/**
	 * Cut texts longer than the model's context instead of failing the
	 * request. Sent as `truncation`. Defaults to `true`.
	 */
	readonly truncate?: boolean;
	/** API base URL. Defaults to `https://api.voyageai.com/v1`. */
	readonly baseUrl?: string;
	/**
	 * Most texts per request. Defaults to `100`. Voyage also caps the tokens
	 * per request (120K for `voyage-4-large`), so lower it for long texts.
	 */
	readonly maxBatch?: number;
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
	const apiKey = resolveApiKey(options.apiKey, "VOYAGE_API_KEY", NAME);
	const model = resolveModel(options.model, NAME);
	const size = resolveModelDimensions({
		name: NAME,
		model,
		dimensions: options.dimensions,
		known: KNOWN_MODELS,
	});
	const truncation = resolveBoolean(options.truncate, "truncate", NAME, true);
	const baseUrl = resolveBaseUrl(
		options.baseUrl ?? "https://api.voyageai.com/v1",
		NAME,
	);
	return createFetchEmbedder({
		name: NAME,
		provider: "Voyage",
		model,
		dimensions: size.dimensions,
		maxBatch: resolveMaxBatch(options.maxBatch, NAME, undefined),
		url: `${baseUrl}/embeddings`,
		headers: { authorization: `Bearer ${apiKey}` },
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
