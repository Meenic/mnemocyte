import type { Sql } from "postgres";
import { describe, expect, test, vi } from "vitest";
import { postgresJs } from "../../src/sql/postgres-js.js";
import { expectMnemocyteError } from "../helpers.js";

type FakePending = Promise<unknown[]> & { cancel(): void };

function pendingQuery(
	result: Promise<unknown[]>,
	cancel: () => void = () => {},
): FakePending {
	return Object.assign(result, { cancel });
}

function createFakeClient(options: {
	unsafe: (sql: string, params: unknown[]) => FakePending;
}) {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const scoped = {
		unsafe: vi.fn((sql: string, params: unknown[]) => {
			calls.push({ sql, params });
			return options.unsafe(sql, params);
		}),
		savepoint: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
			fn(scoped),
		),
	};
	const client = {
		unsafe: vi.fn((sql: string, params: unknown[]) => {
			calls.push({ sql, params });
			return options.unsafe(sql, params);
		}),
		begin: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(scoped)),
	};
	return { client: client as unknown as Sql, raw: client, scoped, calls };
}

describe("postgresJs executor", () => {
	test("runs a statement with positional parameters and returns the rows", async () => {
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([{ id: "a" }])),
		});

		const rows = await postgresJs(fake.client).query(
			"SELECT id FROM t WHERE id = $1",
			["a"],
		);

		expect(rows).toEqual([{ id: "a" }]);
		expect(fake.calls).toEqual([
			{ sql: "SELECT id FROM t WHERE id = $1", params: ["a"] },
		]);
	});

	test("cancels the running statement when the signal aborts", async () => {
		const controller = new AbortController();
		let rejectQuery: (reason: unknown) => void = () => {};
		const cancel = vi.fn(() => {
			rejectQuery(new Error("canceling statement due to user request"));
		});
		const fake = createFakeClient({
			unsafe: () =>
				pendingQuery(
					new Promise<unknown[]>((_resolve, reject) => {
						rejectQuery = reject;
					}),
					cancel,
				),
		});

		const result = postgresJs(fake.client).query("SELECT pg_sleep(60)", [], {
			signal: controller.signal,
		});
		controller.abort();

		await expectMnemocyteError(result, "ABORTED");
		expect(cancel).toHaveBeenCalledOnce();
	});

	test("does not start a statement when the signal is already aborted", async () => {
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([])),
		});

		await expectMnemocyteError(
			postgresJs(fake.client).query("SELECT 1", [], {
				signal: AbortSignal.abort(),
			}),
			"ABORTED",
		);
		expect(fake.raw.unsafe).not.toHaveBeenCalled();
	});

	test("rethrows driver errors unchanged when not aborted", async () => {
		const failure = Object.assign(new Error("boom"), { code: "42P01" });
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.reject(failure)),
		});

		await expect(
			postgresJs(fake.client).query("SELECT 1", [], {
				signal: new AbortController().signal,
			}),
		).rejects.toBe(failure);
	});

	test("runs a transaction on the scoped client and returns its result", async () => {
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([])),
		});

		const result = await postgresJs(fake.client).transaction(async (tx) => {
			await tx.query("UPDATE t SET a = $1", [1]);
			return "done";
		});

		expect(result).toBe("done");
		expect(fake.raw.begin).toHaveBeenCalledOnce();
		expect(fake.raw.unsafe).not.toHaveBeenCalled();
		expect(fake.scoped.unsafe).toHaveBeenCalledOnce();
	});

	test("opens a savepoint for a transaction inside a transaction", async () => {
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([])),
		});

		await postgresJs(fake.client).transaction(async (tx) => {
			await tx.transaction(async (inner) => {
				await inner.query("SELECT 1", []);
			});
		});

		expect(fake.raw.begin).toHaveBeenCalledOnce();
		expect(fake.scoped.savepoint).toHaveBeenCalledOnce();
	});

	test("propagates a transaction failure so postgres.js rolls back", async () => {
		const failure = new Error("rollback me");
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([])),
		});

		await expect(
			postgresJs(fake.client).transaction(async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
	});
});
