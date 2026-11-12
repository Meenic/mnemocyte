import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { describeStoreContract } from "./suite.js";

/** An in-process Postgres 18 with pgvector, gone when it is closed. */
async function createPGlite(): Promise<PGlite> {
	const db = await PGlite.create({ extensions: { vector } });
	await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
	return db;
}

/**
 * postgres.js 4 sends parameters untyped and lets the server pick each type;
 * 3.x typed a `Date`, boolean, `bigint`, `Buffer` or array from JavaScript.
 * Strings, finite numbers and null are written the same either way, so every
 * statement Mnemocyte sends must stick to them (timestamps as ISO strings
 * with `::timestamptz`, JSON and tags as text).
 */
function assertPortableParams(sql: string, params: readonly unknown[]): void {
	params.forEach((value, index) => {
		if (
			value === null ||
			typeof value === "string" ||
			(typeof value === "number" && Number.isFinite(value))
		) {
			return;
		}
		const kind = Array.isArray(value) ? "array" : typeof value;
		throw new Error(
			`Parameter ${index + 1} is a ${kind}, not a string, number or null: ${sql}`,
		);
	});
}

/** Wraps an executor and checks every statement's parameters first. */
function checkingParams(inner: SqlExecutor): SqlExecutor {
	const executor: SqlExecutor = {
		query(sql, params, options) {
			assertPortableParams(sql, params);
			return inner.query(sql, params, options);
		},
	};
	if (inner.transaction) {
		const transaction = inner.transaction.bind(inner);
		executor.transaction = (fn) => transaction((tx) => fn(checkingParams(tx)));
	}
	if (inner.batch) {
		const batch = inner.batch.bind(inner);
		executor.batch = (statements, options) => {
			for (const statement of statements) {
				assertPortableParams(statement.sql, statement.params);
			}
			return batch(statements, options);
		};
	}
	return executor;
}

describeStoreContract("PGlite", async () => {
	const db = await createPGlite();
	return { client: db, close: () => db.close() };
});

describeStoreContract("Drizzle over PGlite", async () => {
	const db = await createPGlite();
	return { client: drizzle({ client: db }), close: () => db.close() };
});

describeStoreContract("PGlite, parameter types checked", async () => {
	const db = await createPGlite();
	return {
		client: checkingParams(toSqlExecutor(db)),
		close: () => db.close(),
	};
});
