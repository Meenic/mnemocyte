import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory, type MemoryClient, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor, SqlStatement } from "../../src/sql/executor.js";
import { verifyAuditRetention } from "../fixtures/audit-retention.js";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

const EVENTS_INDEX = "mnemocyte_events_scope_time_idx";

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `pruneAuditLog` on a PGlite of its own, so `allNamespaces` cannot reach
 * another suite's events: the shared fixture, an abort between batches, and
 * the plan of one batch at an entity scope.
 */
describe("pruneAuditLog (PGlite)", () => {
	let db: PGlite;
	const recorded: SqlStatement[] = [];
	/** Called after each statement, with its SQL. */
	let afterStatement: (sql: string) => void = () => {};

	function recording(inner: SqlExecutor): SqlExecutor {
		const executor: SqlExecutor = {
			query<Row>(
				sql: string,
				params: readonly unknown[],
				options?: Parameters<SqlExecutor["query"]>[2],
			) {
				recorded.push({ sql, params });
				return inner.query<Row>(sql, params, options).then((rows) => {
					afterStatement(sql);
					return rows;
				});
			},
		};
		if (inner.transaction) {
			const transaction = inner.transaction.bind(inner);
			executor.transaction = (fn) => transaction((tx) => fn(recording(tx)));
		}
		return executor;
	}

	function client(): MemoryClient {
		return createMemory({
			store: postgresStore({ client: recording(toSqlExecutor(db)) }),
			embedder: {
				model: "audit-retention",
				dimensions: 3,
				async embed(texts) {
					return texts.map(() => [1, 0, 0]);
				},
			},
			audit: { enabled: true },
		});
	}

	beforeAll(async () => {
		db = await PGlite.create({ extensions: { vector } });
		await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
		await migrate({ memory: client() });
	}, 60_000);

	afterAll(async () => {
		await db.close();
	});

	test("follows the shared fixture with allNamespaces", async () => {
		await verifyAuditRetention({
			client: client(),
			scopeFor: (entityId, extra = {}) => ({
				namespace: "retention",
				entityId,
				...extra,
			}),
			otherScopeFor: (entityId, extra = {}) => ({
				namespace: "retention_other",
				entityId,
				...extra,
			}),
			allNamespaces: true,
		});
	}, 60_000);

	test("an abort between batches keeps the committed batches", async () => {
		const memory = client();
		const scope = { namespace: "abort", entityId: "user" };
		await memory.addMany({
			scope,
			memories: Array.from({ length: 5 }, (_, index) => ({
				content: `Memory ${index}.`,
			})),
		});
		await pause(5);
		const before = new Date();
		const controller = new AbortController();
		afterStatement = (sql) => {
			if (sql.includes("DELETE FROM mnemocyte_events")) {
				controller.abort();
			}
		};
		try {
			await expectMnemocyteError(
				memory.pruneAuditLog({
					scope,
					before,
					batchSize: 2,
					signal: controller.signal,
				}),
				"ABORTED",
			);
		} finally {
			afterStatement = () => {};
		}
		expect(await memory.listAuditLog({ scope })).toHaveLength(3);
	});

	/** The plan of a recorded statement, without running it. */
	async function planOf(statement: SqlStatement): Promise<string> {
		const { rows } = await db.query<{ "QUERY PLAN": string }>(
			`EXPLAIN (COSTS OFF) ${statement.sql}`,
			[...statement.params],
		);
		return rows.map((row) => row["QUERY PLAN"]).join("\n");
	}

	/**
	 * Batches walk the scope index in order and resume after the previous
	 * batch's last event (a row comparison in the index condition), with no
	 * sort and no sequential scan, at an entity scope and across namespaces.
	 * Measurements on larger data are in features/maintenance.md.
	 */
	test("batches resume along the scope index", async () => {
		await db.exec(`
			INSERT INTO mnemocyte_events (id, namespace, entity_id, description, metadata, timestamp)
			SELECT gen_random_uuid(), 'plan_' || (g % 2), 'entity_' || (g % 200),
				'memory.created', '{}'::jsonb, now() - g * interval '1 minute'
			FROM generate_series(1, 20000) AS g;
			ANALYZE mnemocyte_events;
		`);
		const memory = client();
		const before = new Date(Date.now() - 24 * 3600 * 1000);
		const remaining = async (where: string) => {
			const { rows } = await db.query<{ count: number }>(
				`SELECT count(*)::int AS count FROM mnemocyte_events
				WHERE ${where} AND timestamp < $1::timestamptz`,
				[before.toISOString()],
			);
			return expectDefined(rows[0]).count;
		};
		const index = new RegExp(
			`(Index (Only )?Scan using|Bitmap Index Scan on) ${EVENTS_INDEX}`,
		);

		for (const [input, where, resume] of [
			[
				{ scope: { namespace: "plan_1", entityId: "entity_1" }, batchSize: 10 },
				"namespace = 'plan_1' AND entity_id = 'entity_1'",
				/ROW\("timestamp", id\) >/,
			],
			[
				{ scope: { namespace: "plan_0" }, batchSize: 200 },
				"namespace = 'plan_0'",
				/ROW\(entity_id, "timestamp", id\) >/,
			],
			[
				{ allNamespaces: true as const, batchSize: 500 },
				"TRUE",
				/ROW\(namespace, entity_id, "timestamp", id\) >/,
			],
		] as const) {
			const matched = await remaining(where);
			recorded.length = 0;
			const result = await memory.pruneAuditLog({ ...input, before });
			expect(result.deletedCount).toBe(matched);
			expect(result.deletedCount).toBeGreaterThan(input.batchSize);
			expect(await remaining(where)).toBe(0);
			const batches = recorded.filter((entry) =>
				entry.sql.includes("DELETE FROM mnemocyte_events"),
			);
			expect(batches.length).toBe(Math.floor(matched / input.batchSize) + 1);
			// The batch step reads the scope index in order from the previous
			// batch's last event. How the delete finds the rows by id (primary
			// key lookups, or a hash join on a table this small) is the
			// planner's cost choice; only the top-1 pick of the batch's last
			// row, over at most `batchSize` materialized rows, sorts.
			const plan = await planOf(expectDefined(batches[1]));
			const batchStep = plan.slice(
				plan.indexOf("CTE batch"),
				plan.indexOf("CTE deleted"),
			);
			expect(batchStep).toMatch(index);
			expect(batchStep).toMatch(resume);
			expect(batchStep).toContain("Limit");
			expect(batchStep).not.toContain("Seq Scan");
			expect(batchStep).not.toContain("Sort");
		}
	}, 60_000);
});
