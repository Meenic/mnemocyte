import { APICallError, type EmbeddingModel, embedMany } from "ai";
import { MnemocyteError, type ProviderError } from "./errors.js";
import { createProviderError, parseErrorBody } from "./provider-error.js";
import type { Embedder, EmbeddingPurpose, EmbedOptions } from "./types.js";

/**
 * Provider-specific options for an embedding call, keyed by provider
 * (`google`, `cohere`, `voyage`, …): the type of `embedMany`'s
 * `providerOptions`.
 */
export type AiSdkProviderOptions = NonNullable<
	Parameters<typeof embedMany>[0]["providerOptions"]
>;

/** Provider options sent with queries and with documents. */
export interface AiSdkPurposeOptions {
	readonly query?: AiSdkProviderOptions;
	readonly document?: AiSdkProviderOptions;
}

export interface AiSdkEmbedderOptions {
	/**
	 * An AI SDK embedding model, such as `openai.embedding("…")`, or a
	 * `"provider/model"` string, which the AI SDK resolves through its global
	 * provider (the AI Gateway unless `globalThis.AI_SDK_DEFAULT_PROVIDER` is
	 * set) on every call.
	 */
	readonly model: EmbeddingModel;
	/**
	 * Length of the vectors the model returns. Known models have a default;
	 * any other model requires it. For a known model, a different value is
	 * sent to the provider to shorten the vectors.
	 */
	readonly dimensions?: number;
	/** Most texts per call. Defaults to `100`. */
	readonly maxBatch?: number;
	/** Provider options sent with every call. */
	readonly providerOptions?: AiSdkProviderOptions;
	/**
	 * Provider options for queries and for documents, merged over
	 * `providerOptions`. Replaces the built-in hints for Google, Cohere and
	 * Voyage; a purpose left out gets no hint.
	 */
	readonly purposes?: AiSdkPurposeOptions;
}

interface KnownModel {
	readonly dimensions: number;
	/** The model cannot shorten its vectors. */
	readonly fixed?: true;
}

/**
 * Default vector sizes from the AI SDK provider docs, keyed by model id
 * without the `provider/` prefix of a gateway id.
 */
const KNOWN_MODELS: ReadonlyMap<string, KnownModel> = new Map([
	["text-embedding-3-small", { dimensions: 1536 }],
	["text-embedding-3-large", { dimensions: 3072 }],
	["text-embedding-ada-002", { dimensions: 1536, fixed: true }],
	["gemini-embedding-001", { dimensions: 3072 }],
	["embed-v4.0", { dimensions: 1536 }],
	["mistral-embed", { dimensions: 1024 }],
	["codestral-embed", { dimensions: 1536 }],
	// Bedrock's id, and the AI Gateway's (`amazon/titan-embed-text-v2`).
	["amazon.titan-embed-text-v2:0", { dimensions: 1024 }],
	["titan-embed-text-v2", { dimensions: 1024 }],
]);

/**
 * Built-in query and document hints by provider. Google (and Vertex, which
 * also reads the `google` key) takes `taskType`, Cohere and Voyage
 * `inputType`. Cohere defaults to `search_query`, so documents embedded
 * without a hint would be embedded as queries.
 */
const DEFAULT_PURPOSES: ReadonlyMap<
	string,
	Readonly<Record<EmbeddingPurpose, AiSdkProviderOptions>>
> = new Map([
	[
		"google",
		{
			query: { google: { taskType: "RETRIEVAL_QUERY" } },
			document: { google: { taskType: "RETRIEVAL_DOCUMENT" } },
		},
	],
	[
		"cohere",
		{
			query: { cohere: { inputType: "search_query" } },
			document: { cohere: { inputType: "search_document" } },
		},
	],
	[
		"voyage",
		{
			query: { voyage: { inputType: "query" } },
			document: { voyage: { inputType: "document" } },
		},
	],
]);

const MODEL_SPECIFICATIONS: ReadonlySet<unknown> = new Set(["v2", "v3", "v4"]);

/** Marker the AI Gateway sets on its errors (`GatewayError.isInstance`). */
const GATEWAY_ERROR_MARKER = Symbol.for("vercel.ai.gateway.error");

const NAME = "aiSdkEmbedder";
const PROVIDER = "AI SDK";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configError(message: string, cause?: unknown): MnemocyteError {
	return new MnemocyteError(`${NAME} ${message}`, "CONFIG", cause);
}

function assertPositiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw configError(`${field} must be a positive integer.`);
	}
	return value;
}

interface ModelIdentity {
	/** Model id without a `provider/` prefix. */
	readonly id: string;
	/** Lower-case provider name, such as `google`, when it can be read. */
	readonly provider: string | undefined;
}

function splitGatewayId(value: string): ModelIdentity {
	const slash = value.indexOf("/");
	if (slash <= 0) {
		return { id: value, provider: undefined };
	}
	return {
		id: value.slice(slash + 1),
		provider: value.slice(0, slash).toLowerCase(),
	};
}

/**
 * Read the model id and provider from a `"provider/model"` string or a model
 * object (`provider` is the part of `model.provider` before the first dot,
 * such as `google` from `google.generative-ai`; a gateway model's id holds
 * the provider instead).
 */
function identifyModel(model: unknown): ModelIdentity {
	let identity: ModelIdentity;
	if (typeof model === "string") {
		if (model.trim().length === 0) {
			throw configError("requires a model.");
		}
		identity = splitGatewayId(model);
	} else {
		if (
			!isRecord(model) ||
			!MODEL_SPECIFICATIONS.has(model.specificationVersion) ||
			typeof model.provider !== "string" ||
			typeof model.modelId !== "string" ||
			model.modelId.trim().length === 0 ||
			typeof model.doEmbed !== "function"
		) {
			throw configError(
				'model must be an AI SDK embedding model or a "provider/model" string.',
			);
		}
		const provider = model.provider.split(".")[0]?.toLowerCase();
		identity =
			provider === "gateway"
				? splitGatewayId(model.modelId)
				: { id: model.modelId, provider };
	}
	if (identity.id.trim().length === 0) {
		throw configError("requires a model.");
	}
	return identity;
}

function resolveDimensions(
	id: string,
	dimensions: unknown,
): { dimensions: number; request: number | undefined } {
	const known = KNOWN_MODELS.get(id);
	if (dimensions === undefined) {
		if (known === undefined) {
			throw configError(`requires dimensions for unknown model "${id}".`);
		}
		return { dimensions: known.dimensions, request: undefined };
	}
	const value = assertPositiveInteger(dimensions, "dimensions");
	if (known === undefined || value === known.dimensions) {
		return { dimensions: value, request: undefined };
	}
	if (known.fixed) {
		throw configError(`does not support a dimensions override for "${id}".`);
	}
	return { dimensions: value, request: value };
}

/**
 * Check and snapshot provider options: an object of JSON objects, copied
 * with a JSON round trip so later changes by the caller do not leak in.
 */
function snapshotProviderOptions(
	value: unknown,
	field: string,
): AiSdkProviderOptions {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw configError(`${field} must be an object.`);
	}
	for (const [key, options] of Object.entries(value)) {
		if (!isRecord(options)) {
			throw configError(`${field}.${key} must be an object.`);
		}
	}
	try {
		return JSON.parse(JSON.stringify(value)) as AiSdkProviderOptions;
	} catch (error) {
		throw configError(`${field} must be JSON.`, error);
	}
}

/** Merge `hint` over `base`, one provider key at a time. */
function mergeProviderOptions(
	base: AiSdkProviderOptions,
	hint: AiSdkProviderOptions,
): AiSdkProviderOptions | undefined {
	const merged: Record<string, AiSdkProviderOptions[string]> = { ...base };
	for (const [key, options] of Object.entries(hint)) {
		merged[key] = { ...merged[key], ...options };
	}
	return Object.keys(merged).length === 0 ? undefined : merged;
}

function resolvePurposeOptions(
	options: AiSdkEmbedderOptions,
	provider: string | undefined,
): Record<EmbeddingPurpose, AiSdkProviderOptions | undefined> {
	const base = snapshotProviderOptions(
		options.providerOptions,
		"providerOptions",
	);
	let hints: Readonly<Record<EmbeddingPurpose, AiSdkProviderOptions>>;
	if (options.purposes === undefined) {
		hints = (provider === undefined
			? undefined
			: DEFAULT_PURPOSES.get(provider)) ?? { query: {}, document: {} };
	} else {
		if (!isRecord(options.purposes)) {
			throw configError("purposes must be an object.");
		}
		hints = {
			query: snapshotProviderOptions(options.purposes.query, "purposes.query"),
			document: snapshotProviderOptions(
				options.purposes.document,
				"purposes.document",
			),
		};
	}
	return {
		query: mergeProviderOptions(base, hints.query),
		document: mergeProviderOptions(base, hints.document),
	};
}

function toHeaders(headers: unknown): Headers {
	const result = new Headers();
	if (!isRecord(headers)) {
		return result;
	}
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value !== "string") {
			continue;
		}
		try {
			result.set(key, value);
		} catch {
			// A header name or value fetch would not accept; skip it.
		}
	}
	return result;
}

/**
 * The `cause` for a failed call: the provider's error as the AI SDK parsed
 * it (`data`), else the response body, else the AI SDK error itself.
 */
function errorBody(error: APICallError): unknown {
	if (error.data !== undefined) {
		return error.data;
	}
	const body =
		typeof error.responseBody === "string"
			? parseErrorBody(error.responseBody)
			: undefined;
	return body ?? error;
}

function isGatewayError(
	error: unknown,
): error is Error & { readonly statusCode: number; readonly cause?: unknown } {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as Record<symbol, unknown>)[GATEWAY_ERROR_MARKER] === true &&
		typeof (error as { statusCode?: unknown }).statusCode === "number"
	);
}

/**
 * Turn an AI SDK error with an HTTP status into a {@link ProviderError}, so
 * Mnemocyte's retry rule and `Retry-After` handling apply. A gateway error
 * keeps the status the gateway gives it and reads headers and body from the
 * provider error it wraps. Anything else (a network failure, an unknown
 * model) is thrown unchanged.
 */
function toProviderError(error: unknown): ProviderError | undefined {
	if (APICallError.isInstance(error)) {
		if (error.statusCode === undefined) {
			return undefined;
		}
		return createProviderError({
			provider: PROVIDER,
			status: error.statusCode,
			headers: toHeaders(error.responseHeaders),
			body: errorBody(error),
		});
	}
	if (isGatewayError(error)) {
		const cause = APICallError.isInstance(error.cause)
			? error.cause
			: undefined;
		return createProviderError({
			provider: PROVIDER,
			status: error.statusCode,
			headers: toHeaders(cause?.responseHeaders),
			body: cause === undefined ? error : errorBody(cause),
		});
	}
	return undefined;
}

/**
 * Create an {@link Embedder} from an AI SDK embedding model, through
 * `embedMany`. Requires the `ai` package (7.0.135 or newer).
 *
 * The AI SDK's own retries are off; the client's `provider` settings retry
 * instead, and AI SDK errors with an HTTP status become a `ProviderError`.
 * Google, Cohere and Voyage models get query and document hints by default.
 *
 * @example
 * ```ts
 * import { aiSdkEmbedder } from "mnemocyte/ai-sdk";
 *
 * // Through the AI Gateway (AI_GATEWAY_API_KEY).
 * const embedder = aiSdkEmbedder({ model: "openai/text-embedding-3-small" });
 * ```
 */
export function aiSdkEmbedder(options: AiSdkEmbedderOptions): Embedder {
	if (!isRecord(options)) {
		throw configError("requires an options object.");
	}
	const { model } = options;
	const identity = identifyModel(model);
	const { dimensions, request } = resolveDimensions(
		identity.id,
		options.dimensions,
	);
	const maxBatch =
		options.maxBatch === undefined
			? undefined
			: assertPositiveInteger(options.maxBatch, "maxBatch");
	const purposeOptions = resolvePurposeOptions(options, identity.provider);

	return {
		model: identity.id,
		dimensions,
		...(maxBatch === undefined ? {} : { maxBatch }),
		async embed(texts: readonly string[], embedOptions: EmbedOptions) {
			// Untyped callers can leave options out; fail with a clear error.
			const purpose: unknown = isRecord(embedOptions)
				? embedOptions.purpose
				: undefined;
			if (purpose !== "query" && purpose !== "document") {
				throw new MnemocyteError(
					`${NAME} embed requires options.purpose "query" or "document".`,
					"VALIDATION",
				);
			}
			const providerOptions = purposeOptions[purpose];
			try {
				const result = await embedMany({
					model,
					values: [...texts],
					// Mnemocyte retries (client `provider` settings); retrying here
					// too would multiply the attempts.
					maxRetries: 0,
					// Mnemocyte already sends batches one after another.
					maxParallelCalls: 1,
					...(request === undefined ? {} : { dimensions: request }),
					...(providerOptions === undefined
						? {}
						: { providerOptions: structuredClone(providerOptions) }),
					...(embedOptions.signal === undefined
						? {}
						: { abortSignal: embedOptions.signal }),
				});
				return result.embeddings;
			} catch (error) {
				throw toProviderError(error) ?? error;
			}
		},
	};
}

export {
	type MemoryFinishReason,
	type MemoryLanguageModel,
	type MemoryMiddlewareContextOptions,
	type MemoryMiddlewareError,
	type MemoryMiddlewareOptions,
	type MemoryPrompt,
	type MemoryTurn,
	type MemoryWrappedModel,
	memoryMiddleware,
	type WithMemoryOptions,
	withMemory,
} from "./ai-sdk-middleware.js";
export {
	type ForgetMemoryInput,
	type ForgetMemoryOutput,
	type FoundMemory,
	type MemoryTools,
	type MemoryToolsOptions,
	memoryTools,
	type SaveMemoryInput,
	type SaveMemoryOutput,
	type SearchMemoriesInput,
	type SearchMemoriesOutput,
} from "./ai-sdk-tools.js";
