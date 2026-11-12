import { throwIfAborted } from "../resilience.js";
import type { SqlExecutor, SqlQueryOptions } from "./executor.js";
import { createScopedExecutor } from "./scoped.js";

/** The part of a PGlite query result Mnemocyte reads. */
export interface PGliteQueryResult {
	rows: unknown[];
}

/** The part of a PGlite transaction (`tx`) Mnemocyte uses. */
export interface PGliteTransaction {
	query(query: string, params?: unknown[]): Promise<PGliteQueryResult>;
}

/**
 * The part of a `PGlite` (or `PGliteWorker`) instance Mnemocyte uses. The
 * database needs the pgvector extension, loaded through the instance's
 * `extensions` option.
 */
export interface PGliteClient {
	query(query: string, params?: unknown[]): Promise<PGliteQueryResult>;
	exec(query: string): Promise<unknown>;
	transaction<T>(callback: (tx: PGliteTransaction) => Promise<T>): Promise<T>;
}

/**
 * Run Mnemocyte's statements on a caller-owned PGlite instance.
 *
 * `query` uses `db.query` (one statement, extended protocol) and
 * `transaction` uses `db.transaction`, which holds PGlite's exclusive lock
 * until it ends. A transaction inside a transaction opens a savepoint.
 *
 * PGlite cannot cancel a running query: an aborted signal stops the next
 * statement, and the one in flight runs to the end.
 */
export function pgliteExecutor(db: PGliteClient): SqlExecutor {
	return {
		async query<Row>(
			sql: string,
			params: readonly unknown[],
			options?: SqlQueryOptions,
		): Promise<Row[]> {
			throwIfAborted(options?.signal);
			const result = await db.query(sql, [...params]);
			// Rows are plain objects keyed by column name; `Row` is the caller's
			// description of them.
			return result.rows as Row[];
		},
		async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
			return db.transaction((tx) =>
				fn(
					createScopedExecutor(
						async (sql, params) =>
							(await tx.query(sql, [...params])).rows as Record<
								string,
								unknown
							>[],
					),
				),
			);
		},
	};
}
