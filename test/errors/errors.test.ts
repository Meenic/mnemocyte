import {
	isMnemocyteError,
	isProviderError,
	MnemocyteError,
	ProviderError,
} from "mnemocyte";
import { describe, expect, test } from "vitest";

describe("MnemocyteError", () => {
	test("carries the code, reason and cause it was given", () => {
		const cause = new Error("duplicate key");
		const error = new MnemocyteError({
			message: "Key in use.",
			code: "CONFLICT",
			reason: "KEY_IN_USE",
			cause,
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("MnemocyteError");
		expect(error.message).toBe("Key in use.");
		expect(error.code).toBe("CONFLICT");
		expect(error.reason).toBe("KEY_IN_USE");
		expect(error.cause).toBe(cause);
	});

	test("has no reason on codes that take none", () => {
		const error = new MnemocyteError({ message: "Slow.", code: "TIMEOUT" });
		expect(error.reason).toBeUndefined();
		expect(new ProviderError({ message: "Busy.", status: 503 }).reason).toBe(
			undefined,
		);
	});

	test("rejects the positional form with a TypeError", () => {
		const Positional = MnemocyteError as unknown as new (
			message: string,
			code: string,
		) => MnemocyteError;
		expect(() => new Positional("Key in use.", "CONFLICT")).toThrow(TypeError);
	});

	test("keeps the brand off the instance's own keys", () => {
		const error = new MnemocyteError({
			message: "Bad option.",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
		expect(Object.getOwnPropertySymbols(error)).toEqual([]);
		expect(Object.getOwnPropertySymbols(MnemocyteError.prototype)).toContain(
			Symbol.for("mnemocyte.error"),
		);
	});
});

describe("isMnemocyteError", () => {
	test("recognizes Mnemocyte errors and their subclasses", () => {
		expect(
			isMnemocyteError(new MnemocyteError({ message: "x", code: "DB" })),
		).toBe(true);
		expect(
			isMnemocyteError(new ProviderError({ message: "x", status: 500 })),
		).toBe(true);
	});

	test("recognizes an error carrying the brand of another copy", () => {
		// What a second installed copy's class produces: same Symbol.for key,
		// a different prototype chain.
		class OtherCopyError extends Error {
			readonly code = "DB";
		}
		Object.defineProperty(
			OtherCopyError.prototype,
			Symbol.for("mnemocyte.error"),
			{ value: true },
		);
		const foreign = new OtherCopyError("from another copy");
		expect(foreign instanceof MnemocyteError).toBe(false);
		expect(isMnemocyteError(foreign)).toBe(true);
	});

	test("rejects look-alikes without the brand", () => {
		expect(isMnemocyteError(new Error("x"))).toBe(false);
		expect(
			isMnemocyteError({ name: "MnemocyteError", code: "DB", message: "x" }),
		).toBe(false);
		expect(isMnemocyteError(null)).toBe(false);
		expect(isMnemocyteError("MnemocyteError")).toBe(false);
	});
});

describe("isProviderError", () => {
	test("recognizes a ProviderError", () => {
		const error = new ProviderError({
			message: "Busy.",
			status: 503,
			retryAfterMs: 1000,
		});
		expect(isProviderError(error)).toBe(true);
		expect(
			isProviderError(new ProviderError({ message: "Bad.", status: 400 })),
		).toBe(true);
	});

	test("rejects a plain MnemocyteError, even with the EMBEDDING code", () => {
		expect(
			isProviderError(new MnemocyteError({ message: "x", code: "EMBEDDING" })),
		).toBe(false);
		expect(
			isProviderError(new MnemocyteError({ message: "x", code: "DB" })),
		).toBe(false);
	});

	test("recognizes a provider error carrying the brand of another copy", () => {
		class OtherCopyProviderError extends Error {
			readonly code = "EMBEDDING";
			readonly status = 429;
			readonly retryAfterMs = undefined;
		}
		Object.defineProperty(
			OtherCopyProviderError.prototype,
			Symbol.for("mnemocyte.error"),
			{ value: true },
		);
		const foreign = new OtherCopyProviderError("from another copy");
		expect(foreign instanceof ProviderError).toBe(false);
		expect(isProviderError(foreign)).toBe(true);
	});

	test("rejects look-alikes without the brand or the fields", () => {
		expect(
			isProviderError({
				name: "ProviderError",
				code: "EMBEDDING",
				status: 503,
				message: "x",
			}),
		).toBe(false);
		class BadFields extends Error {
			readonly code = "EMBEDDING";
			readonly status: unknown = "503";
			readonly retryAfterMs: unknown = undefined;
		}
		Object.defineProperty(BadFields.prototype, Symbol.for("mnemocyte.error"), {
			value: true,
		});
		expect(isProviderError(new BadFields("x"))).toBe(false);
		const badWait = new BadFields("x");
		Object.assign(badWait, { status: 503, retryAfterMs: "1000" });
		expect(isProviderError(badWait)).toBe(false);
		expect(isProviderError(new Error("x"))).toBe(false);
		expect(isProviderError(null)).toBe(false);
		expect(isProviderError("ProviderError")).toBe(false);
	});
});
