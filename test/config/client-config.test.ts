import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
	createMnemocyte,
	isMnemocyteError,
	type MnemocyteErrorCode,
	type MnemocyteStoreConfig,
} from "mnemocyte";
import { postgresStore, type SqlExecutor } from "mnemocyte/postgres";
import { drizzleStore } from "mnemocyte/stores/drizzle";
import { describe, expect, test } from "vitest";

const validEmbedder = {
	model: "config-test",
	dimensions: 2,
	async embed(texts: readonly string[]) {
		return texts.map((text) => [text.length, 1]);
	},
};

const retrievalNumberFields = [
	["fusion", "k"],
	["fusion", "vector"],
	["fusion", "lexical"],
	["boosts", "recency"],
	["boosts", "importance"],
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
	test("uses in-memory storage when no store is supplied", async () => {
		const client = createMnemocyte({ embedder: validEmbedder });
		const memory = await client.remember({
			entityId: "config_in_memory",
			content: "No store configuration still uses in-memory storage.",
		});
		expect(memory.entityId).toBe("config_in_memory");
		await client.close();
	});

	test("uses a Postgres store without touching the caller's client on close", async () => {
		let queryCount = 0;
		const executor: SqlExecutor = {
			async query() {
				queryCount += 1;
				return [];
			},
			async transaction(fn) {
				return fn(executor);
			},
		};
		const client = createMnemocyte({
			store: postgresStore({ client: executor }),
			embedder: validEmbedder,
		});

		await client.close();
		expect(queryCount).toBe(0);
	});

	test("rejects a store that was not created by an adapter as CONFIG", async () => {
		const client = () =>
			createMnemocyte({
				store: {} as MnemocyteStoreConfig,
				embedder: validEmbedder,
			});
		expectConfigError(client, "CONFIG");
	});

	test("rejects a Drizzle instance without a postgres.js client as CONFIG", () => {
		expectConfigError(
			() => drizzleStore({} as PostgresJsDatabase<Record<string, unknown>>),
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

	test.each(
		retrievalNumberFields.flatMap(([group, key]) =>
			[-1, Number.NaN, Number.POSITIVE_INFINITY].map(
				(value) => [group, key, value] as const,
			),
		),
	)("rejects retrieval.%s.%s=%s as CONFIG", (group, key, value) => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: validEmbedder,
					retrieval: { [group]: { [key]: value } },
				}),
			"CONFIG",
		);
	});

	test("accepts zero for any single fusion weight, k or boost", () => {
		for (const [group, key] of retrievalNumberFields) {
			createMnemocyte({
				embedder: validEmbedder,
				retrieval: { [group]: { [key]: 0 } },
			});
		}
	});

	test("rejects zero weight on both fusion lists as CONFIG", () => {
		expectConfigError(
			() =>
				createMnemocyte({
					embedder: validEmbedder,
					retrieval: { fusion: { vector: 0, lexical: 0 } },
				}),
			"CONFIG",
		);
	});

	test.each([
		["recencyHalfLifeDays", 0],
		["recencyHalfLifeDays", -1],
		["recencyHalfLifeDays", Number.POSITIVE_INFINITY],
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

	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects candidateMultiplier=%s as CONFIG",
		(candidateMultiplier) => {
			expectConfigError(
				() =>
					createMnemocyte({
						embedder: validEmbedder,
						retrieval: { candidateMultiplier },
					}),
				"CONFIG",
			);
		},
	);
});
