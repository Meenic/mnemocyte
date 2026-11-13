import { MnemocyteError, ProviderError } from "../errors.js";
import { throwIfAborted, withResilience } from "../resilience.js";
import type {
	Embedder,
	EmbeddingPurpose,
	ProviderResilienceConfig,
} from "../types.js";

interface EmbedCallOptions {
	purpose: EmbeddingPurpose;
	signal?: AbortSignal | undefined;
	resilience?: ProviderResilienceConfig | undefined;
}

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
	options: EmbedCallOptions,
): Promise<number[]> {
	const [embedding] = await embedChunk(
		embedder,
		[text],
		options,
		"Failed to embed text.",
	);
	if (!embedding) {
		throw new MnemocyteError("Embedder returned no embedding.", "EMBEDDING");
	}
	return embedding;
}

/**
 * Texts per embedder call when the embedder sets no `maxBatch`. Providers
 * cap a request by input count and by total tokens (OpenAI: 2,048 inputs and
 * 300,000 tokens), so large batches go out in several calls.
 */
export const DEFAULT_MAX_BATCH = 100;

/**
 * Embed `texts` in calls of at most `embedder.maxBatch` (default
 * {@link DEFAULT_MAX_BATCH}), one after another, so a large batch neither
 * exceeds a provider's request limits nor runs many requests at once against
 * its rate limit. Each call gets its own timeout and retries; the first
 * failure stops the rest.
 */
export async function embedMany(
	embedder: Embedder,
	texts: readonly string[],
	options: EmbedCallOptions,
): Promise<number[][]> {
	const batchSize = embedder.maxBatch ?? DEFAULT_MAX_BATCH;
	const embeddings: number[][] = [];
	for (let start = 0; start < texts.length; start += batchSize) {
		throwIfAborted(options.signal);
		embeddings.push(
			...(await embedChunk(
				embedder,
				texts.slice(start, start + batchSize),
				options,
				"Failed to embed texts.",
			)),
		);
	}
	return embeddings;
}

async function embedChunk(
	embedder: Embedder,
	texts: readonly string[],
	options: EmbedCallOptions,
	failureMessage: string,
): Promise<number[][]> {
	let embeddings: number[][];
	try {
		embeddings = await withResilience(
			(signal) =>
				embedder.embed(
					texts,
					signal === undefined
						? { purpose: options.purpose }
						: { purpose: options.purpose, signal },
				),
			{
				...(options.signal === undefined ? {} : { signal: options.signal }),
				...(options.resilience === undefined
					? {}
					: { resilience: options.resilience }),
			},
		);
	} catch (error) {
		if (
			error instanceof ProviderError ||
			(error instanceof MnemocyteError &&
				(error.code === "TIMEOUT" || error.code === "ABORTED"))
		) {
			throw error;
		}
		throw new MnemocyteError(failureMessage, "EMBEDDING", error);
	}
	if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
		throw new MnemocyteError(
			`Embedder returned ${Array.isArray(embeddings) ? embeddings.length : "no"} embeddings for ${texts.length} ${texts.length === 1 ? "text" : "texts"}.`,
			"EMBEDDING",
		);
	}
	for (const embedding of embeddings) {
		validateEmbedding(embedding, embedder.dimensions);
	}
	return embeddings;
}
