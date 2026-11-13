import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor, SqlStatement } from "../../src/sql/executor.js";
import { expectDefined } from "../helpers.js";

const DIMENSIONS = 16;
const ROWS = 1500;
const HNSW_INDEX = "mnemocyte_memories_embedding_hnsw_idx";

/** Seeded dense vectors (mulberry32), so the plan is the same every run. */
function vectors(count: number): number[][] {
	let state = 7;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
	};
	return Array.from({ length: count }, () =>
		Array.from({ length: DIMENSIONS }, next),
	);
}

/**
 * The plan of the kNN duplicate query: with a scope that is a large part of
 * the table, each memory's neighbors come from one HNSW index scan ordered by
 * the distance to that memory (`Order By: (embedding <=> a.embedding)`), not
 * from comparing every pair, and that holds under `relaxed_order`, whose
 * setting the planner's cost estimate does not read. Measurements on larger
 * data are in features/maintenance.md.
 */
describe("findDuplicates query plan (PGlite)", () => {
	let db: PGlite;
	const recorded: SqlStatement[] = [];

	/** Records every statement, including those inside a transaction. */
	function recording(inner: SqlExecutor): SqlExecutor {
		const executor: SqlExecutor = {
			query: (sql, params, options) => {
				recorded.push({ sql, params });
				return inner.query(sql, params, options);
			},
		};
		if (inner.transaction) {
			const transaction = inner.transaction.bind(inner);
			executor.transaction = (fn) => transaction((tx) => fn(recording(tx)));
		}
		return executor;
	}

	beforeAll(async () => {
		db = await PGlite.create({ extensions: { vector } });
		await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
	}, 60_000);

	afterAll(async () => {
		await db.close();
	});

	test("uses the HNSW index once per memory", async () => {
		const executor = recording(toSqlExecutor(db));
		const queue = vectors(ROWS);
		const memory = createMemory({
			namespace: "plan",
			store: postgresStore({ client: executor }),
			embedder: {
				model: "knn-plan",
				dimensions: DIMENSIONS,
				async embed(texts) {
					return texts.map(() => expectDefined(queue.shift()));
				},
			},
		});
		await migrate({ memory });
		for (let start = 0; start < ROWS; start += 500) {
			await memory.addMany({
				scope: { entityId: start === 0 ? "small" : "large" },
				memories: Array.from({ length: 500 }, (_, index) => ({
					content: `memory ${start + index}`,
				})),
			});
		}
		await db.exec("ANALYZE mnemocyte_memories;");

		recorded.length = 0;
		await memory.findDuplicates({ scope: { entityId: "large" }, threshold: 0 });
		const settings = expectDefined(
			recorded.find((entry) => entry.sql.includes("hnsw.iterative_scan")),
		);
		expect(settings.sql).toContain(
			"set_config('hnsw.iterative_scan', 'relaxed_order', true)",
		);
		const statement = expectDefined(
			recorded.find((entry) => entry.sql.includes("CROSS JOIN LATERAL")),
		);
		const plan = await db.transaction(async (tx) => {
			await tx.query(settings.sql, [...settings.params]);
			const { rows } = await tx.query<{ "QUERY PLAN": string }>(
				`EXPLAIN (COSTS OFF) ${statement.sql}`,
				[...statement.params],
			);
			return rows.map((row) => row["QUERY PLAN"]).join("\n");
		});
		expect(plan).toContain(`Index Scan using ${HNSW_INDEX}`);
		expect(plan).toMatch(/Order By: \(embedding <=> a(_\d+)?\.embedding\)/);
	}, 120_000);
});
