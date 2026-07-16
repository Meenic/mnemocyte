import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Sql } from "postgres";
import { MnemocyteError } from "../errors.js";
import { throwIfAborted } from "../resilience.js";
import type { MnemocyteDatabase } from "./index.js";

const postgresDialect = new PgDialect();

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

export async function executeCancelableSql<T>(
	db: MnemocyteDatabase,
	statement: SQL,
	signal: AbortSignal | undefined,
): Promise<T> {
	const query = postgresDialect.sqlToQuery(statement);
	const client = (db as MnemocyteDatabase & { $client?: Sql }).$client;
	if (!client) {
		throw new MnemocyteError(
			"Cancelable Postgres query requires the postgres.js client.",
			"DB",
		);
	}
	return (await awaitCancelableQuery(
		client.unsafe(query.sql, query.params as never[]),
		signal,
	)) as T;
}
