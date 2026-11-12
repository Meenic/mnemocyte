import {
	isMnemocyteError,
	type MemoryScope,
	type MnemocyteErrorCode,
} from "mnemocyte";
import { expect } from "vitest";

export async function expectMnemocyteError(
	promise: Promise<unknown>,
	code: MnemocyteErrorCode,
) {
	try {
		await promise;
	} catch (error) {
		expect(isMnemocyteError(error)).toBe(true);
		if (!isMnemocyteError(error)) {
			throw error;
		}
		expect(error.code).toBe(code);
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
