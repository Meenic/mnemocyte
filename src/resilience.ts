import { MnemocyteError } from "./errors.js";
import type { ProviderResilienceConfig } from "./types.js";

/**
 * Default per-provider-call timeout. Disabled by default so that callers
 * who do not configure {@link ProviderResilienceConfig.timeoutMs} are
 * unaffected.
 */
const DEFAULT_TIMEOUT_MS = 0;
/** Default number of retry attempts on transient provider failures. */
const DEFAULT_RETRIES = 0;
/** Default base backoff delay used between retry attempts. */
const DEFAULT_BASE_DELAY_MS = 100;
/** Default ceiling for retry backoff delay. */
const DEFAULT_MAX_DELAY_MS = 2000;

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

/**
 * Heuristic default for whether an error should be retried.
 *
 * Conservative by design: only retries on common transient failure
 * indicators (network errors, 5xx-ish messages, `ECONN*` etc.). Never
 * retries on validation, configuration, or {@link MnemocyteError} of
 * code `"VALIDATION"` / `"CONFIG"` / `"CONFLICT"` / `"ABORTED"`.
 */
export function defaultShouldRetry(error: unknown): boolean {
	if (error instanceof MnemocyteError) {
		if (
			error.code === "VALIDATION" ||
			error.code === "CONFIG" ||
			error.code === "CONFLICT" ||
			error.code === "ABORTED"
		) {
			return false;
		}
		return true;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"status" in error &&
		typeof (error as { status?: unknown }).status === "number" &&
		[429, 500, 502, 503, 504].includes((error as { status: number }).status)
	) {
		return true;
	}
	if (error instanceof Error) {
		const message = error.message.toLowerCase();
		if (
			message.includes("econn") ||
			message.includes("etimedout") ||
			message.includes("network") ||
			message.includes("timeout") ||
			message.includes("temporarily") ||
			message.includes("rate limit") ||
			message.includes("503") ||
			message.includes("502") ||
			message.includes("504") ||
			message.includes("500")
		) {
			return true;
		}
	}
	return false;
}

/**
 * Compute the backoff delay for the given retry attempt, using exponential
 * growth capped at {@link ProviderResilienceConfig.maxDelayMs}.
 *
 * `attempt` is 1-indexed: the delay before the first retry uses
 * `attempt = 1`, before the second retry `attempt = 2`, etc.
 */
function computeDelayMs(
	attempt: number,
	baseDelayMs: number,
	maxDelayMs: number,
): number {
	const exponential = baseDelayMs * 2 ** (attempt - 1);
	return Math.max(0, Math.min(maxDelayMs, exponential));
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
 * Errors from {@link MnemocyteError} with code `"VALIDATION"` /
 * `"CONFIG"` / `"CONFLICT"` / `"ABORTED"` are never retried.
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
			const waitMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs);
			await delay(waitMs, externalSignal);
		}
	}
	throw lastError;
}
