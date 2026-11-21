import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { openPGlite } from "./pglite.js";
import { describeStoreContract } from "./suite.js";

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

describeStoreContract("PGlite, parameter types checked", async () => {
	const db = await openPGlite({ pgvector: true });
	return {
		client: checkingParams(toSqlExecutor(db)),
		close: () => db.close(),
	};
});
