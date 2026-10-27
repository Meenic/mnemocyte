import type { Sql, TransactionSql } from "postgres";
import { MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import type { SqlExecutor } from "./executor.js";

interface CancelableQuery<T> extends PromiseLike<T> {
	cancel(): void;
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
			throw new MnemocyteError(
				"Operation was aborted.",
				"ABORTED",
				signal.reason,
			);
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

function createExecutor(client: Sql | TransactionSql): SqlExecutor {
	return {
		async query<Row>(
			sql: string,
			params: readonly unknown[],
			options?: { signal?: AbortSignal },
		): Promise<Row[]> {
			throwIfAborted(options?.signal);
			// postgres.js types parameters as its own `ParameterOrJSON`; callers
			// pass strings, numbers, booleans and null, which it serializes.
			const pending = client.unsafe(
				sql,
				params as Parameters<Sql["unsafe"]>[1],
			);
			const rows = await awaitCancelableQuery(pending, options?.signal);
			// RowList<Row[]> is an array of `Row`; postgres.js constrains rows to
			// `Record<string, any>`, which a generic `Row` cannot express.
			return rows as unknown as Row[];
		},
		async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
			const run = (scoped: TransactionSql): Promise<T> =>
				fn(createExecutor(scoped));
			// begin() and savepoint() type their result as UnwrapPromiseArray<T>,
			// which only differs from T when `fn` returns an array of queries.
			const result = isTransactionSql(client)
				? await client.savepoint(run)
				: await client.begin(run);
			return result as T;
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
 * false`.
 *
 * @param client - A client created with `postgres(...)`.
 */
export function postgresJs(client: Sql): SqlExecutor {
	return createExecutor(client);
}
