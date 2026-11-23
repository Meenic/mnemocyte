import { postgresStore } from "mnemocyte/postgres";
import { describe, expect, test, vi } from "vitest";
import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { postgresJs } from "../../src/sql/postgres-js.js";
import { expectMnemocyteError } from "../helpers.js";

/** A function with postgres.js's `unsafe` and `begin`, nothing else. */
function fakePostgresJs() {
	const unsafe = vi.fn(() => {
		const pending = Promise.resolve([{ via: "postgres.js" }]);
		return Object.assign(pending, {
			cancel() {},
			execute: () => pending,
		});
	});
	return Object.assign(() => undefined, { unsafe, begin: vi.fn() });
}

function fakePGlite() {
	return {
		query: vi.fn(async () => ({ rows: [{ via: "pglite" }], fields: [] })),
		exec: vi.fn(async () => []),
		transaction: vi.fn(),
	};
}

function fakePool() {
	return {
		query: vi.fn(async () => ({ rows: [{ via: "pg" }], rowCount: 1 })),
		connect: vi.fn(),
		totalCount: 0,
		idleCount: 0,
		waitingCount: 0,
	};
}

/**
 * A function with Neon's HTTP `query`, `unsafe` and `transaction` (1.x).
 * Its queries are lazy, as the driver's are: nothing runs until awaited.
 */
function fakeNeon() {
	const query = vi.fn((text: string) => ({
		text,
		// biome-ignore lint/suspicious/noThenProperty: the driver's queries are thenables
		then: (resolve: (rows: unknown[]) => unknown) => resolve([{ via: "neon" }]),
	}));
	const transaction = vi.fn(
		async (queries: { text: string }[], _options?: unknown) =>
			queries.map((item) => [{ via: "neon", text: item.text }]),
	);
	return Object.assign(() => undefined, {
		query,
		unsafe: vi.fn(),
		transaction,
	});
}

function fakePgClient() {
	return { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
}

async function via(client: unknown): Promise<unknown> {
	const rows = await toSqlExecutor(client).query("SELECT 1", []);
	return rows[0];
}

function expectConfig(run: () => unknown, message: RegExp): void {
	try {
		run();
	} catch (error) {
		expect(error).toMatchObject({ code: "CONFIG" });
		expect(String((error as Error).message)).toMatch(message);
		return;
	}
	throw new Error("Expected a CONFIG error.");
}

describe("client detection", () => {
	test("recognises each driver by shape", async () => {
		await expect(via(fakePostgresJs())).resolves.toEqual({
			via: "postgres.js",
		});
		await expect(via(fakePGlite())).resolves.toEqual({ via: "pglite" });
		await expect(via(fakePool())).resolves.toEqual({ via: "pg" });
		await expect(via(fakeNeon())).resolves.toEqual({ via: "neon" });
	});

	test("maps Neon's HTTP function to query plus batch, without transaction", async () => {
		const sql = fakeNeon();
		const executor = toSqlExecutor(sql);
		expect(executor.transaction).toBeUndefined();
		await executor.query("SELECT $1", ["a"]);
		expect(sql.query).toHaveBeenCalledWith("SELECT $1", ["a"], {
			arrayMode: false,
			fullResults: false,
		});
		const batch = executor.batch;
		if (!batch) {
			throw new Error("Expected batch.");
		}
		const signal = new AbortController().signal;
		await expect(
			batch(
				[
					{ sql: "SELECT 1", params: [] },
					{ sql: "SELECT 2", params: [] },
				],
				{ signal },
			),
		).resolves.toEqual([
			[{ via: "neon", text: "SELECT 1" }],
			[{ via: "neon", text: "SELECT 2" }],
		]);
		expect(sql.transaction).toHaveBeenCalledTimes(1);
		expect(sql.transaction.mock.calls[0]?.[1]).toEqual({
			arrayMode: false,
			fullResults: false,
			fetchOptions: { signal },
		});
	});

	test("recognises postgres.js 3.x and 4.x sql functions and rejects a reserved one", async () => {
		const unsafe = fakePostgresJs().unsafe;
		const fn = () => Object.assign(() => undefined, { unsafe });
		// The top-level `sql`: 4.x adds `batch` and `reserve`.
		const top3 = Object.assign(fn(), { begin: vi.fn(), reserve: vi.fn() });
		const top4 = Object.assign(fn(), {
			begin: vi.fn(),
			batch: vi.fn(),
			reserve: vi.fn(),
		});
		// A transaction's `sql`: `savepoint` on 3.x; 4.x adds `begin` and `batch`.
		const tx3 = Object.assign(fn(), { savepoint: vi.fn() });
		const tx4 = Object.assign(fn(), {
			savepoint: vi.fn(),
			begin: vi.fn(),
			batch: vi.fn(),
			rollback: vi.fn(),
		});
		for (const client of [top3, top4, tx3, tx4]) {
			await expect(via(client)).resolves.toEqual({ via: "postgres.js" });
		}
		// `sql.reserve()` has neither `begin` nor `savepoint` on either major.
		const reserved3 = Object.assign(fn(), { release: vi.fn() });
		const reserved4 = Object.assign(fn(), {
			batch: vi.fn(),
			release: vi.fn(),
		});
		for (const client of [reserved3, reserved4]) {
			expectConfig(() => toSqlExecutor(client), /SqlExecutor/);
		}
	});

	test("unwraps a Drizzle instance's $client", async () => {
		for (const [client, expected] of [
			[fakePostgresJs(), "postgres.js"],
			[fakePGlite(), "pglite"],
			[fakePool(), "pg"],
			[fakeNeon(), "neon"],
		] as const) {
			await expect(
				via({ $client: client, select: vi.fn(), transaction: vi.fn() }),
			).resolves.toEqual({ via: expected });
		}
	});

	test("checks PGlite before SqlExecutor, whose shape it shares", async () => {
		const pglite = fakePGlite();
		await toSqlExecutor(pglite).query("SELECT 1", ["a"]);
		expect(pglite.query).toHaveBeenCalledWith("SELECT 1", ["a"]);
	});

	test("passes a hand-written SqlExecutor through unchanged", () => {
		const withTransaction: SqlExecutor = {
			query: async () => [],
			transaction: async (fn) => fn(withTransaction),
		};
		const batchOnly: SqlExecutor = {
			query: async () => [],
			batch: async (statements) => statements.map(() => []),
		};
		expect(toSqlExecutor(withTransaction)).toBe(withTransaction);
		expect(toSqlExecutor(batchOnly)).toBe(batchOnly);
		const wrapped = postgresJs(fakePostgresJs() as never);
		expect(toSqlExecutor(wrapped)).toBe(wrapped);
	});

	test("rejects a node-postgres Client and asks for a Pool", () => {
		expectConfig(() => toSqlExecutor(fakePgClient()), /Pool/);
		expectConfig(() => toSqlExecutor({ $client: fakePgClient() }), /Pool/);
	});

	test("rejects unknown values with CONFIG pointing to SqlExecutor", () => {
		for (const value of [
			undefined,
			null,
			42,
			"postgres://localhost",
			{},
			{ query: async () => [] },
			// A function needs Neon's `transaction` next to `query`.
			Object.assign(() => undefined, { query: vi.fn() }),
		]) {
			expectConfig(() => toSqlExecutor(value), /SqlExecutor/);
		}
	});

	test("rejects a Drizzle instance over an unsupported driver", () => {
		expectConfig(
			() => toSqlExecutor({ $client: Object.assign(() => undefined, {}) }),
			/Drizzle instance over an unsupported driver/,
		);
	});

	test("postgresStore throws CONFIG synchronously", async () => {
		expect(() => postgresStore({ client: {} as never })).toThrow();
		await expectMnemocyteError(
			Promise.resolve().then(() => postgresStore({ client: {} as never })),
			"CONFIG",
		);
		expect(() =>
			postgresStore({ client: { $client: fakePool() } }),
		).not.toThrow();
	});
});
