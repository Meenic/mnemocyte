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
	// 3.x and 4.x both return a promise for the cancel request, which can
	// reject (4.x: `CANCEL_UNANSWERED`); `cancelQuietly` handles it.
	cancel(): unknown;
}

interface ExecutableQuery<T> extends CancelableQuery<T> {
	execute(): ExecutableQuery<T>;
}

function cancelQuietly(query: CancelableQuery<unknown>): void {
	try {
		Promise.resolve(query.cancel()).catch(() => {});
	} catch {
		// The query rejects on its own; a failed cancel request changes nothing.
	}
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
		cancelQuietly(query);
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

/**
 * A transaction's `sql` has `savepoint`; the top-level `sql` has it on
 * neither major. 4.x also gives a transaction's `sql` a `begin`, which opens
 * a savepoint, so `begin` alone does not tell them apart.
 */
function isTransactionSql(
	client: Sql | TransactionSql,
): client is TransactionSql {
	return "savepoint" in client;
}

/** `sql.batch` arrived in postgres.js 4.1; 3.x and 4.0 lack it. */
function hasBatch(client: Sql): boolean {
	return typeof (client as { batch?: unknown }).batch === "function";
}

// postgres.js types parameters as its own `ParameterOrJSON`; callers pass
// strings, numbers and null, which it serializes.
type UnsafeParams = Parameters<Sql["unsafe"]>[1];

type ResultRows = Record<string, unknown>[][];

function createExecutor(client: Sql | TransactionSql): PostgresJsExecutor {
	/**
	 * One `sql.batch`: every statement in one round trip ending in a single
	 * Sync, which Postgres runs as one implicit transaction.
	 */
	async function sendBatch(
		sql: Sql,
		statements: readonly SqlStatement[],
		signal: AbortSignal | undefined,
	): Promise<ResultRows> {
		const queries = statements.map((statement) =>
			sql.unsafe(statement.sql, statement.params as UnsafeParams),
		);
		// `sql.batch` returns a postgres.js Query, which its types declare as a
		// plain Promise; `execute()` sends it now, as `query` does.
		const pending = (
			sql.batch(queries) as unknown as ExecutableQuery<ResultRows>
		).execute();
		return await awaitCancelableQuery(pending, signal);
	}

	/**
	 * Returning an array of queries from the `sql.begin` (or `sql.savepoint`)
	 * callback pipelines them on the transaction's connection: postgres.js
	 * awaits them together, then commits, or rolls back when one fails.
	 */
	async function sendInTransaction(
		statements: readonly SqlStatement[],
		signal: AbortSignal | undefined,
	): Promise<ResultRows> {
		const sent: CancelableQuery<unknown>[] = [];
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
				cancelQuietly(query);
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = isTransactionSql(client)
				? await client.savepoint(run)
				: await client.begin(run);
			// One RowList per statement; each is an array of row objects.
			return result as unknown as ResultRows;
		} catch (error) {
			if (signal?.aborted) {
				throw abortedError(signal);
			}
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

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
		): Promise<ResultRows> {
			const signal = options?.signal;
			throwIfAborted(signal);
			if (statements.length === 0) {
				return [];
			}
			// Inside a transaction a failed `sql.batch` would abort the outer
			// transaction; a savepoint keeps the failure to these statements.
			if (!isTransactionSql(client) && hasBatch(client)) {
				return await sendBatch(client, statements, signal);
			}
			return await sendInTransaction(statements, signal);
		},
	};
}

/**
 * Wrap a caller-owned postgres.js client (3.4.9+ or 4.x) as a
 * {@link SqlExecutor}.
 *
 * Mnemocyte never ends the client. Pool size, TLS, `prepare` and the other
 * connection settings stay whatever the caller configured. Mnemocyte sends
 * statements with `sql.unsafe(text, params)`, which does not use named
 * prepared statements, so transaction-mode poolers work without `prepare:
 * false`. `batch` sends its statements with `sql.batch` on postgres.js 4.1
 * and later, and otherwise pipelines them inside `sql.begin` (or
 * `sql.savepoint` inside a transaction).
 *
 * @param client - A client created with `postgres(...)`.
 */
export function postgresJs(client: Sql): PostgresJsExecutor {
	return createExecutor(client);
}
