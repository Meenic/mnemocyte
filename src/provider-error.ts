import { ProviderError } from "./errors.js";

/**
 * Longest error body kept as a {@link ProviderError} `cause`, in UTF-16
 * code units. Longer bodies are cut to this length and kept as text.
 */
export const MAX_ERROR_BODY_LENGTH = 8192;

/** Provider error codes short and plain enough to quote in a message. */
const ERROR_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

/**
 * An error response body as a {@link ProviderError} `cause`: parsed JSON, or
 * the text when it is not JSON or longer than
 * {@link MAX_ERROR_BODY_LENGTH} (then cut to that length). An empty body is
 * `undefined`.
 */
export function parseErrorBody(text: string): unknown {
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
 * OpenAI-shaped `{ error: { … } }`, the canonical `status` of a Google one
 * (`RESOURCE_EXHAUSTED`; its `code` is the numeric HTTP status), or a
 * top-level `code` or `type` (vLLM). The free-text `message` (Voyage's
 * `detail`, Cohere's `message`) is left out because it can echo part of a
 * credential.
 */
function errorLabel(body: unknown): string | undefined {
	const candidates = isRecord(body)
		? [
				isRecord(body.error) ? body.error.code : undefined,
				isRecord(body.error) ? body.error.type : undefined,
				isRecord(body.error) ? body.error.status : undefined,
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

/** Input for {@link createProviderError}. */
export interface ProviderErrorDetails {
	/** Provider name for the message, such as `"OpenAI"`. */
	readonly provider: string;
	readonly status: number;
	/** Response headers, read for `retry-after-ms` and `Retry-After`. */
	readonly headers: Headers;
	/** The response body, already parsed; kept as the error's `cause`. */
	readonly body: unknown;
}

/**
 * Build the {@link ProviderError} for a failed embeddings request. The
 * message names the status and a short code from the body, never the body's
 * free text.
 */
export function createProviderError(
	details: ProviderErrorDetails,
): ProviderError {
	const retryAfterMs = parseRetryAfterMs(details.headers);
	const label = errorLabel(details.body);
	return new ProviderError({
		message: `${details.provider} embeddings request failed with status ${details.status}${label === undefined ? "" : ` (${label})`}.`,
		status: details.status,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
		...(details.body === undefined ? {} : { body: details.body }),
	});
}
