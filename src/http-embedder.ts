import { MnemocyteError, ProviderError } from "./errors.js";
import type {
	Embedder,
	EmbeddingPurpose,
	EmbedOptions,
	JsonObject,
} from "./types.js";

/**
 * Longest error body kept as a {@link ProviderError} `cause`, in UTF-16
 * code units. Longer bodies are cut to this length and kept as text.
 */
export const MAX_ERROR_BODY_LENGTH = 8192;

/** Request fields an embedder owns; a purpose `body` may not set them. */
const RESERVED_BODY_FIELDS: ReadonlySet<string> = new Set([
	"model",
	"input",
	"encoding_format",
	"dimensions",
]);

/** Provider error codes short and plain enough to quote in a message. */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

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

function isRecord(value: unknown): value is Record<string, unknown> {
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

function resolveBaseUrl(baseUrl: unknown, name: string): string {
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

/**
 * Parse the wait a response asks for, in milliseconds: `retry-after-ms`
 * (OpenAI, Azure), then `Retry-After` as delay-seconds or an HTTP-date
 * (RFC 9110, section 10.2.3). Returns `undefined` when neither header holds
 * a valid value. A date in the past means no wait.
 */
export function parseRetryAfterMs(
	headers: Headers,
	now: number = Date.now(),
): number | undefined {
	const milliseconds = headers.get("retry-after-ms")?.trim();
	if (milliseconds !== undefined && /^\d+(\.\d+)?$/.test(milliseconds)) {
		return Number(milliseconds);
	}
	const value = headers.get("retry-after")?.trim();
	if (value === undefined || value.length === 0) {
		return undefined;
	}
	if (/^\d+(\.\d+)?$/.test(value)) {
		return Number(value) * 1000;
	}
	// Every HTTP-date form names a weekday and a month; without letters,
	// `Date.parse` would also read values such as "-5" as a year.
	if (!/[A-Za-z]/.test(value)) {
		return undefined;
	}
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

async function readErrorBody(response: Response): Promise<unknown> {
	let text: string;
	try {
		text = await response.text();
	} catch {
		return undefined;
	}
	if (text.length === 0) {
		return undefined;
	}
	if (text.length > MAX_ERROR_BODY_LENGTH) {
		return text.slice(0, MAX_ERROR_BODY_LENGTH);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

/**
 * A short, safe label from an error body: the `code` or `type` of an
 * OpenAI-shaped `{ error: { … } }` or a top-level one (vLLM). The free-text
 * `message` is left out because it can echo part of a credential.
 */
function errorLabel(body: unknown): string | undefined {
	const candidates = isRecord(body)
		? [
				isRecord(body.error) ? body.error.code : undefined,
				isRecord(body.error) ? body.error.type : undefined,
				body.code,
				body.type,
			]
		: [];
	for (const candidate of candidates) {
		if (typeof candidate === "string" && ERROR_CODE_PATTERN.test(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export async function providerErrorFromResponse(
	response: Response,
	provider: string,
): Promise<ProviderError> {
	const retryAfterMs = parseRetryAfterMs(response.headers);
	const body = await readErrorBody(response);
	const label = errorLabel(body);
	return new ProviderError({
		message: `${provider} embeddings request failed with status ${response.status}${label === undefined ? "" : ` (${label})`}.`,
		status: response.status,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		...(body === undefined ? {} : { body }),
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
 * Build an {@link Embedder} for an OpenAI-shaped `POST {baseUrl}/embeddings`
 * endpoint with `fetch`. Options are checked and snapshotted here, so a
 * mistake throws `"CONFIG"` when the embedder is created.
 */
export function createHttpEmbedder(config: HttpEmbedderConfig): Embedder {
	const { name, provider, model, dimensions, sendDimensions } = config;
	const baseUrl = resolveBaseUrl(config.baseUrl, name);
	if (typeof model !== "string" || model.trim().length === 0) {
		throw new MnemocyteError(`${name} requires a model.`, "CONFIG");
	}
	assertPositiveInteger(dimensions, "dimensions", name);
	if (config.maxBatch !== undefined) {
		assertPositiveInteger(config.maxBatch, "maxBatch", name);
	}
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
		"content-type": "application/json",
	};
	const hints = resolvePurposes(config.purposes, name);

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
			const hint = hints[purpose];
			const response = await fetch(`${baseUrl}/embeddings`, {
				method: "POST",
				headers: { ...headers },
				body: JSON.stringify({
					...hint.body,
					model,
					input:
						hint.prefix.length === 0
							? [...texts]
							: texts.map((text) => `${hint.prefix}${text}`),
					encoding_format: "float",
					...(sendDimensions ? { dimensions } : {}),
				}),
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
			return validateEmbeddingResponse(body, texts.length, provider)
				.sort((left, right) => left.index - right.index)
				.map((item) => item.embedding);
		},
	};
}
