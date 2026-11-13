import { MnemocyteError } from "../errors.js";
import {
	assertVectorList,
	createFetchEmbedder,
	isRecord,
	type KnownModelSize,
	resolveApiKey,
	resolveBaseUrl,
	resolveBoolean,
	resolveMaxBatch,
	resolveModel,
	resolveModelDimensions,
} from "../http-embedder.js";
import type { Embedder } from "../types.js";

const NAME = "cohereEmbedder";

/** Cohere's limit on `texts` per `/v2/embed` call. */
const COHERE_MAX_BATCH = 96;

/**
 * Default sizes from Cohere's Embed models table. `embed-v4.0` and newer
 * take `output_dimension`; the v3 models are fixed.
 */
const KNOWN_MODELS: ReadonlyMap<string, KnownModelSize> = new Map([
	["embed-v4.0", { dimensions: 1536, sizes: [256, 512, 1024, 1536] }],
	[
		"embed-v5.0-pro",
		{ dimensions: 2048, sizes: [256, 512, 768, 1024, 1536, 2048] },
	],
	[
		"embed-v5.0-fast",
		{ dimensions: 2048, sizes: [256, 512, 768, 1024, 1536, 2048] },
	],
	["embed-english-v3.0", { dimensions: 1024 }],
	["embed-multilingual-v3.0", { dimensions: 1024 }],
	["embed-english-light-v3.0", { dimensions: 384 }],
	["embed-multilingual-light-v3.0", { dimensions: 384 }],
]);

export interface CohereEmbedderOptions {
	/** Cohere API key. Defaults to `process.env.COHERE_API_KEY`. */
	readonly apiKey?: string;
	/** Cohere embedding model, such as `"embed-v4.0"`. */
	readonly model: string;
	/**
	 * Vector length. Known models default to theirs; `embed-v4.0` and the
	 * v5 models accept the sizes Cohere lists, which is then sent as
	 * `output_dimension`. Required for other models, where it is not sent.
	 */
	readonly dimensions?: number;
	/**
	 * Cut the end of texts longer than the model's context instead of
	 * failing the request: `truncate: "END"`, or `"NONE"` when `false`.
	 * Defaults to `true`.
	 */
	readonly truncate?: boolean;
	/** API base URL. Defaults to `https://api.cohere.com/v2`. */
	readonly baseUrl?: string;
	/** Most texts per request, at most 96 (Cohere's limit). Defaults to `96`. */
	readonly maxBatch?: number;
}

/**
 * Create a Cohere {@link Embedder} that calls `POST /v2/embed` with
 * `fetch`; there is no SDK. Queries are sent with
 * `input_type: "search_query"` and stored memories with
 * `"search_document"`.
 *
 * @example
 * ```ts
 * const embedder = cohereEmbedder({ model: "embed-v4.0" });
 * ```
 */
export function cohereEmbedder(options: CohereEmbedderOptions): Embedder {
	const apiKey = resolveApiKey(options.apiKey, "COHERE_API_KEY", NAME);
	const model = resolveModel(options.model, NAME);
	const size = resolveModelDimensions({
		name: NAME,
		model,
		dimensions: options.dimensions,
		known: KNOWN_MODELS,
	});
	const truncate = resolveBoolean(options.truncate, "truncate", NAME, true);
	const baseUrl = resolveBaseUrl(
		options.baseUrl ?? "https://api.cohere.com/v2",
		NAME,
	);
	return createFetchEmbedder({
		name: NAME,
		provider: "Cohere",
		model,
		dimensions: size.dimensions,
		maxBatch: resolveMaxBatch(
			options.maxBatch,
			NAME,
			COHERE_MAX_BATCH,
			COHERE_MAX_BATCH,
		),
		url: `${baseUrl}/embed`,
		headers: { authorization: `Bearer ${apiKey}` },
		buildBody(texts, purpose) {
			return {
				model,
				texts: [...texts],
				input_type: purpose === "query" ? "search_query" : "search_document",
				embedding_types: ["float"],
				truncate: truncate ? "END" : "NONE",
				...(size.send ? { output_dimension: size.dimensions } : {}),
			};
		},
		parseResponse(body, expectedCount) {
			if (!isRecord(body) || !isRecord(body.embeddings)) {
				throw new MnemocyteError(
					"Cohere returned malformed embedding response data.",
					"EMBEDDING",
				);
			}
			return assertVectorList(body.embeddings.float, expectedCount, "Cohere");
		},
	});
}
