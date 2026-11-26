import type { EmbeddingPurpose } from "../../types.js";
import type { KnownModelSize } from "./http-embedder.js";

/**
 * The retrieval prefixes the Gemini API embeddings guide gives for
 * `gemini-embedding-2`, which does not take `taskType`.
 */
export const GEMINI_EMBEDDING_2_PREFIXES: Readonly<
	Record<EmbeddingPurpose, string>
> = {
	query: "task: search result | query: ",
	document: "title: none | text: ",
};

const OPENAI_3_SMALL: KnownModelSize = { dimensions: 1536, range: [1, 1536] };
const OPENAI_3_LARGE: KnownModelSize = { dimensions: 3072, range: [1, 3072] };
const GEMINI: KnownModelSize = { dimensions: 3072, range: [128, 3072] };
const COHERE_5: KnownModelSize = {
	dimensions: 2048,
	sizes: [256, 512, 768, 1024, 1536, 2048],
};
const VOYAGE_4: KnownModelSize = {
	dimensions: 1024,
	sizes: [256, 512, 1024, 2048],
};

/**
 * Default sizes of OpenRouter embedding models, keyed by OpenRouter id.
 * OpenRouter's model list has no size field, so they come from the
 * vendors' docs and the model descriptions. Models a vendor documents as
 * shortenable list the sizes it accepts; open models served by several
 * hosts are fixed, since not every host is known to honour `dimensions`.
 */
export const OPENROUTER_MODELS: ReadonlyMap<string, KnownModelSize> = new Map([
	["openai/text-embedding-3-small", OPENAI_3_SMALL],
	["openai/text-embedding-3-large", OPENAI_3_LARGE],
	["openai/text-embedding-ada-002", { dimensions: 1536 }],
	["google/gemini-embedding-001", GEMINI],
	["google/gemini-embedding-2", GEMINI],
	["cohere/embed-5-pro", COHERE_5],
	["cohere/embed-5-fast", COHERE_5],
	["mongodb/voyage-4-large", VOYAGE_4],
	["mongodb/voyage-4", VOYAGE_4],
	["mongodb/voyage-4-lite", VOYAGE_4],
	["amazon/titan-embed-text-v2", { dimensions: 1024, sizes: [256, 512, 1024] }],
	["amazon/titan-embed-text-v1", { dimensions: 1536 }],
	["mistralai/mistral-embed-2312", { dimensions: 1024 }],
	["mistralai/codestral-embed-2505", { dimensions: 1536 }],
	["perplexity/pplx-embed-v1-0.6b", { dimensions: 1024, range: [128, 1024] }],
	["perplexity/pplx-embed-v1-4b", { dimensions: 2560 }],
	["perplexity/pplx-embed-v2-context-0.6b", { dimensions: 1024 }],
	[
		"perplexity/pplx-embed-v2-context-9b",
		{ dimensions: 2048, sizes: [1024, 2048] },
	],
	["qwen/qwen3-embedding-8b", { dimensions: 4096 }],
	["qwen/qwen3-embedding-4b", { dimensions: 2560 }],
	["baai/bge-m3", { dimensions: 1024 }],
	["baai/bge-large-en-v1.5", { dimensions: 1024 }],
	["baai/bge-base-en-v1.5", { dimensions: 768 }],
	["intfloat/e5-large-v2", { dimensions: 1024 }],
	["intfloat/e5-base-v2", { dimensions: 768 }],
	["intfloat/multilingual-e5-large", { dimensions: 1024 }],
	["thenlper/gte-large", { dimensions: 1024 }],
	["thenlper/gte-base", { dimensions: 768 }],
	["sentence-transformers/all-mpnet-base-v2", { dimensions: 768 }],
	["sentence-transformers/multi-qa-mpnet-base-dot-v1", { dimensions: 768 }],
	["sentence-transformers/all-minilm-l12-v2", { dimensions: 384 }],
	["sentence-transformers/all-minilm-l6-v2", { dimensions: 384 }],
	["sentence-transformers/paraphrase-minilm-l6-v2", { dimensions: 384 }],
]);

/**
 * How an OpenRouter model is told whether a text is a query or a document:
 * `input_type` values, or text prefixes.
 */
export type OpenRouterPurposeHint =
	| { readonly inputType: Readonly<Record<EmbeddingPurpose, string>> }
	| { readonly prefix: Readonly<Record<EmbeddingPurpose, string>> };

const QUERY_DOCUMENT: Readonly<Record<EmbeddingPurpose, string>> = {
	query: "query",
	document: "document",
};

const COHERE_INPUT_TYPES: Readonly<Record<EmbeddingPurpose, string>> = {
	query: "search_query",
	document: "search_document",
};

/** Perplexity's v2 models, which fail with a 400 without `input_type`. */
export function isPerplexityV2(modelId: string): boolean {
	return modelId.startsWith("perplexity/pplx-embed-v2");
}

/**
 * The built-in purpose hint for an OpenRouter model id, if any, as the
 * vendor's own embedder sends it:
 *
 * - Perplexity's v2 models require `input_type` (its docs say to leave it
 *   out for v1);
 * - OpenRouter forwards `input_type` to Cohere and Voyage, and without it
 *   Cohere embeds every text as a document;
 * - `gemini-embedding-2` reads the purpose from a text prefix.
 */
export function openrouterPurposeHint(
	modelId: string,
): OpenRouterPurposeHint | undefined {
	if (isPerplexityV2(modelId) || modelId.startsWith("mongodb/voyage-")) {
		return { inputType: QUERY_DOCUMENT };
	}
	if (modelId.startsWith("cohere/")) {
		return { inputType: COHERE_INPUT_TYPES };
	}
	if (modelId === "google/gemini-embedding-2") {
		return { prefix: GEMINI_EMBEDDING_2_PREFIXES };
	}
	return undefined;
}

/** An OpenRouter id without its `vendor/` prefix, as `Embedder.model`. */
export function withoutVendor(modelId: string): string {
	const slash = modelId.indexOf("/");
	return slash <= 0 ? modelId : modelId.slice(slash + 1);
}
