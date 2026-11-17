/**
 * Stable, machine-readable error code attached to every {@link MnemocyteError}.
 *
 * - `"CONFIG"`: invalid configuration, or an embedder that does not match the
 *   installation. Always has a {@link MnemocyteError.reason}.
 * - `"VALIDATION"`: invalid argument passed to a client method.
 * - `"DB"`: Postgres or driver-level failure.
 * - `"EMBEDDING"`: the embedder threw or returned an invalid vector.
 * - `"NOT_FOUND"`: the referenced memory does not exist at the scope.
 * - `"CONFLICT"`: the mutation conflicts with a key or a consolidation link.
 *   Always has a {@link MnemocyteError.reason}.
 * - `"MIGRATION"`: the schema, its metadata or pgvector is not usable.
 *   Always has a {@link MnemocyteError.reason}.
 * - `"TIMEOUT"`: an embedder attempt exceeded `provider.timeoutMs`, or
 *   `extractMemories` exceeded its `timeoutMs`.
 * - `"ABORTED"`: the operation was cancelled via an `AbortSignal`.
 *
 * A minor release may add codes, so a `switch` over them needs a `default`.
 */
export type MnemocyteErrorCode =
	| "CONFIG"
	| "VALIDATION"
	| "DB"
	| "EMBEDDING"
	| "NOT_FOUND"
	| "CONFLICT"
	| "MIGRATION"
	| "TIMEOUT"
	| "ABORTED";

/** The reasons each code that has them may carry. */
interface MnemocyteErrorReasons {
	/**
	 * - `"INVALID_OPTION"`: an option is missing, malformed or unknown, or the
	 *   client or executor is not supported.
	 * - `"DIMENSIONS_MISMATCH"`: the embedder's (or `migrate`'s) dimensions
	 *   differ from the installation's.
	 * - `"MODEL_MISMATCH"`: the embedder's model differs from the one the
	 *   installation recorded.
	 * - `"TEXT_SEARCH_CONFIG_MISMATCH"`: `migrate`'s `textSearchConfig`
	 *   differs from the installation's.
	 * - `"INSTALLATION_ELSEWHERE"`: `migrate` would install into the
	 *   `schemaName` schema while the connection finds an existing
	 *   installation in another schema through `search_path`.
	 */
	CONFIG:
		| "INVALID_OPTION"
		| "DIMENSIONS_MISMATCH"
		| "MODEL_MISMATCH"
		| "TEXT_SEARCH_CONFIG_MISMATCH"
		| "INSTALLATION_ELSEWHERE";
	/**
	 * - `"KEY_IN_USE"`: another memory in the scope already uses the key.
	 * - `"HAS_DEPENDENTS"`: memories are consolidated into one that `delete`
	 *   (with `dependents: "reject"`), `deleteScope` or `prune` would remove.
	 * - `"HIDDEN_DEPENDENTS"`: a memory consolidated into the one being
	 *   deleted is not visible at the call's scope.
	 * - `"CONSOLIDATION_CHANGED"`: the survivor is no longer active, or a
	 *   superseded memory already belongs to another survivor.
	 */
	CONFLICT:
		| "KEY_IN_USE"
		| "HAS_DEPENDENTS"
		| "HIDDEN_DEPENDENTS"
		| "CONSOLIDATION_CHANGED";
	/**
	 * - `"SCHEMA_MISSING"`: Mnemocyte's tables or columns are missing or out
	 *   of date; `migrate` creates or upgrades them.
	 * - `"SCHEMA_UNRECOGNIZED"`: the tables match no migration, or the
	 *   applied versions have gaps.
	 * - `"SCHEMA_NEWER"`: a newer Mnemocyte migrated the database.
	 * - `"INSTALLATION_INVALID"`: the `mnemocyte_meta` installation row is
	 *   missing or holds a value Mnemocyte cannot use.
	 * - `"MIXED_MODELS"`: stored memories hold more than one embedding model.
	 * - `"PGVECTOR_UNAVAILABLE"`: pgvector is missing, older than 0.8.0, or
	 *   cannot be created.
	 * - `"MIGRATION_FAILED"`: a migration failed and was rolled back.
	 */
	MIGRATION:
		| "SCHEMA_MISSING"
		| "SCHEMA_UNRECOGNIZED"
		| "SCHEMA_NEWER"
		| "INSTALLATION_INVALID"
		| "MIXED_MODELS"
		| "PGVECTOR_UNAVAILABLE"
		| "MIGRATION_FAILED";
}

/**
 * Why a `"CONFIG"`, `"CONFLICT"` or `"MIGRATION"` error was thrown; see
 * {@link MnemocyteError.reason}. Each reason belongs to one code:
 *
 * - `"CONFIG"`: `"INVALID_OPTION"`, `"DIMENSIONS_MISMATCH"`,
 *   `"MODEL_MISMATCH"`, `"TEXT_SEARCH_CONFIG_MISMATCH"`,
 *   `"INSTALLATION_ELSEWHERE"`.
 * - `"CONFLICT"`: `"KEY_IN_USE"`, `"HAS_DEPENDENTS"`, `"HIDDEN_DEPENDENTS"`,
 *   `"CONSOLIDATION_CHANGED"`.
 * - `"MIGRATION"`: `"SCHEMA_MISSING"`, `"SCHEMA_UNRECOGNIZED"`,
 *   `"SCHEMA_NEWER"`, `"INSTALLATION_INVALID"`, `"MIXED_MODELS"`,
 *   `"PGVECTOR_UNAVAILABLE"`, `"MIGRATION_FAILED"`.
 *
 * A minor release may add reasons, so a `switch` over them needs a
 * `default`.
 */
export type MnemocyteErrorReason =
	MnemocyteErrorReasons[keyof MnemocyteErrorReasons];

type CodeWithReason = keyof MnemocyteErrorReasons;

/** The `code` and `reason` pairs a {@link MnemocyteErrorInput} accepts. */
type MnemocyteErrorCodeAndReason =
	| {
			[C in CodeWithReason]: {
				readonly code: C;
				readonly reason: MnemocyteErrorReasons[C];
			};
	  }[CodeWithReason]
	| {
			readonly code: Exclude<MnemocyteErrorCode, CodeWithReason>;
			readonly reason?: undefined;
	  };

/**
 * Input accepted by the {@link MnemocyteError} constructor. `"CONFIG"`,
 * `"CONFLICT"` and `"MIGRATION"` require a `reason` of that code; the other
 * codes take none.
 */
export type MnemocyteErrorInput = {
	/** Human-readable error message. */
	readonly message: string;
	/** Underlying cause, if any (driver error, network error, etc.). */
	readonly cause?: unknown;
} & MnemocyteErrorCodeAndReason;

/**
 * Marks Mnemocyte errors. `Symbol.for` returns the same symbol in every copy
 * of the package, so {@link isMnemocyteError} recognizes errors from another
 * installed copy, where `instanceof` fails.
 */
const MNEMOCYTE_ERROR_BRAND: unique symbol = Symbol.for("mnemocyte.error");

/**
 * Error type thrown by every public Mnemocyte API.
 *
 * Branch on {@link MnemocyteError.code} and {@link MnemocyteError.reason},
 * never on the message, and call {@link isMnemocyteError} as a type guard
 * when working with `unknown` errors.
 *
 * @example
 * ```ts
 * import { isMnemocyteError } from "mnemocyte";
 *
 * try {
 *   await memory.update({ scope, id, key: "favorite-color" });
 * } catch (error) {
 *   if (isMnemocyteError(error) && error.reason === "KEY_IN_USE") {
 *     // another memory in this scope already has that key
 *   }
 *   throw error;
 * }
 * ```
 */
export class MnemocyteError extends Error {
	/** Stable, machine-readable failure code. See {@link MnemocyteErrorCode}. */
	readonly code: MnemocyteErrorCode;
	/**
	 * Which case of the code this is. Set on every `"CONFIG"`, `"CONFLICT"`
	 * and `"MIGRATION"` error Mnemocyte throws, `undefined` on the other
	 * codes. See {@link MnemocyteErrorReason}.
	 */
	readonly reason: MnemocyteErrorReason | undefined;
	/** Underlying cause, if any (e.g. an original driver or embedder error). */
	override readonly cause?: unknown;

	/**
	 * @param input - Message, code, reason (required for `"CONFIG"`,
	 * `"CONFLICT"` and `"MIGRATION"`) and optional cause.
	 * @throws {TypeError} When `input` is not an object, as in the
	 * positional `(message, code, cause)` form before 1.0.
	 */
	constructor(input: MnemocyteErrorInput) {
		if (typeof input !== "object" || input === null) {
			throw new TypeError(
				"MnemocyteError takes one object: { message, code, reason?, cause? }.",
			);
		}
		super(input.message);
		this.name = "MnemocyteError";
		this.code = input.code;
		this.reason = input.reason;
		this.cause = input.cause;
	}

	static {
		// On the prototype, so subclasses and every instance carry it without
		// an own property that would show up in logs or `Object.keys`. A
		// static block keeps it part of the class, which bundlers never drop.
		Object.defineProperty(MnemocyteError.prototype, MNEMOCYTE_ERROR_BRAND, {
			value: true,
		});
	}
}

/** Input accepted by the {@link ProviderError} constructor. */
export interface ProviderErrorInput {
	/** Human-readable error message. */
	readonly message: string;
	/** HTTP status of the failed response. */
	readonly status: number;
	/**
	 * Wait the server asked for, in milliseconds, from a `Retry-After` or
	 * `retry-after-ms` header.
	 */
	readonly retryAfterMs?: number | undefined;
	/** The provider's response body: parsed JSON, or text when not JSON. */
	readonly body?: unknown;
}

/**
 * A provider answered an embedding request with a non-2xx status. Thrown by
 * the shipped embedders; custom embedders may throw it too. The code is
 * `"EMBEDDING"`, and `cause` is the provider's response body, which often
 * says what went wrong.
 *
 * Mnemocyte's retries read {@link ProviderError.status} and
 * {@link ProviderError.retryAfterMs}; any error with numeric `status` and
 * `retryAfterMs` fields is treated the same way.
 */
export class ProviderError extends MnemocyteError {
	/** HTTP status of the failed response. */
	readonly status: number;
	/** Wait the server asked for, in milliseconds, if it sent one. */
	readonly retryAfterMs: number | undefined;

	constructor(input: ProviderErrorInput) {
		super({ message: input.message, code: "EMBEDDING", cause: input.body });
		this.name = "ProviderError";
		this.status = input.status;
		this.retryAfterMs = input.retryAfterMs;
	}
}

/**
 * Type guard for {@link MnemocyteError}, including its subclass
 * {@link ProviderError}.
 *
 * It checks a `Symbol.for("mnemocyte.error")` brand rather than
 * `instanceof`, so it also recognizes errors thrown by another installed copy
 * of the package (for example a library that bundles its own Mnemocyte).
 *
 * @param error - Value to test (typically a caught `unknown`).
 * @returns `true` if `error` is a {@link MnemocyteError}.
 */
export function isMnemocyteError(error: unknown): error is MnemocyteError {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { [MNEMOCYTE_ERROR_BRAND]?: unknown })[MNEMOCYTE_ERROR_BRAND] ===
			true
	);
}

/**
 * Type guard for {@link ProviderError}: a provider answered an embedding
 * request with an error status.
 *
 * It checks the same `Symbol.for("mnemocyte.error")` brand as
 * {@link isMnemocyteError}, then the `"EMBEDDING"` code and a numeric
 * `status`, so it also recognizes provider errors thrown by another installed
 * copy of the package, including copies older than this guard.
 *
 * @param error - Value to test (typically a caught `unknown`).
 * @returns `true` if `error` is a {@link ProviderError}.
 *
 * @example
 * ```ts
 * import { isProviderError } from "mnemocyte";
 *
 * try {
 *   await memory.add({ scope, content });
 * } catch (error) {
 *   if (isProviderError(error)) {
 *     console.log(error.status, error.retryAfterMs, error.cause);
 *   }
 *   throw error;
 * }
 * ```
 */
export function isProviderError(error: unknown): error is ProviderError {
	if (!isMnemocyteError(error) || error.code !== "EMBEDDING") {
		return false;
	}
	const { status, retryAfterMs } = error as {
		readonly status?: unknown;
		readonly retryAfterMs?: unknown;
	};
	return (
		typeof status === "number" &&
		(retryAfterMs === undefined || typeof retryAfterMs === "number")
	);
}
