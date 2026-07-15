import {
	createMnemocyte,
	isMnemocyteError,
	type MnemocyteErrorCode,
} from "mnemocyte";
import { describe, expect, test } from "vitest";

const validEmbedder = {
	model: "config-test",
	dimensions: 2,
	async embed(texts: readonly string[]) {
		return texts.map((text) => [text.length, 1]);
	},
};

function expectConfigError(action: () => unknown, code: MnemocyteErrorCode) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}

	expect(isMnemocyteError(thrown)).toBe(true);
	if (!isMnemocyteError(thrown)) {
		throw thrown ?? new Error(`Expected ${code} configuration error.`);
	}
	expect(thrown.code).toBe(code);
}

describe("client configuration", () => {
	test("rejects an explicitly empty databaseUrl", () => {
		expectConfigError(
			() => createMnemocyte({ databaseUrl: "", embedder: validEmbedder }),
			"VALIDATION",
		);
	});

	test("wraps a malformed databaseUrl as CONFIG", () => {
		expectConfigError(
			() =>
				createMnemocyte({
					databaseUrl: "not a postgres URL",
					embedder: validEmbedder,
				}),
			"CONFIG",
		);
	});

	test("classifies an empty embedder model as CONFIG", () => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: { ...validEmbedder, model: " " },
				}),
			"CONFIG",
		);
	});
});
