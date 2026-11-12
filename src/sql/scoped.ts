import { throwIfAborted } from "../resilience.js";
import type { SqlExecutor, SqlQueryOptions } from "./executor.js";

/** Runs one statement on a connection that is inside a transaction. */
export type ScopedRun = (
	sql: string,
	params: readonly unknown[],
) => Promise<Record<string, unknown>[]>;

/**
 * The executor passed to a `transaction` callback for drivers that only hand
 * out a connection (node-postgres, PGlite). Its `transaction` opens a
 * savepoint on that connection, because neither driver nests transactions:
 * PGlite's `tx` has no `transaction`, and a second `BEGIN` on a pg client
 * only warns.
 *
 * Statements cannot be cancelled once sent; an aborted signal stops the
 * next one.
 */
export function createScopedExecutor(run: ScopedRun, depth = 0): SqlExecutor {
	return {
		async query<Row>(
			sql: string,
			params: readonly unknown[],
			options?: SqlQueryOptions,
		): Promise<Row[]> {
			throwIfAborted(options?.signal);
			// Rows are plain objects keyed by column name; `Row` is the caller's
			// description of them.
			return (await run(sql, params)) as Row[];
		},
		async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
			// Names are fixed per depth, so they never come from input.
			const name = `mnemocyte_savepoint_${depth + 1}`;
			await run(`SAVEPOINT ${name}`, []);
			let result: T;
			try {
				result = await fn(createScopedExecutor(run, depth + 1));
			} catch (error) {
				try {
					await run(`ROLLBACK TO SAVEPOINT ${name}`, []);
				} catch {
					// The connection is gone or the transaction cannot continue;
					// the outer transaction rolls back and reports `error`.
				}
				throw error;
			}
			await run(`RELEASE SAVEPOINT ${name}`, []);
			return result;
		},
	};
}
