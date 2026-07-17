import {
	createMnemocyte,
	isMnemocyteError,
	type MnemocyteErrorCode,
} from "mnemocyte";
import { beforeEach, describe, expect, test, vi } from "vitest";

const { closeDatabaseMock, postgresMock } = vi.hoisted(() => {
	const closeDatabaseMock = vi.fn(async () => {});
	const postgresClient = Object.assign(vi.fn(), {
		options: {
			parsers: {},
			serializers: {},
		},
		end: closeDatabaseMock,
	});
	return {
		closeDatabaseMock,
		postgresMock: vi.fn(() => postgresClient),
	};
});

vi.mock("postgres", () => ({
	default: postgresMock,
}));

const validEmbedder = {
	model: "config-test",
	dimensions: 2,
	async embed(texts: readonly string[]) {
		return texts.map((text) => [text.length, 1]);
	},
};

const retrievalWeightKeys = [
	"vector",
	"lexical",
	"recency",
	"confidence",
	"access",
	"importance",
] as const;

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
	beforeEach(() => {
		closeDatabaseMock.mockClear();
		postgresMock.mockClear();
	});

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

	test.each([
		"postgres://user:password@localhost:5432/mnemocyte",
		"postgresql://user:password@localhost:5432/mnemocyte",
	])("accepts the Postgres database URL protocol in %s", async (databaseUrl) => {
		const client = createMnemocyte({ databaseUrl, embedder: validEmbedder });

		expect(postgresMock).not.toHaveBeenCalled();
		await client.close();
		expect(postgresMock).toHaveBeenCalledOnce();
		expect(postgresMock).toHaveBeenCalledWith(databaseUrl, expect.any(Object));
		expect(closeDatabaseMock).toHaveBeenCalledOnce();
	});

	test.each([
		"https://example.com/db",
		"http://example.com/db",
		"file:///tmp/mnemocyte.db",
		"relative/path",
		"example.com/db",
	])("rejects non-Postgres database URL %s before creating a handle", (databaseUrl) => {
		expectConfigError(
			() => createMnemocyte({ databaseUrl, embedder: validEmbedder }),
			"CONFIG",
		);
		expect(postgresMock).not.toHaveBeenCalled();
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

	test.each(
		retrievalWeightKeys,
	)("rejects a negative %s retrieval weight as CONFIG", (key) => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: validEmbedder,
					retrieval: { weights: { [key]: -1 } },
				}),
			"CONFIG",
		);
	});

	test.each(
		retrievalWeightKeys,
	)("rejects a non-finite %s retrieval weight as CONFIG", (key) => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: validEmbedder,
					retrieval: { weights: { [key]: Number.NaN } },
				}),
			"CONFIG",
		);
	});

	test("rejects an effective retrieval weight total of zero as CONFIG", () => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: validEmbedder,
					retrieval: {
						weights: {
							vector: 0,
							lexical: 0,
							recency: 0,
							confidence: 0,
							access: 0,
							importance: 0,
						},
					},
				}),
			"CONFIG",
		);
	});

	test.each([
		["recencyHalfLifeDays", 0],
		["recencyHalfLifeDays", -1],
		["recencyHalfLifeDays", Number.POSITIVE_INFINITY],
		["accessSaturation", 0],
		["accessSaturation", -1],
		["accessSaturation", Number.NaN],
	] as const)("rejects invalid %s=%s as CONFIG", (field, value) => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: validEmbedder,
					retrieval: { [field]: value },
				}),
			"CONFIG",
		);
	});

	test.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects candidateMultiplier=%s as CONFIG", (candidateMultiplier) => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: validEmbedder,
					retrieval: { candidateMultiplier },
				}),
			"CONFIG",
		);
	});
});
