import { MnemocyteError } from "../errors.js";
import { withResilience } from "../resilience.js";
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

export async function embedMany(
	embedder: Embedder,
	texts: readonly string[],
	options: {
		signal?: AbortSignal;
		resilience?: ProviderResilienceConfig;
	} = {},
): Promise<number[][]> {
	if (texts.length === 0) {
		return [];
	}
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
	if (embeddings.length !== texts.length) {
		throw new MnemocyteError(
			`Embedder returned ${embeddings.length} embeddings for ${texts.length} texts.`,
			"EMBEDDING",
		);
	}
	for (const embedding of embeddings) {
		validateEmbedding(embedding, embedder.dimensions);
	}
	return embeddings;
}
