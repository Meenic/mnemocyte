import { describe, expect, test } from "vitest";
import {
	formatVector,
	formatVectorComponent,
	parseVector,
} from "../../src/db/vector.js";

describe("pgvector component serialization", () => {
	test.each([Math.PI, 1e-20, -1e-20, 1e20, Number.MIN_VALUE, Number.MAX_VALUE])(
		"round-trips finite value %s",
		(value) => {
			const formatted = formatVectorComponent(value);
			expect(Number(formatted)).toBe(value);
		},
	);

	test("normalizes negative zero", () => {
		expect(formatVectorComponent(-0)).toBe("0");
	});

	test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects non-finite value %s",
		(value) => {
			expect(() => formatVectorComponent(value)).toThrow(
				"Vector values must be finite numbers.",
			);
		},
	);
});

describe("pgvector text form", () => {
	test("formats and parses a vector round trip", () => {
		const embedding = [0.1, -2, 1e-20, 0];
		expect(formatVector(embedding)).toBe("[0.1,-2,1e-20,0]");
		expect(parseVector(formatVector(embedding))).toEqual(embedding);
	});

	test("parses an empty vector", () => {
		expect(parseVector("[]")).toEqual([]);
	});
});
