import { MnemocyteError } from "../errors.js";
import { throwIfAborted, withResilience } from "../resilience.js";
import type { Embedder, ProviderResilienceConfig } from "../types.js";

function validateEmbedding(
	embedding: readonly number[],
	dimensions: number,
): void {
	if (embedding.length !== dimensions) {
		throw new MnemocyteError(
			"Embedder returned an embedding with unexpected dimensions.",
			"EMBEDDING",
		);
	}
	if (embedding.some((component) => !Number.isFinite(component))) {
		throw new MnemocyteError(
			"Embedder returned an embedding with non-finite values.",
			"EMBEDDING",
		);
	}
	if (embedding.every((component) => component === 0)) {
		throw new MnemocyteError(
			"Embedder returned an embedding with zero norm.",
			"EMBEDDING",
		);
	}
}

export async function embedOne(
	embedder: Embedder,
	text: string,
	options: {
		signal?: AbortSignal;
		resilience?: ProviderResilienceConfig;
	} = {},
): Promise<number[]> {
	let embeddings: number[][];
	try {
		embeddings = await withResilience(
			(signal) =>
				signal === undefined
					? embedder.embed([text])
					: embedder.embed([text], { signal }),
			{
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.resilience === undefined
					? {}
					: { resilience: options.resilience }),
			},
		);
	} catch (error) {
		if (
			error instanceof MnemocyteError &&
			(error.code === "TIMEOUT" || error.code === "ABORTED")
		) {
			throw error;
		}
		throw new MnemocyteError("Failed to embed text.", "EMBEDDING", error);
	}
	const embedding = embeddings[0];
	if (!embedding) {
		throw new MnemocyteError("Embedder returned no embedding.", "EMBEDDING");
	}
	validateEmbedding(embedding, embedder.dimensions);
	return embedding;
}

/**
 * Texts per embedder call. Providers cap a request by input count and by
 * total tokens (OpenAI: 2,048 inputs and 300,000 tokens), so large batches go
 * out in several calls.
 */
export const EMBED_CHUNK_SIZE = 100;

/**
 * Embed `texts` in calls of at most {@link EMBED_CHUNK_SIZE}, one after
 * another, so a large batch neither exceeds a provider's request limits nor
 * runs many requests at once against its rate limit. Each call gets its own
 * timeout and retries; the first failure stops the rest.
 */
export async function embedMany(
	embedder: Embedder,
	texts: readonly string[],
	options: {
		signal?: AbortSignal;
		resilience?: ProviderResilienceConfig;
	} = {},
): Promise<number[][]> {
	const embeddings: number[][] = [];
	for (let start = 0; start < texts.length; start += EMBED_CHUNK_SIZE) {
		throwIfAborted(options.signal);
		embeddings.push(
			...(await embedChunk(
				embedder,
				texts.slice(start, start + EMBED_CHUNK_SIZE),
				options,
			)),
		);
	}
	return embeddings;
}

async function embedChunk(
	embedder: Embedder,
	texts: readonly string[],
	options: {
		signal?: AbortSignal;
		resilience?: ProviderResilienceConfig;
	},
): Promise<number[][]> {
	let embeddings: number[][];
	try {
		embeddings = await withResilience(
			(signal) =>
				signal === undefined
					? embedder.embed(texts)
					: embedder.embed(texts, { signal }),
			{
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.resilience === undefined
					? {}
					: { resilience: options.resilience }),
			},
		);
	} catch (error) {
		if (
			error instanceof MnemocyteError &&
			(error.code === "TIMEOUT" || error.code === "ABORTED")
		) {
			throw error;
		}
		throw new MnemocyteError("Failed to embed texts.", "EMBEDDING", error);
	}
	if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
		throw new MnemocyteError(
			`Embedder returned ${Array.isArray(embeddings) ? embeddings.length : "no"} embeddings for ${texts.length} texts.`,
			"EMBEDDING",
		);
	}
	for (const embedding of embeddings) {
		validateEmbedding(embedding, embedder.dimensions);
	}
	return embeddings;
}
