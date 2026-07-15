import { describe, expect, test } from "vitest";
import { formatVectorComponent } from "../../src/db/vector.js";

describe("pgvector component serialization", () => {
	test("preserves numeric precision", () => {
		expect(formatVectorComponent(Math.PI)).toBe(Math.PI.toFixed(17));
	});

	test("normalizes negative zero", () => {
		expect(formatVectorComponent(-0)).toBe("0");
	});

	test.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	])("rejects non-finite value %s", (value) => {
		expect(() => formatVectorComponent(value)).toThrow(
			"Vector values must be finite numbers.",
		);
	});
});
