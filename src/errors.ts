/**
 * Stable, machine-readable error code attached to every {@link MnemocyteError}.
 *
 * - `"CONFIG"` — invalid client configuration (e.g. missing or malformed embedder).
 * - `"VALIDATION"` — invalid argument passed to a client method.
 * - `"DB"` — Postgres or driver-level failure.
 * - `"EMBEDDING"` — embedder threw or returned an invalid vector.
 * - `"NOT_FOUND"` — referenced memory or entity does not exist.
 * - `"MIGRATION"` — schema/migration check failed against the target database.
 * - `"TIMEOUT"` — a provider call exceeded its configured timeout.
 * - `"ABORTED"` — the operation was cancelled via an `AbortSignal`.
 */
export type MnemocyteErrorCode =
	| "CONFIG"
	| "VALIDATION"
	| "DB"
	| "EMBEDDING"
	| "NOT_FOUND"
	| "MIGRATION"
	| "TIMEOUT"
	| "ABORTED";

/**
 * Error type thrown by every public Mnemocyte API.
 *
 * Use the {@link MnemocyteError.code} property — not the message — to branch
 * on failure modes, or call {@link isMnemocyteError} as a type guard when
 * working with `unknown` errors.
 *
 * @example
 * ```ts
 * try {
 *   await client.recall({ entityId: "u1", query: "hi" });
 * } catch (err) {
 *   if (isMnemocyteError(err) && err.code === "DB") {
 *     // handle database failure
 *   }
 *   throw err;
 * }
 * ```
 */
export class MnemocyteError extends Error {
	/** Stable, machine-readable failure code. See {@link MnemocyteErrorCode}. */
	readonly code: MnemocyteErrorCode;
	/** Underlying cause, if any (e.g. an original driver or embedder error). */
	override readonly cause?: unknown;

	/**
	 * @param message - Human-readable error message.
	 * @param code - Stable failure code; see {@link MnemocyteErrorCode}.
	 * @param cause - Optional underlying cause (driver error, network error, etc.).
	 */
	constructor(message: string, code: MnemocyteErrorCode, cause?: unknown) {
		super(message);
		this.name = "MnemocyteError";
		this.code = code;
		this.cause = cause;
	}
}

/**
 * Type guard for {@link MnemocyteError}.
 *
 * Prefer this over `instanceof` when working across module boundaries or
 * bundlers where multiple copies of the class may exist.
 *
 * @param error - Value to test (typically a caught `unknown`).
 * @returns `true` if `error` is a {@link MnemocyteError}.
 */
export function isMnemocyteError(error: unknown): error is MnemocyteError {
	return error instanceof MnemocyteError;
}
