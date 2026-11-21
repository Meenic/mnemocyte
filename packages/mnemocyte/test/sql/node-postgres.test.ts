import { describe, expect, test } from "vitest";
import { nodePostgresExecutor } from "../../src/sql/node-postgres.js";
import { pgliteExecutor } from "../../src/sql/pglite.js";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

/**
 * A pool whose one client records every statement and can be told to fail
 * statements that match a pattern.
 */
function createFakePool(failOn: RegExp[] = []) {
	const log: string[] = [];
	const releases: boolean[] = [];
	const run = async (text: string) => {
		log.push(text);
		if (failOn.some((pattern) => pattern.test(text))) {
			throw new Error(`failed: ${text}`);
		}
		return { rows: [{ text }] };
	};
	const pool = {
		totalCount: 1,
		query: async (text: string) => run(`pool: ${text}`),
		connect: async () => ({
			query: (text: string) => run(text),
			release: (destroy?: boolean) => {
				releases.push(destroy ?? false);
			},
		}),
	};
	return { pool, log, releases };
}

describe("node-postgres executor", () => {
	test("query runs on the pool and returns rows", async () => {
		const { pool, log } = createFakePool();
		const executor = nodePostgresExecutor(pool);
		await expect(executor.query("SELECT 1", [])).resolves.toEqual([
			{ text: "pool: SELECT 1" },
		]);
		expect(log).toEqual(["pool: SELECT 1"]);
	});

	test("a transaction runs on one checked-out client and releases it", async () => {
		const { pool, log, releases } = createFakePool();
		const executor = nodePostgresExecutor(pool);
		const transaction = expectDefined(executor.transaction);
		await transaction.call(executor, async (tx) => {
			await tx.query("INSERT 1", []);
			await expectDefined(tx.transaction).call(tx, async (inner) => {
				await inner.query("INSERT 2", []);
			});
		});
		expect(log).toEqual([
			"BEGIN",
			"INSERT 1",
			"SAVEPOINT mnemocyte_savepoint_1",
			"INSERT 2",
			"RELEASE SAVEPOINT mnemocyte_savepoint_1",
			"COMMIT",
		]);
		expect(releases).toEqual([false]);
	});

	test("a failure rolls back, rethrows and returns the client", async () => {
		const { pool, log, releases } = createFakePool([/^INSERT/]);
		const executor = nodePostgresExecutor(pool);
		await expect(
			expectDefined(executor.transaction).call(executor, (tx) =>
				tx.query("INSERT 1", []),
			),
		).rejects.toThrow("failed: INSERT 1");
		expect(log).toEqual(["BEGIN", "INSERT 1", "ROLLBACK"]);
		expect(releases).toEqual([false]);
	});

	test("a client whose ROLLBACK failed is destroyed", async () => {
		const { pool, releases } = createFakePool([/^INSERT/, /^ROLLBACK/]);
		const executor = nodePostgresExecutor(pool);
		await expect(
			expectDefined(executor.transaction).call(executor, (tx) =>
				tx.query("INSERT 1", []),
			),
		).rejects.toThrow("failed: INSERT 1");
		expect(releases).toEqual([true]);
	});

	test("a failed savepoint rolls back to it and the outer transaction goes on", async () => {
		const { pool, log } = createFakePool([/^INSERT 2/]);
		const executor = nodePostgresExecutor(pool);
		await expectDefined(executor.transaction).call(executor, async (tx) => {
			await expect(
				expectDefined(tx.transaction).call(tx, (inner) =>
					inner.query("INSERT 2", []),
				),
			).rejects.toThrow("failed: INSERT 2");
			await tx.query("INSERT 3", []);
		});
		expect(log).toEqual([
			"BEGIN",
			"SAVEPOINT mnemocyte_savepoint_1",
			"INSERT 2",
			"ROLLBACK TO SAVEPOINT mnemocyte_savepoint_1",
			"INSERT 3",
			"COMMIT",
		]);
	});

	test("an aborted signal stops the next statement", async () => {
		const { pool, log } = createFakePool();
		const executor = nodePostgresExecutor(pool);
		const controller = new AbortController();
		controller.abort();
		await expectMnemocyteError(
			executor.query("SELECT 1", [], { signal: controller.signal }),
			"ABORTED",
		);
		expect(log).toEqual([]);
	});
});

describe("PGlite executor", () => {
	test("query returns rows and a transaction uses db.transaction", async () => {
		const log: string[] = [];
		const tx = {
			query: async (text: string) => {
				log.push(`tx: ${text}`);
				return { rows: [] };
			},
		};
		const db = {
			query: async (text: string, params?: unknown[]) => {
				log.push(`db: ${text} ${JSON.stringify(params)}`);
				return { rows: [{ ok: true }] };
			},
			exec: async () => [],
			transaction: async <T>(fn: (scoped: typeof tx) => Promise<T>) => fn(tx),
		};
		const executor = pgliteExecutor(db);
		await expect(executor.query("SELECT $1", [1])).resolves.toEqual([
			{ ok: true },
		]);
		await expectDefined(executor.transaction).call(executor, async (scoped) => {
			await scoped.query("INSERT 1", []);
			await expectDefined(scoped.transaction).call(scoped, (inner) =>
				inner.query("INSERT 2", []),
			);
		});
		expect(log).toEqual([
			"db: SELECT $1 [1]",
			"tx: INSERT 1",
			"tx: SAVEPOINT mnemocyte_savepoint_1",
			"tx: INSERT 2",
			"tx: RELEASE SAVEPOINT mnemocyte_savepoint_1",
		]);
	});
});
