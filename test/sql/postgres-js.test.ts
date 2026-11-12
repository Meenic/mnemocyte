import type { Sql } from "postgres";
import { describe, expect, test, vi } from "vitest";
import { postgresJs } from "../../src/sql/postgres-js.js";
import { expectMnemocyteError } from "../helpers.js";

type FakePending = Promise<unknown[]> & {
	cancel(): unknown;
	execute(): FakePending;
};

function pendingQuery(
	result: Promise<unknown[]>,
	cancel: () => unknown = () => {},
	execute: () => void = () => {},
): FakePending {
	const pending: FakePending = Object.assign(result, {
		cancel,
		execute() {
			execute();
			return pending;
		},
	});
	return pending;
}

/**
 * Like postgres.js's `begin` and `savepoint`: an array returned by the
 * callback is awaited with `Promise.all` (pipelined queries).
 */
async function runScope(
	fn: (tx: unknown) => unknown,
	scoped: unknown,
): Promise<unknown> {
	const result = fn(scoped);
	return Array.isArray(result) ? Promise.all(result) : result;
}

/**
 * A postgres.js client of either major. 3.x (and 4.0, which lacks
 * `sql.batch`): the top-level `sql` has `begin`, a transaction's `sql` has
 * `savepoint`. 4.1+: both have `batch`, and a transaction's `sql` also has
 * `begin`, which opens a savepoint.
 */
function createFakeClient(options: {
	unsafe: (sql: string, params: unknown[]) => FakePending;
	major?: 3 | 4;
	batch?: (queries: FakePending[]) => FakePending;
}) {
	const calls: Array<{ sql: string; params: unknown[] }> = [];
	const unsafe = (sql: string, params: unknown[]) => {
		calls.push({ sql, params });
		return options.unsafe(sql, params);
	};
	const batch =
		options.batch ??
		((queries: FakePending[]) => pendingQuery(Promise.all(queries)));
	const scoped = {
		unsafe: vi.fn(unsafe),
		savepoint: vi.fn((fn: (tx: unknown) => unknown) => runScope(fn, scoped)),
		begin: vi.fn((fn: (tx: unknown) => unknown) => runScope(fn, scoped)),
		batch: vi.fn(batch),
	};
	const client = {
		unsafe: vi.fn(unsafe),
		begin: vi.fn((fn: (tx: unknown) => unknown) => runScope(fn, scoped)),
		batch: vi.fn(batch),
	};
	if (options.major !== 4) {
		Reflect.deleteProperty(scoped, "begin");
		Reflect.deleteProperty(scoped, "batch");
		Reflect.deleteProperty(client, "batch");
	}
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

	test("starts the statement in the same tick", () => {
		const execute = vi.fn();
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([]), undefined, execute),
		});

		const result = postgresJs(fake.client).query("SELECT 1", []);

		expect(execute).toHaveBeenCalledOnce();
		return result;
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

	test("batch pipelines every statement inside one begin and returns rows per statement", async () => {
		const fake = createFakeClient({
			unsafe: (sql) => pendingQuery(Promise.resolve([{ sql }])),
		});

		const results = await postgresJs(fake.client).batch([
			{ sql: "SELECT set_config('a', $1, true)", params: ["1"] },
			{ sql: "SELECT 2", params: [] },
		]);

		expect(results).toEqual([
			[{ sql: "SELECT set_config('a', $1, true)" }],
			[{ sql: "SELECT 2" }],
		]);
		expect(fake.raw.begin).toHaveBeenCalledOnce();
		expect(fake.raw.unsafe).not.toHaveBeenCalled();
		expect(fake.calls).toEqual([
			{ sql: "SELECT set_config('a', $1, true)", params: ["1"] },
			{ sql: "SELECT 2", params: [] },
		]);
	});

	test("batch inside a transaction uses a savepoint", async () => {
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([])),
		});

		await postgresJs(fake.client).transaction(async (tx) => {
			await tx.batch([
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT 2", params: [] },
			]);
		});

		expect(fake.raw.begin).toHaveBeenCalledOnce();
		expect(fake.scoped.savepoint).toHaveBeenCalledOnce();
	});

	test("batch rejects with the failing statement's error", async () => {
		const failure = Object.assign(new Error("duplicate"), { code: "23505" });
		const fake = createFakeClient({
			unsafe: (sql) =>
				pendingQuery(
					sql === "SELECT 2" ? Promise.reject(failure) : Promise.resolve([]),
				),
		});

		await expect(
			postgresJs(fake.client).batch([
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT 2", params: [] },
			]),
		).rejects.toBe(failure);
	});

	test("batch cancels its statements when the signal aborts", async () => {
		const controller = new AbortController();
		const rejects: Array<(reason: unknown) => void> = [];
		const cancel = vi.fn(() => {
			for (const reject of rejects) {
				reject(new Error("canceling statement due to user request"));
			}
		});
		const fake = createFakeClient({
			unsafe: () =>
				pendingQuery(
					new Promise<unknown[]>((_resolve, reject) => {
						rejects.push(reject);
					}),
					cancel,
				),
		});

		const result = postgresJs(fake.client).batch(
			[
				{ sql: "SELECT pg_sleep(60)", params: [] },
				{ sql: "SELECT 2", params: [] },
			],
			{ signal: controller.signal },
		);
		await vi.waitFor(() => expect(rejects).toHaveLength(2));
		controller.abort();

		await expectMnemocyteError(result, "ABORTED");
		expect(cancel).toHaveBeenCalledTimes(2);
	});

	test("batch does not begin when the signal is already aborted", async () => {
		const fake = createFakeClient({
			unsafe: () => pendingQuery(Promise.resolve([])),
		});

		await expectMnemocyteError(
			postgresJs(fake.client).batch([{ sql: "SELECT 1", params: [] }], {
				signal: AbortSignal.abort(),
			}),
			"ABORTED",
		);
		expect(fake.raw.begin).not.toHaveBeenCalled();
	});

	test("a cancel request that rejects is not left unhandled", async () => {
		// postgres.js 4 returns the cancel request's promise, which rejects
		// when the server never answers it (CANCEL_UNANSWERED).
		const controller = new AbortController();
		let rejectQuery: (reason: unknown) => void = () => {};
		// A plain function: a vi.fn would handle the promise it returns.
		let cancels = 0;
		const cancel = () => {
			cancels += 1;
			rejectQuery(new Error("CONNECTION_DESTROYED"));
			return Promise.reject(new Error("CANCEL_UNANSWERED"));
		};
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
		expect(cancels).toBe(1);
		// Vitest fails the run on an unhandled rejection; give it a turn.
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});

describe("postgresJs executor on postgres.js 4.1+", () => {
	test("batch sends one sql.batch outside a transaction", async () => {
		const fake = createFakeClient({
			major: 4,
			unsafe: (sql) => pendingQuery(Promise.resolve([{ sql }])),
		});

		const results = await postgresJs(fake.client).batch([
			{ sql: "SELECT set_config('a', $1, true)", params: ["1"] },
			{ sql: "SELECT 2", params: [] },
		]);

		expect(results).toEqual([
			[{ sql: "SELECT set_config('a', $1, true)" }],
			[{ sql: "SELECT 2" }],
		]);
		expect(fake.raw.batch).toHaveBeenCalledOnce();
		expect(fake.raw.batch.mock.calls[0]?.[0]).toHaveLength(2);
		expect(fake.raw.begin).not.toHaveBeenCalled();
		expect(fake.calls).toEqual([
			{ sql: "SELECT set_config('a', $1, true)", params: ["1"] },
			{ sql: "SELECT 2", params: [] },
		]);
	});

	test("batch inside a transaction keeps the savepoint", async () => {
		const fake = createFakeClient({
			major: 4,
			unsafe: () => pendingQuery(Promise.resolve([])),
		});

		await postgresJs(fake.client).transaction(async (tx) => {
			await tx.batch([
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT 2", params: [] },
			]);
			await tx.transaction(async (inner) => {
				await inner.query("SELECT 3", []);
			});
		});

		expect(fake.raw.begin).toHaveBeenCalledOnce();
		expect(fake.scoped.savepoint).toHaveBeenCalledTimes(2);
		expect(fake.scoped.begin).not.toHaveBeenCalled();
		expect(fake.scoped.batch).not.toHaveBeenCalled();
		expect(fake.raw.batch).not.toHaveBeenCalled();
	});

	test("batch rejects with the driver's error", async () => {
		const failure = Object.assign(new Error("duplicate"), {
			code: "23505",
			index: 1,
		});
		const fake = createFakeClient({
			major: 4,
			unsafe: () => pendingQuery(Promise.resolve([])),
			batch: () => pendingQuery(Promise.reject(failure)),
		});

		await expect(
			postgresJs(fake.client).batch([
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT 2", params: [] },
			]),
		).rejects.toBe(failure);
	});

	test("batch cancels the sql.batch when the signal aborts", async () => {
		const controller = new AbortController();
		let rejectBatch: (reason: unknown) => void = () => {};
		let cancels = 0;
		const cancel = () => {
			cancels += 1;
			rejectBatch(new Error("canceling statement due to user request"));
			return Promise.reject(new Error("CANCEL_UNANSWERED"));
		};
		const execute = vi.fn();
		const fake = createFakeClient({
			major: 4,
			unsafe: () => pendingQuery(Promise.resolve([])),
			batch: () =>
				pendingQuery(
					new Promise<unknown[]>((_resolve, reject) => {
						rejectBatch = reject;
					}),
					cancel,
					execute,
				),
		});

		const result = postgresJs(fake.client).batch(
			[{ sql: "SELECT pg_sleep(60)", params: [] }],
			{ signal: controller.signal },
		);
		expect(execute).toHaveBeenCalledOnce();
		controller.abort();

		await expectMnemocyteError(result, "ABORTED");
		expect(cancels).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});
