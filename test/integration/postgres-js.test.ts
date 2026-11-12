import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { postgresJs } from "mnemocyte/postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
// `POSTGRES_JS=3` aliases `postgres` to the 3.x dev dependency
// (vitest.config.ts).
const major = process.env.POSTGRES_JS === "3" ? 3 : 4;

describe.skipIf(!databaseUrl)(`postgresJs on postgres.js ${major}.x`, () => {
	let sql: ReturnType<typeof postgres> | undefined;
	let batchCalls = 0;

	function client(): ReturnType<typeof postgres> {
		return expectDefined(sql, "not connected");
	}

	async function probeRows(): Promise<number[]> {
		const rows = await client()<{ n: number }[]>`
			SELECT n FROM postgres_js_probe ORDER BY n
		`;
		return rows.map((row) => row.n);
	}

	beforeAll(async () => {
		// One connection, so the temporary table is visible to every statement.
		sql = postgres(databaseUrl ?? "", { max: 1, onnotice: () => {} });
		const batch = (sql as { batch?: (...args: never[]) => unknown }).batch;
		if (typeof batch === "function") {
			Object.assign(sql, {
				batch: (...args: never[]) => {
					batchCalls += 1;
					return batch.apply(sql, args);
				},
			});
		}
		await sql`CREATE TEMPORARY TABLE postgres_js_probe (n int NOT NULL)`;
	});

	afterAll(async () => {
		await sql?.end();
	});

	test("the client is the major under test", () => {
		// sql.batch arrived in 4.1; 3.x has none, so a missing alias shows here.
		expect(typeof (client() as { batch?: unknown }).batch).toBe(
			major === 3 ? "undefined" : "function",
		);
	});

	test("batch shares set_config(…, true) across its statements only", async () => {
		const executor = postgresJs(client());
		const before = batchCalls;

		const results = await executor.batch([
			{
				sql: "SELECT set_config('mnemocyte.probe', $1, true)",
				params: ["batched"],
			},
			{
				sql: "SELECT current_setting('mnemocyte.probe', true) AS value",
				params: [],
			},
		]);

		expect(results[1]).toEqual([{ value: "batched" }]);
		// 4.1+ sends one sql.batch; 3.x pipelines inside sql.begin.
		expect(batchCalls - before).toBe(major === 3 ? 0 : 1);
		const [after] = await executor.query<{ value: string | null }>(
			"SELECT current_setting('mnemocyte.probe', true) AS value",
			[],
		);
		expect(after?.value ?? "").toBe("");
	});

	test("batch commits all its statements or none", async () => {
		const executor = postgresJs(client());
		await executor.query("DELETE FROM postgres_js_probe", []);

		await expect(
			executor.batch([
				{ sql: "INSERT INTO postgres_js_probe (n) VALUES ($1)", params: [1] },
				{ sql: "SELECT 1 / $1::int", params: [0] },
			]),
		).rejects.toMatchObject({ code: "22012" });
		expect(await probeRows()).toEqual([]);

		await executor.batch([
			{ sql: "INSERT INTO postgres_js_probe (n) VALUES ($1)", params: [1] },
			{ sql: "INSERT INTO postgres_js_probe (n) VALUES ($1)", params: [2] },
		]);
		expect(await probeRows()).toEqual([1, 2]);
	});

	test("a failed batch inside a transaction rolls back only its savepoint", async () => {
		const executor = postgresJs(client());
		await executor.query("DELETE FROM postgres_js_probe", []);
		const before = batchCalls;

		await executor.transaction(async (tx) => {
			await tx.query("INSERT INTO postgres_js_probe (n) VALUES ($1)", [1]);
			await expect(
				tx.batch([
					{
						sql: "INSERT INTO postgres_js_probe (n) VALUES ($1)",
						params: [2],
					},
					{ sql: "SELECT 1 / $1::int", params: [0] },
				]),
			).rejects.toMatchObject({ code: "22012" });
			await tx.query("INSERT INTO postgres_js_probe (n) VALUES ($1)", [3]);
		});

		expect(await probeRows()).toEqual([1, 3]);
		expect(batchCalls).toBe(before);
	});

	test("an aborted batch is canceled on the server", async () => {
		const executor = postgresJs(client());
		const controller = new AbortController();
		const started = Date.now();

		const result = executor.batch(
			[
				{ sql: "SELECT 1", params: [] },
				{ sql: "SELECT pg_sleep($1)", params: [30] },
			],
			{ signal: controller.signal },
		);
		setTimeout(() => controller.abort(), 200);

		await expectMnemocyteError(result, "ABORTED");
		expect(Date.now() - started).toBeLessThan(10_000);
		// The connection is usable again.
		await expect(executor.query("SELECT 1 AS ok", [])).resolves.toEqual([
			{ ok: 1 },
		]);
	});
});
