import { describe, expect, test } from "vitest";
import { hnswEfSearch } from "../../src/db/queries/memories.js";
import {
	assertPgvectorVersion,
	createPostgresStore,
} from "../../src/memory/postgres.js";
import type { SqlExecutor } from "../../src/sql/executor.js";

interface RecordedQuery {
	sql: string;
	params: readonly unknown[];
	inTransaction: boolean;
}

function createRecordingExecutor(pgvectorVersion: string | null): {
	executor: SqlExecutor;
	queries: RecordedQuery[];
} {
	const queries: RecordedQuery[] = [];
	function executorFor(inTransaction: boolean): SqlExecutor {
		return {
			async query<Row>(sql: string, params: readonly unknown[]) {
				queries.push({ sql, params, inTransaction });
				if (sql.includes("FROM pg_extension")) {
					return (
						pgvectorVersion === null ? [] : [{ version: pgvectorVersion }]
					) as Row[];
				}
				if (sql.includes("FROM mnemocyte_meta")) {
					return [{ vectorType: "vector" }] as Row[];
				}
				return [] as Row[];
			},
			transaction(fn) {
				return fn(executorFor(true));
			},
		};
	}
	return { executor: executorFor(false), queries };
}

const searchInput = {
	entityId: "alice",
	query: "tea",
	embedding: [1, 0, 0],
	types: ["preference" as const],
};

describe("hnswEfSearch", () => {
	test("is at least pgvector's default and the row count", () => {
		expect(hnswEfSearch(1)).toBe(40);
		expect(hnswEfSearch(40)).toBe(40);
		expect(hnswEfSearch(150)).toBe(150);
	});

	test("stays within pgvector's maximum of 1000", () => {
		expect(hnswEfSearch(1000)).toBe(1000);
		expect(hnswEfSearch(5000)).toBe(1000);
	});
});

describe("assertPgvectorVersion", () => {
	test.each(["0.8.0", "0.8.7", "0.9.0", "1.0.0"])("accepts %s", (version) => {
		expect(() => assertPgvectorVersion(version)).not.toThrow();
	});

	test.each([null, "0.7.4", "0.5.1", "unknown"])(
		"rejects %s as a migration error",
		(version) => {
			expect(() => assertPgvectorVersion(version)).toThrow(
				expect.objectContaining({ code: "MIGRATION" }),
			);
		},
	);
});

describe("Postgres vector search", () => {
	test("sets iterative scan and ef_search in the same transaction as the query", async () => {
		const { executor, queries } = createRecordingExecutor("0.8.7");
		const store = createPostgresStore(executor);

		await store.vectorSearch({ ...searchInput, limit: 150 });

		const transactional = queries.filter((query) => query.inTransaction);
		expect(transactional).toHaveLength(2);
		const [settings, search] = transactional;
		expect(settings?.sql).toContain(
			"set_config('hnsw.iterative_scan', 'strict_order', true)",
		);
		expect(settings?.sql).toContain("set_config('hnsw.ef_search', $1, true)");
		expect(settings?.params).toEqual(["150"]);
		expect(search?.sql).toContain('ORDER BY "vectorDistance"');
		expect(search?.sql.match(/<=>/g)).toHaveLength(1);
		expect(search?.params).toContain(150);
	});

	test("checks the pgvector version once per store", async () => {
		const { executor, queries } = createRecordingExecutor("0.8.7");
		const store = createPostgresStore(executor);

		await store.vectorSearch({ ...searchInput, limit: 5 });
		await store.vectorSearch({ ...searchInput, limit: 5 });

		expect(
			queries.filter((query) => query.sql.includes("FROM pg_extension")),
		).toHaveLength(1);
	});

	test("rejects pgvector before 0.8 without searching, and checks again next time", async () => {
		const { executor, queries } = createRecordingExecutor("0.7.4");
		const store = createPostgresStore(executor);

		for (let attempt = 0; attempt < 2; attempt += 1) {
			await expect(
				store.vectorSearch({ ...searchInput, limit: 5 }),
			).rejects.toMatchObject({ code: "MIGRATION" });
		}

		expect(queries.some((query) => query.inTransaction)).toBe(false);
		expect(
			queries.filter((query) => query.sql.includes("FROM pg_extension")),
		).toHaveLength(2);
	});
});
