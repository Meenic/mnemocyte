import { throwIfAborted } from "../resilience.js";
import type { SqlExecutor, SqlQueryOptions } from "./executor.js";
import { createScopedExecutor } from "./scoped.js";

/** The part of a node-postgres query result Mnemocyte reads. */
export interface NodePostgresQueryResult {
	rows: Record<string, unknown>[];
}

/** The part of a node-postgres `PoolClient` Mnemocyte uses. */
export interface NodePostgresPoolClient {
	query(text: string, values?: unknown[]): Promise<NodePostgresQueryResult>;
	/** A truthy argument makes the pool destroy the client. */
	release(destroy?: boolean): void;
}

/**
 * The part of a node-postgres `Pool` Mnemocyte uses. pg-compatible pools,
 * such as `@neondatabase/serverless`'s `Pool`, have the same shape.
 */
export interface NodePostgresPool {
	query(text: string, values?: unknown[]): Promise<NodePostgresQueryResult>;
	connect(): Promise<NodePostgresPoolClient>;
	readonly totalCount: number;
}

/**
 * Run Mnemocyte's statements on a caller-owned node-postgres `Pool`.
 *
 * `query` uses `pool.query`. A transaction checks out one client with
 * `pool.connect()`, runs `BEGIN` … `COMMIT` on it and releases it, because
 * consecutive `pool.query` calls may run on different connections. A client
 * whose `ROLLBACK` failed is released with `release(true)`, so the pool
 * destroys it instead of handing out a connection in an unknown state.
 * There is no `batch`: node-postgres sends a client's queries one at a time,
 * so a transaction costs the same round trips.
 *
 * node-postgres has no public way to cancel a running query: an aborted
 * signal stops the next statement, and the one in flight runs to the end.
 */
export function nodePostgresExecutor(pool: NodePostgresPool): SqlExecutor {
	return {
		async query<Row>(
			sql: string,
			params: readonly unknown[],
			options?: SqlQueryOptions,
		): Promise<Row[]> {
			throwIfAborted(options?.signal);
			const result = await pool.query(sql, [...params]);
			// Rows are plain objects keyed by column name; `Row` is the caller's
			// description of them.
			return result.rows as Row[];
		},
		async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
			const client = await pool.connect();
			let broken = false;
			try {
				await client.query("BEGIN");
				const result = await fn(
					createScopedExecutor(
						async (sql, params) => (await client.query(sql, [...params])).rows,
					),
				);
				await client.query("COMMIT");
				return result;
			} catch (error) {
				try {
					await client.query("ROLLBACK");
				} catch {
					broken = true;
				}
				throw error;
			} finally {
				client.release(broken);
			}
		},
	};
}
