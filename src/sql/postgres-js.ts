import type { Sql, TransactionSql } from "postgres";
import { MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import type { SqlExecutor, SqlQueryOptions, SqlStatement } from "./executor.js";

/**
 * The {@link SqlExecutor} returned by {@link postgresJs}: it implements both
 * optional methods, and so does the executor its `transaction` passes on.
 */
export interface PostgresJsExecutor extends SqlExecutor {
	transaction<T>(fn: (tx: PostgresJsExecutor) => Promise<T>): Promise<T>;
	batch(
		statements: readonly SqlStatement[],
		options?: SqlQueryOptions,
	): Promise<Record<string, unknown>[][]>;
}

interface CancelableQuery<T> extends PromiseLike<T> {
	cancel(): void;
}

function abortedError(signal: AbortSignal): MnemocyteError {
	return new MnemocyteError("Operation was aborted.", "ABORTED", signal.reason);
}

async function awaitCancelableQuery<T>(
	query: CancelableQuery<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	throwIfAborted(signal);
	if (!signal) {
		return await query;
	}
	const onAbort = (): void => {
		query.cancel();
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await query;
	} catch (error) {
		if (signal.aborted) {
			throw abortedError(signal);
		}
		throw error;
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function isTransactionSql(
	client: Sql | TransactionSql,
): client is TransactionSql {
	return "savepoint" in client;
}

// postgres.js types parameters as its own `ParameterOrJSON`; callers pass
// strings, numbers, booleans and null, which it serializes.
type UnsafeParams = Parameters<Sql["unsafe"]>[1];

function createExecutor(client: Sql | TransactionSql): PostgresJsExecutor {
	return {
		async query<Row>(
			sql: string,
			params: readonly unknown[],
			options?: SqlQueryOptions,
		): Promise<Row[]> {
			throwIfAborted(options?.signal);
			// Its queries are lazy and start on the next tick; `execute()` starts
			// this one now, so a statement begun before a caller's `sql.end()`
			// is already queued and runs to completion.
			const pending = client.unsafe(sql, params as UnsafeParams).execute();
			const rows = await awaitCancelableQuery(pending, options?.signal);
			// RowList<Row[]> is an array of `Row`; postgres.js constrains rows to
			// `Record<string, any>`, which a generic `Row` cannot express.
			return rows as unknown as Row[];
		},
		async transaction<T>(
			fn: (tx: PostgresJsExecutor) => Promise<T>,
		): Promise<T> {
			const run = (scoped: TransactionSql): Promise<T> =>
				fn(createExecutor(scoped));
			// begin() and savepoint() type their result as UnwrapPromiseArray<T>,
			// which only differs from T when `fn` returns an array of queries.
			const result = isTransactionSql(client)
				? await client.savepoint(run)
				: await client.begin(run);
			return result as T;
		},
		async batch(
			statements: readonly SqlStatement[],
			options?: SqlQueryOptions,
		): Promise<Record<string, unknown>[][]> {
			const signal = options?.signal;
			throwIfAborted(signal);
			if (statements.length === 0) {
				return [];
			}
			const sent: CancelableQuery<unknown>[] = [];
			// Returning an array of queries from the callback pipelines them on
			// the transaction's connection: postgres.js awaits them together and
			// then commits, or rolls back when one fails.
			const run = (scoped: TransactionSql) => {
				if (signal?.aborted) {
					throw abortedError(signal);
				}
				return statements.map((statement) => {
					const query = scoped.unsafe(
						statement.sql,
						statement.params as UnsafeParams,
					);
					sent.push(query);
					return query;
				});
			};
			const onAbort = (): void => {
				for (const query of sent) {
					query.cancel();
				}
			};
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const result = isTransactionSql(client)
					? await client.savepoint(run)
					: await client.begin(run);
				// One RowList per statement; each is an array of row objects.
				return result as unknown as Record<string, unknown>[][];
			} catch (error) {
				if (signal?.aborted) {
					throw abortedError(signal);
				}
				throw error;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Wrap a caller-owned postgres.js client as a {@link SqlExecutor}.
 *
 * Mnemocyte never ends the client. Pool size, TLS, `prepare` and the other
 * connection settings stay whatever the caller configured. Mnemocyte sends
 * statements with `sql.unsafe(text, params)`, which does not use named
 * prepared statements, so transaction-mode poolers work without `prepare:
 * false`. `batch` pipelines its statements inside `sql.begin` (or
 * `sql.savepoint` inside a transaction).
 *
 * @param client - A client created with `postgres(...)`.
 */
export function postgresJs(client: Sql): PostgresJsExecutor {
	return createExecutor(client);
}
