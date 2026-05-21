import { isMnemocyteError, type MnemocyteErrorCode } from "mnemocyte";
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
