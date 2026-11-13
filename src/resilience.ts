import { MnemocyteError } from "./errors.js";
import type { ProviderResilienceConfig } from "./types.js";

/**
 * Default per-provider-call timeout. Disabled by default: a timeout that
 * fits every provider and batch size does not exist.
 */
const DEFAULT_TIMEOUT_MS = 0;
/** Default number of retry attempts on transient provider failures. */
const DEFAULT_RETRIES = 2;
/** Default base backoff delay used between retry attempts. */
const DEFAULT_BASE_DELAY_MS = 500;
/** Default ceiling for retry backoff delay. */
const DEFAULT_MAX_DELAY_MS = 8000;
/** Default ceiling for a server-requested wait (`Retry-After`). */
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

/**
 * HTTP statuses retried by default: request timeout, rate limit, and the
 * server errors that mean "try again" (not 501 Not Implemented or 505).
 */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([
	408, 429, 500, 502, 503, 504,
]);

/**
 * Node and undici error codes for network failures that can pass on their
 * own. `fetch` rejects with a `TypeError` whose `cause` carries the code.
 */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ETIMEDOUT",
	"EPIPE",
	"EAI_AGAIN",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

/** How many `cause` links {@link hasRetryableNetworkCode} follows. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Throw a {@link MnemocyteError} with code `"ABORTED"` if `signal` is
 * already aborted. Safe to call with `undefined`.
 */
export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new MnemocyteError(
			"Operation was aborted.",
			"ABORTED",
			signal.reason,
		);
	}
}

function readNumberField(error: unknown, field: string): number | undefined {
	if (typeof error !== "object" || error === null || !(field in error)) {
		return undefined;
	}
	const value = (error as Record<string, unknown>)[field];
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

function hasRetryableNetworkCode(error: unknown): boolean {
	let current: unknown = error;
	for (
		let depth = 0;
		depth < MAX_CAUSE_DEPTH && typeof current === "object" && current !== null;
		depth += 1
	) {
		const { code } = current as { code?: unknown };
		if (typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code)) {
			return true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

/**
 * Default rule for whether an error should be retried. Decisions rest on
 * structured fields, never on message text:
 *
 * - a numeric `status` of 408, 429, 500, 502, 503 or 504 (such as a
 *   `ProviderError`);
 * - a transient network `code` (`ECONNRESET`, `ETIMEDOUT`, undici socket
 *   and timeout codes…) on the error or along its `cause` chain;
 * - a {@link MnemocyteError} with code `"TIMEOUT"`.
 *
 * Everything else, other {@link MnemocyteError}s included, is not retried.
 */
export function defaultShouldRetry(error: unknown): boolean {
	const status = readNumberField(error, "status");
	if (status !== undefined) {
		return RETRYABLE_STATUSES.has(status);
	}
	if (error instanceof MnemocyteError) {
		return error.code === "TIMEOUT";
	}
	return hasRetryableNetworkCode(error);
}

/**
 * Compute the backoff delay for the given retry attempt: exponential growth
 * capped at {@link ProviderResilienceConfig.maxDelayMs}, then a random
 * 50–100% of that ("equal jitter"), so clients that failed together do not
 * retry together.
 *
 * `attempt` is 1-indexed: the delay before the first retry uses
 * `attempt = 1`, before the second retry `attempt = 2`, etc.
 */
export function computeDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
	random: () => number = Math.random,
): number {
	const exponential = Math.max(
		0,
		Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)),
	);
	return exponential / 2 + (random() * exponential) / 2;
}

/**
 * The wait a failed attempt's error asks for: a non-negative, finite
 * `retryAfterMs` field (set by `ProviderError` from `Retry-After` or
 * `retry-after-ms`), or `undefined`.
 */
function readRetryAfterMs(error: unknown): number | undefined {
	const value = readNumberField(error, "retryAfterMs");
	return value === undefined || value < 0 ? undefined : value;
}

/**
 * Promise-based `setTimeout` that rejects with an `"ABORTED"`
 * {@link MnemocyteError} if `signal` aborts while waiting.
 */
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (ms <= 0) {
		throwIfAborted(signal);
		return Promise.resolve();
	}
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(
				new MnemocyteError("Operation was aborted.", "ABORTED", signal?.reason),
			);
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(
					new MnemocyteError(
						"Operation was aborted.",
						"ABORTED",
						signal.reason,
					),
				);
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function timeoutError(timeoutMs: number): MnemocyteError {
	return new MnemocyteError(
		`Provider call timed out after ${timeoutMs}ms.`,
		"TIMEOUT",
	);
}

/**
 * Run one provider attempt with a signal linked to the caller's signal and
 * Mnemocyte's configured timeout. Timeout aborts are actively propagated to
 * providers that honor `AbortSignal`.
 */
function runAttempt<T>(
	action: (signal: AbortSignal | undefined) => Promise<T>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (timeoutMs <= 0 && !signal) {
		return action(undefined);
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const controller = new AbortController();
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						if (settled) {
							return;
						}
						settled = true;
						signal?.removeEventListener("abort", onAbort);
						controller.abort(timeoutError(timeoutMs));
						reject(timeoutError(timeoutMs));
					}, timeoutMs)
				: undefined;
		const onAbort = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timer) {
				clearTimeout(timer);
			}
			controller.abort(signal?.reason);
			reject(
				new MnemocyteError("Operation was aborted.", "ABORTED", signal?.reason),
			);
		};
		if (signal) {
			if (signal.aborted) {
				if (timer) {
					clearTimeout(timer);
				}
				settled = true;
				controller.abort(signal.reason);
				reject(
					new MnemocyteError(
						"Operation was aborted.",
						"ABORTED",
						signal.reason,
					),
				);
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		action(controller.signal).then(
			(value) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				if (settled) {
					return;
				}
				settled = true;
				if (timer) {
					clearTimeout(timer);
				}
				signal?.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/**
 * Options accepted by {@link withResilience}.
 */
export interface ResilienceCallOptions {
	/** External cancellation signal forwarded to each attempt. */
	signal?: AbortSignal;
	/** Provider-level retry/timeout configuration. */
	resilience?: ProviderResilienceConfig;
}

/**
 * Run `action` with timeout, retry, and abort handling derived from
 * `options.resilience` and `options.signal`. Each retry attempt receives
 * a fresh `AbortSignal` linked to the caller's signal — so callers may
 * abort mid-retry and the in-flight attempt will cancel promptly if the
 * underlying provider honours signals.
 *
 * Which errors retry is decided by `shouldRetry` (default
 * {@link defaultShouldRetry}); `"ABORTED"` never retries. An error with a
 * `retryAfterMs` waits that long instead of the jittered backoff, or is
 * thrown at once when it asks for more than `maxRetryAfterMs`.
 */
export async function withResilience<T>(
	action: (signal: AbortSignal | undefined) => Promise<T>,
	options: ResilienceCallOptions = {},
): Promise<T> {
	const config = options.resilience ?? {};
	const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const retries = Math.max(0, config.retries ?? DEFAULT_RETRIES);
	const baseDelayMs = Math.max(0, config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
	const maxDelayMs = Math.max(
		baseDelayMs,
		config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
	);
	const maxRetryAfterMs = config.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
	const shouldRetry = config.shouldRetry ?? defaultShouldRetry;
	const externalSignal = options.signal;

	throwIfAborted(externalSignal);

	const maxAttempts = retries + 1;
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		throwIfAborted(externalSignal);
		try {
			return await runAttempt(action, timeoutMs, externalSignal);
		} catch (error) {
			lastError = error;
			if (error instanceof MnemocyteError && error.code === "ABORTED") {
				throw error;
			}
			if (attempt >= maxAttempts) {
				throw error;
			}
			if (!shouldRetry(error, attempt)) {
				throw error;
			}
			const retryAfterMs = readRetryAfterMs(error);
			if (retryAfterMs !== undefined && retryAfterMs > maxRetryAfterMs) {
				throw error;
			}
			const waitMs =
				retryAfterMs ?? computeDelayMs(attempt, baseDelayMs, maxDelayMs);
			await delay(waitMs, externalSignal);
		}
	}
	throw lastError;
}
