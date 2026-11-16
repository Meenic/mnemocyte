import {
	isMnemocyteError,
	type MemoryScope,
	type MnemocyteError,
	type MnemocyteErrorCode,
	type MnemocyteErrorReason,
} from "mnemocyte";
import { expect } from "vitest";

/** The reasons each code may carry; codes not listed carry none. */
export const REASONS_BY_CODE: Partial<
	Record<MnemocyteErrorCode, readonly MnemocyteErrorReason[]>
> = {
	CONFIG: [
		"INVALID_OPTION",
		"DIMENSIONS_MISMATCH",
		"MODEL_MISMATCH",
		"TEXT_SEARCH_CONFIG_MISMATCH",
		"INSTALLATION_ELSEWHERE",
	],
	CONFLICT: [
		"KEY_IN_USE",
		"HAS_DEPENDENTS",
		"HIDDEN_DEPENDENTS",
		"CONSOLIDATION_CHANGED",
	],
	MIGRATION: [
		"SCHEMA_MISSING",
		"SCHEMA_UNRECOGNIZED",
		"SCHEMA_NEWER",
		"INSTALLATION_INVALID",
		"MIXED_MODELS",
		"PGVECTOR_UNAVAILABLE",
		"MIGRATION_FAILED",
	],
};

/**
 * Check `error` has `code`, a reason that belongs to it (none for codes
 * without reasons), and `reason` when given.
 */
export function expectErrorReason(
	error: MnemocyteError,
	code: MnemocyteErrorCode,
	reason?: MnemocyteErrorReason,
): void {
	expect(error.code).toBe(code);
	const allowed = REASONS_BY_CODE[code];
	if (allowed === undefined) {
		expect(error.reason).toBeUndefined();
	} else {
		expect(allowed).toContain(error.reason);
	}
	if (reason !== undefined) {
		expect(error.reason).toBe(reason);
	}
}

export async function expectMnemocyteError(
	promise: Promise<unknown>,
	code: MnemocyteErrorCode,
	reason?: MnemocyteErrorReason,
) {
	try {
		await promise;
	} catch (error) {
		expect(isMnemocyteError(error)).toBe(true);
		if (!isMnemocyteError(error)) {
			throw error;
		}
		expectErrorReason(error, code, reason);
		return error;
	}

	throw new Error(`Expected promise to reject with ${code}.`);
}

export function expectDefined<T>(
	value: T,
	message = "Expected value to be defined.",
): NonNullable<T> {
	expect(value, message).toBeDefined();
	if (value === undefined || value === null) {
		throw new Error(message);
	}
	return value;
}

/** The namespace every test scope uses unless a test chooses another. */
export const TEST_NAMESPACE = "test";

/** A scope in {@link TEST_NAMESPACE} for `entityId`. */
export function testScope(
	entityId: string,
	extra: Omit<Partial<MemoryScope>, "entityId"> = {},
): MemoryScope {
	return { namespace: TEST_NAMESPACE, entityId, ...extra };
}
