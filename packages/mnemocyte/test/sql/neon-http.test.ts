import { neon, neonConfig } from "@neondatabase/serverless";
import { afterEach, describe, expect, test, vi } from "vitest";
import { toSqlExecutor } from "../../src/sql/clients.js";
import { neonHttpExecutor } from "../../src/sql/neon-http.js";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

/**
 * The real `neon()` function, with `neonConfig.fetchFunction` answering
 * instead of a server, so these tests check the requests the driver builds
 * from the adapter's calls. No network is used.
 */

const URL = "postgres://user:password@db.example.test/main";

interface SentRequest {
	body: unknown;
	headers: Record<string, string>;
	signal: AbortSignal | undefined;
}

/** One result in the driver's raw text format: column names and text values. */
function result(rows: Record<string, string | null>[]) {
	const names = Object.keys(rows[0] ?? { one: null });
	return {
		fields: names.map((name) => ({ name, dataTypeID: 25 })),
		rows: rows.map((row) => names.map((name) => row[name] ?? null)),
	};
}

/**
 * Stub `fetch` for the driver. `respond` gets each request body and returns
 * the JSON to answer with; `hang` makes the request wait for its signal.
 */
function stubFetch(
	respond: (body: { query?: string; queries?: unknown[] }) => unknown,
	options: { hang?: boolean } = {},
): SentRequest[] {
	const sent: SentRequest[] = [];
	neonConfig.fetchFunction = async (_url: string, init: RequestInit) => {
		const signal = init.signal ?? undefined;
		const body = JSON.parse(String(init.body));
		sent.push({
			body,
			headers: init.headers as Record<string, string>,
			signal,
		});
		if (options.hang === true) {
			await new Promise((_, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), {
					once: true,
				});
			});
		}
		return new Response(JSON.stringify(respond(body)), { status: 200 });
	};
	return sent;
}

afterEach(() => {
	neonConfig.fetchFunction = undefined;
});

describe("Neon HTTP executor", () => {
	test("is detected from neon() and from a Drizzle neon-http $client", () => {
		const sql = neon(URL);
		const executor = toSqlExecutor(sql);
		expect(executor.batch).toBeTypeOf("function");
		expect(executor.transaction).toBeUndefined();
		const fromDrizzle = toSqlExecutor({ $client: sql, select: vi.fn() });
		expect(fromDrizzle.transaction).toBeUndefined();
	});

	test("query sends one request with $n placeholders and returns row objects", async () => {
		const sent = stubFetch(() => result([{ id: "a", content: "x" }]));
		// fullResults and arrayMode set on neon() do not change what the
		// adapter returns.
		const executor = neonHttpExecutor(
			neon(URL, { fullResults: true, arrayMode: true }),
		);
		await expect(
			executor.query("SELECT $1::text AS id, $2::text AS content", ["a", "x"]),
		).resolves.toEqual([{ id: "a", content: "x" }]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body).toEqual({
			query: "SELECT $1::text AS id, $2::text AS content",
			params: ["a", "x"],
		});
		expect(sent[0]?.signal).toBeUndefined();
	});

	test("batch sends every statement in one transaction request", async () => {
		const sent = stubFetch((body) => ({
			results: (body.queries ?? []).map((_, index) =>
				result([{ n: String(index) }]),
			),
		}));
		const executor = neonHttpExecutor(neon(URL, { fullResults: true }));
		const batch = expectDefined(executor.batch);
		await expect(
			batch([
				{ sql: "SELECT set_config('a', $1, true)", params: ["1"] },
				{ sql: "SELECT $1::text AS n", params: ["x"] },
			]),
		).resolves.toEqual([[{ n: "0" }], [{ n: "1" }]]);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body).toEqual({
			queries: [
				{ query: "SELECT set_config('a', $1, true)", params: ["1"] },
				{ query: "SELECT $1::text AS n", params: ["x"] },
			],
		});
		// No isolation level, read-only or deferrable header: Neon's defaults.
		expect(Object.keys(sent[0]?.headers ?? {})).not.toContain(
			"Neon-Batch-Isolation-Level",
		);
	});

	test("an empty batch sends nothing", async () => {
		const sent = stubFetch(() => ({ results: [] }));
		const batch = expectDefined(neonHttpExecutor(neon(URL)).batch);
		await expect(batch([])).resolves.toEqual([]);
		expect(sent).toHaveLength(0);
	});

	test("the signal goes to fetch for query and batch", async () => {
		const sent = stubFetch((body) =>
			body.queries === undefined
				? result([{ one: "1" }])
				: { results: body.queries.map(() => result([{ one: "1" }])) },
		);
		const executor = neonHttpExecutor(neon(URL));
		const controller = new AbortController();
		await executor.query("SELECT 1", [], { signal: controller.signal });
		await expectDefined(executor.batch)(
			[
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT 2", params: [] },
			],
			{ signal: controller.signal },
		);
		expect(sent.map((request) => request.signal)).toEqual([
			controller.signal,
			controller.signal,
		]);
	});

	test("an abort during the request rejects with ABORTED", async () => {
		const sent = stubFetch(() => result([{ one: "1" }]), { hang: true });
		const executor = neonHttpExecutor(neon(URL));
		const controller = new AbortController();
		const pending = executor.query("SELECT pg_sleep(10)", [], {
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(sent).toHaveLength(1));
		controller.abort(new Error("stop"));
		await expectMnemocyteError(pending, "ABORTED");

		const batchController = new AbortController();
		const batch = expectDefined(executor.batch)(
			[
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT 2", params: [] },
			],
			{ signal: batchController.signal },
		);
		await vi.waitFor(() => expect(sent).toHaveLength(2));
		batchController.abort();
		await expectMnemocyteError(batch, "ABORTED");
	});

	test("an already aborted signal sends nothing", async () => {
		const sent = stubFetch(() => result([{ one: "1" }]));
		const executor = neonHttpExecutor(neon(URL));
		const signal = AbortSignal.abort();
		await expectMnemocyteError(
			executor.query("SELECT 1", [], { signal }),
			"ABORTED",
		);
		await expectMnemocyteError(
			expectDefined(executor.batch)([{ sql: "SELECT 1", params: [] }], {
				signal,
			}),
			"ABORTED",
		);
		expect(sent).toHaveLength(0);
	});

	test("a database error passes through with its code and constraint", async () => {
		neonConfig.fetchFunction = async () =>
			new Response(
				JSON.stringify({
					message: "duplicate key value violates unique constraint",
					code: "23505",
					constraint: "mnemocyte_memories_scope_key_idx",
				}),
				{ status: 400 },
			);
		const executor = neonHttpExecutor(neon(URL));
		await expect(executor.query("INSERT …", [])).rejects.toMatchObject({
			name: "NeonDbError",
			code: "23505",
			constraint: "mnemocyte_memories_scope_key_idx",
		});
	});
});
