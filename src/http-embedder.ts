import { MnemocyteError, type ProviderError } from "./errors.js";
import { createProviderError, parseErrorBody } from "./provider-error.js";
import type {
	Embedder,
	EmbeddingPurpose,
	EmbedOptions,
	JsonObject,
} from "./types.js";

/** Request fields an embedder owns; a purpose `body` may not set them. */
const RESERVED_BODY_FIELDS: ReadonlySet<string> = new Set([
	"model",
	"input",
	"encoding_format",
	"dimensions",
]);

/** How an embedder marks texts for one {@link EmbeddingPurpose}. */
export interface PurposeHint {
	/** Text put in front of every input, such as `"search_query: "`. */
	readonly prefix?: string;
	/**
	 * JSON fields added to the request body, such as
	 * `{ input_type: "passage" }`. `model`, `input`, `encoding_format` and
	 * `dimensions` are set by the embedder and may not appear here.
	 */
	readonly body?: JsonObject;
}

/** Per-purpose hints; a purpose without one is sent as plain text. */
export interface PurposeHints {
	readonly query?: PurposeHint;
	readonly document?: PurposeHint;
}

export interface HttpEmbedderConfig {
	/** Name used in error messages, such as `"openaiEmbedder"`. */
	readonly name: string;
	/** Provider name used in response errors, such as `"OpenAI"`. */
	readonly provider: string;
	readonly baseUrl: string;
	readonly model: string;
	readonly dimensions: number;
	readonly apiKey: string | undefined;
	readonly headers: Readonly<Record<string, string>> | undefined;
	readonly maxBatch: number | undefined;
	readonly sendDimensions: boolean;
	readonly purposes: PurposeHints | undefined;
}

interface ResolvedHint {
	readonly prefix: string;
	readonly body: JsonObject;
}

interface EmbeddingItem {
	readonly embedding: number[];
	readonly index: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertPositiveInteger(
	value: number,
	field: string,
	name: string,
): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new MnemocyteError(
			`${name} ${field} must be a positive integer.`,
			"CONFIG",
		);
	}
}

export function resolveBaseUrl(baseUrl: unknown, name: string): string {
	if (typeof baseUrl !== "string" || baseUrl.trim().length === 0) {
		throw new MnemocyteError(`${name} requires a baseUrl.`, "CONFIG");
	}
	if (!URL.canParse(baseUrl)) {
		throw new MnemocyteError(
			`${name} baseUrl must be an absolute URL.`,
			"CONFIG",
		);
	}
	return baseUrl.replace(/\/+$/, "");
}

function resolveHeaders(
	headers: unknown,
	name: string,
): Record<string, string> {
	if (headers === undefined) {
		return {};
	}
	if (!isRecord(headers)) {
		throw new MnemocyteError(`${name} headers must be an object.`, "CONFIG");
	}
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (typeof value !== "string") {
			throw new MnemocyteError(
				`${name} header "${key}" must be a string.`,
				"CONFIG",
			);
		}
		resolved[key.toLowerCase()] = value;
	}
	return resolved;
}

function resolveHint(
	hint: unknown,
	purpose: EmbeddingPurpose,
	name: string,
): ResolvedHint {
	if (hint === undefined) {
		return { prefix: "", body: {} };
	}
	if (!isRecord(hint)) {
		throw new MnemocyteError(
			`${name} purposes.${purpose} must be an object.`,
			"CONFIG",
		);
	}
	const { prefix, body } = hint;
	if (prefix !== undefined && typeof prefix !== "string") {
		throw new MnemocyteError(
			`${name} purposes.${purpose}.prefix must be a string.`,
			"CONFIG",
		);
	}
	if (body !== undefined && !isRecord(body)) {
		throw new MnemocyteError(
			`${name} purposes.${purpose}.body must be an object.`,
			"CONFIG",
		);
	}
	for (const field of Object.keys(body ?? {})) {
		if (RESERVED_BODY_FIELDS.has(field)) {
			throw new MnemocyteError(
				`${name} purposes.${purpose}.body may not set "${field}".`,
				"CONFIG",
			);
		}
	}
	let snapshot: JsonObject;
	try {
		// A JSON round trip snapshots the caller's object and proves it can be
		// sent.
		snapshot = JSON.parse(JSON.stringify(body ?? {})) as JsonObject;
	} catch (error) {
		throw new MnemocyteError(
			`${name} purposes.${purpose}.body must be JSON.`,
			"CONFIG",
			error,
		);
	}
	return { prefix: prefix ?? "", body: snapshot };
}

function resolvePurposes(
	purposes: unknown,
	name: string,
): Record<EmbeddingPurpose, ResolvedHint> {
	if (purposes !== undefined && !isRecord(purposes)) {
		throw new MnemocyteError(`${name} purposes must be an object.`, "CONFIG");
	}
	return {
		query: resolveHint(purposes?.query, "query", name),
		document: resolveHint(purposes?.document, "document", name),
	};
}

async function providerErrorFromResponse(
	response: Response,
	provider: string,
): Promise<ProviderError> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		text = "";
	}
	return createProviderError({
		provider,
		status: response.status,
		headers: response.headers,
		body: parseErrorBody(text),
	});
}

function validateEmbeddingResponse(
	body: unknown,
	expectedCount: number,
	provider: string,
): EmbeddingItem[] {
	if (!isRecord(body) || !Array.isArray(body.data)) {
		throw new MnemocyteError(
			`${provider} returned malformed embedding response data.`,
			"EMBEDDING",
		);
	}
	if (body.data.length !== expectedCount) {
		throw new MnemocyteError(
			`${provider} returned an unexpected number of embeddings.`,
			"EMBEDDING",
		);
	}

	const indices = new Set<number>();
	const items: EmbeddingItem[] = [];
	for (const item of body.data) {
		if (!isRecord(item)) {
			throw new MnemocyteError(
				`${provider} returned a malformed embedding item.`,
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
				`${provider} returned an embedding with an invalid index.`,
				"EMBEDDING",
			);
		}
		if (indices.has(index)) {
			throw new MnemocyteError(
				`${provider} returned a duplicate embedding index.`,
				"EMBEDDING",
			);
		}
		if (!Array.isArray(embedding)) {
			throw new MnemocyteError(
				`${provider} returned an embedding that is not an array.`,
				"EMBEDDING",
			);
		}
		indices.add(index);
		items.push({ embedding: embedding as number[], index });
	}
	return items;
}

/**
 * Read an OpenAI-shaped `{ data: [{ embedding, index }] }` body (OpenAI,
 * Voyage and the servers `openaiCompatibleEmbedder` targets): exactly one
 * array embedding per input with unique, in-range indexes, sorted by index.
 */
export function parseIndexedEmbeddings(
	body: unknown,
	expectedCount: number,
	provider: string,
): number[][] {
	return validateEmbeddingResponse(body, expectedCount, provider)
		.sort((left, right) => left.index - right.index)
		.map((item) => item.embedding);
}

/**
 * Check a list of vectors that is in input order (Cohere's
 * `embeddings.float`, Google's `embeddings[].values`): exactly one array
 * per input. Element checks are left to the core's output validation.
 */
export function assertVectorList(
	vectors: unknown,
	expectedCount: number,
	provider: string,
): number[][] {
	if (!Array.isArray(vectors)) {
		throw new MnemocyteError(
			`${provider} returned malformed embedding response data.`,
			"EMBEDDING",
		);
	}
	if (vectors.length !== expectedCount) {
		throw new MnemocyteError(
			`${provider} returned an unexpected number of embeddings.`,
			"EMBEDDING",
		);
	}
	for (const vector of vectors) {
		if (!Array.isArray(vector)) {
			throw new MnemocyteError(
				`${provider} returned an embedding that is not an array.`,
				"EMBEDDING",
			);
		}
	}
	return vectors as number[][];
}

/** Everything {@link createFetchEmbedder} needs to call one provider. */
export interface FetchEmbedderConfig {
	/** Name used in error messages, such as `"voyageEmbedder"`. */
	readonly name: string;
	/** Provider name used in response errors, such as `"Voyage"`. */
	readonly provider: string;
	/** Reported as `Embedder.model`. */
	readonly model: string;
	readonly dimensions: number;
	readonly maxBatch: number | undefined;
	/** The endpoint every request is sent to. */
	readonly url: string;
	/** Request headers; `content-type` is added. */
	readonly headers: Readonly<Record<string, string>>;
	/** The JSON request body for one call. */
	readonly buildBody: (
		texts: readonly string[],
		purpose: EmbeddingPurpose,
	) => unknown;
	/**
	 * Read one vector per input, in input order, from a successful response
	 * body; throws `"EMBEDDING"` when the body is malformed.
	 */
	readonly parseResponse: (body: unknown, expectedCount: number) => number[][];
}

/**
 * Build an {@link Embedder} that POSTs JSON to one provider endpoint with
 * `fetch`. It checks `purpose`, forwards the call's signal, turns a non-2xx
 * response into a `ProviderError` and a non-JSON success body into
 * `"EMBEDDING"`. The provider's options must already be checked.
 */
export function createFetchEmbedder(config: FetchEmbedderConfig): Embedder {
	const { name, provider, model, dimensions, url, buildBody, parseResponse } =
		config;
	const headers: Record<string, string> = {
		...config.headers,
		"content-type": "application/json",
	};
	return {
		model,
		dimensions,
		...(config.maxBatch === undefined ? {} : { maxBatch: config.maxBatch }),
		async embed(texts: readonly string[], options: EmbedOptions) {
			// Untyped callers can leave options out; fail with a clear error.
			const purpose: unknown = isRecord(options) ? options.purpose : undefined;
			if (purpose !== "query" && purpose !== "document") {
				throw new MnemocyteError(
					`${name} embed requires options.purpose "query" or "document".`,
					"VALIDATION",
				);
			}
			const response = await fetch(url, {
				method: "POST",
				headers: { ...headers },
				body: JSON.stringify(buildBody(texts, purpose)),
				...(options.signal === undefined ? {} : { signal: options.signal }),
			});

			if (!response.ok) {
				throw await providerErrorFromResponse(response, provider);
			}

			let body: unknown;
			try {
				body = await response.json();
			} catch (error) {
				if (options.signal?.aborted) {
					throw error;
				}
				throw new MnemocyteError(
					`${provider} returned a response that is not JSON.`,
					"EMBEDDING",
					error,
				);
			}
			return parseResponse(body, texts.length);
		},
	};
}

/**
 * The API key for a hosted provider: `apiKey`, else `process.env[envVar]`.
 * A missing or blank key throws `"CONFIG"`.
 */
export function resolveApiKey(
	apiKey: unknown,
	envVar: string,
	name: string,
): string {
	const resolved = apiKey ?? process.env[envVar];
	if (typeof resolved !== "string" || resolved.trim().length === 0) {
		throw new MnemocyteError(
			`${name} requires an API key. Pass apiKey or set ${envVar}.`,
			"CONFIG",
		);
	}
	return resolved;
}

/** A model's default vector length and the lengths it can be asked for. */
export interface KnownModelSize {
	readonly dimensions: number;
	/** Every accepted length; leave out both for a fixed size. */
	readonly sizes?: readonly number[];
	/** An inclusive range of accepted lengths. */
	readonly range?: readonly [min: number, max: number];
}

/**
 * Resolve `dimensions` against a known-models table:
 *
 * - a known model with selectable sizes takes one of them, which is sent;
 * - a known fixed-size model accepts only its own size, which is not sent;
 * - an unknown model requires `dimensions`, which only states the length
 *   the model returns and is not sent.
 */
export function resolveModelDimensions(input: {
	readonly name: string;
	readonly model: string;
	readonly dimensions: unknown;
	readonly known: ReadonlyMap<string, KnownModelSize>;
}): { readonly dimensions: number; readonly send: boolean } {
	const { name, model, dimensions } = input;
	if (dimensions !== undefined) {
		assertPositiveInteger(dimensions as number, "dimensions", name);
	}
	const size = input.known.get(model);
	if (size === undefined) {
		if (dimensions === undefined) {
			throw new MnemocyteError(
				`${name} requires dimensions for unknown model "${model}".`,
				"CONFIG",
			);
		}
		return { dimensions: dimensions as number, send: false };
	}
	if (dimensions === undefined) {
		return { dimensions: size.dimensions, send: false };
	}
	const requested = dimensions as number;
	if (size.sizes !== undefined) {
		if (!size.sizes.includes(requested)) {
			throw new MnemocyteError(
				`${name} dimensions for "${model}" must be one of ${size.sizes.join(", ")}.`,
				"CONFIG",
			);
		}
		return { dimensions: requested, send: true };
	}
	if (size.range !== undefined) {
		const [min, max] = size.range;
		if (requested < min || requested > max) {
			throw new MnemocyteError(
				`${name} dimensions for "${model}" must be between ${min} and ${max}.`,
				"CONFIG",
			);
		}
		return { dimensions: requested, send: true };
	}
	if (requested !== size.dimensions) {
		throw new MnemocyteError(
			`${name} model "${model}" always returns ${size.dimensions} dimensions.`,
			"CONFIG",
		);
	}
	return { dimensions: requested, send: false };
}

/** Check an optional boolean option; `"CONFIG"` for anything else. */
export function resolveBoolean(
	value: unknown,
	field: string,
	name: string,
	fallback: boolean,
): boolean {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new MnemocyteError(`${name} ${field} must be a boolean.`, "CONFIG");
	}
	return value;
}

/** Check a non-empty model id; `"CONFIG"` otherwise. */
export function resolveModel(model: unknown, name: string): string {
	if (typeof model !== "string" || model.trim().length === 0) {
		throw new MnemocyteError(`${name} requires a model.`, "CONFIG");
	}
	return model;
}

/** Check an optional `maxBatch`, capped at `max` when the API has a limit. */
export function resolveMaxBatch(
	maxBatch: unknown,
	name: string,
	fallback: number | undefined,
	max?: number,
): number | undefined {
	if (maxBatch === undefined) {
		return fallback;
	}
	assertPositiveInteger(maxBatch as number, "maxBatch", name);
	if (max !== undefined && (maxBatch as number) > max) {
		throw new MnemocyteError(
			`${name} maxBatch must be at most ${max}.`,
			"CONFIG",
		);
	}
	return maxBatch as number;
}

/**
 * Build an {@link Embedder} for an OpenAI-shaped `POST {baseUrl}/embeddings`
 * endpoint with `fetch`. Options are checked and snapshotted here, so a
 * mistake throws `"CONFIG"` when the embedder is created.
 */
export function createHttpEmbedder(config: HttpEmbedderConfig): Embedder {
	const { name, provider, dimensions, sendDimensions } = config;
	const baseUrl = resolveBaseUrl(config.baseUrl, name);
	const model = resolveModel(config.model, name);
	assertPositiveInteger(dimensions, "dimensions", name);
	const maxBatch = resolveMaxBatch(config.maxBatch, name, undefined);
	if (
		config.apiKey !== undefined &&
		(typeof config.apiKey !== "string" || config.apiKey.trim().length === 0)
	) {
		throw new MnemocyteError(
			`${name} apiKey must be a non-empty string.`,
			"CONFIG",
		);
	}
	const headers: Record<string, string> = {
		...resolveHeaders(config.headers, name),
		...(config.apiKey === undefined
			? {}
			: { authorization: `Bearer ${config.apiKey}` }),
	};
	const hints = resolvePurposes(config.purposes, name);

	return createFetchEmbedder({
		name,
		provider,
		model,
		dimensions,
		maxBatch,
		url: `${baseUrl}/embeddings`,
		headers,
		buildBody(texts, purpose) {
			const hint = hints[purpose];
			return {
				...hint.body,
				model,
				input:
					hint.prefix.length === 0
						? [...texts]
						: texts.map((text) => `${hint.prefix}${text}`),
				encoding_format: "float",
				...(sendDimensions ? { dimensions } : {}),
			};
		},
		parseResponse(body, expectedCount) {
			return parseIndexedEmbeddings(body, expectedCount, provider);
		},
	});
}
