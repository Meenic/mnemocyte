import { throwIfAborted } from "../../resilience.js";
import type { LibsqlDriverClient } from "../../sql/detect.js";

/** A value bound to a `?NNN` placeholder; an `ArrayBuffer` is a blob. */
export type LibsqlValue = null | string | number | bigint | ArrayBuffer;

/** One statement with positional `?1`, `?2`, … placeholders. */
export interface LibsqlStatement {
	readonly sql: string;
	readonly args: readonly LibsqlValue[];
}

/** A result row as a plain object keyed by column name. */
export type LibsqlRow = Record<string, unknown>;

/** The statements the libSQL store runs, on the user's own client. */
export interface LibsqlExecutor {
	/** One statement, in autocommit. */
	execute(
		statement: LibsqlStatement,
		signal?: AbortSignal,
	): Promise<LibsqlRow[]>;
	/**
	 * Statements in order in one transaction, all or nothing: `"write"` is
	 * `BEGIN IMMEDIATE`, `"read"` a read-only transaction. Each statement
	 * sees the writes of the ones before it.
	 */
	batch(
		statements: readonly LibsqlStatement[],
		mode: "write" | "read",
		signal?: AbortSignal,
	): Promise<LibsqlRow[][]>;
	/**
	 * `fn` in an interactive transaction that commits when it resolves and
	 * rolls back when it throws. Only `migrate` uses it: on a local file
	 * another write that starts while it is open fails with `SQLITE_BUSY`,
	 * because the driver is synchronous and cannot wait for the lock.
	 */
	transaction<T>(
		mode: "write" | "read",
		fn: (tx: LibsqlTransactionExecutor) => Promise<T>,
	): Promise<T>;
}

/** Statements inside {@link LibsqlExecutor.transaction}. */
export interface LibsqlTransactionExecutor {
	execute(
		statement: LibsqlStatement,
		signal?: AbortSignal,
	): Promise<LibsqlRow[]>;
}

/** The parts of `@libsql/client`'s `ResultSet` the adapter reads. */
interface LibsqlResultSet {
	readonly columns: readonly string[];
	readonly rows: ArrayLike<ArrayLike<unknown>>;
}

interface LibsqlInStatement {
	sql: string;
	args: LibsqlValue[];
}

/** `@libsql/client`'s `Transaction`, as far as the adapter calls it. */
interface LibsqlDriverTransaction {
	execute(statement: LibsqlInStatement): Promise<LibsqlResultSet>;
	commit(): Promise<void>;
	rollback(): Promise<void>;
	close(): void;
	readonly closed: boolean;
}

/** `@libsql/client`'s `Client` with the signatures the adapter calls. */
interface LibsqlDriverCalls {
	execute(statement: LibsqlInStatement): Promise<LibsqlResultSet>;
	batch(
		statements: LibsqlInStatement[],
		mode: "write" | "read",
	): Promise<LibsqlResultSet[]>;
	transaction(mode: "write" | "read"): Promise<LibsqlDriverTransaction>;
}

/**
 * Rows as plain objects. A libSQL `Row` is indexable by position and by
 * name; the first of two columns with the same name wins, so every query
 * gives its columns distinct names.
 */
function toRows(result: LibsqlResultSet): LibsqlRow[] {
	const rows: LibsqlRow[] = [];
	for (let index = 0; index < result.rows.length; index += 1) {
		const row = result.rows[index];
		const record: LibsqlRow = {};
		if (row !== undefined) {
			result.columns.forEach((name, column) => {
				if (!(name in record)) {
					record[name] = row[column];
				}
			});
		}
		rows.push(record);
	}
	return rows;
}

function toInStatement(statement: LibsqlStatement): LibsqlInStatement {
	return { sql: statement.sql, args: [...statement.args] };
}

/**
 * The executor for a client detected by shape. The driver takes no
 * `AbortSignal`, so a signal is checked before each call: an aborted one
 * stops the call before it is sent, and a statement already sent runs to
 * completion.
 */
export function createLibsqlExecutor(
	client: LibsqlDriverClient,
): LibsqlExecutor {
	// Detection checked these methods exist; their full overloads are the
	// driver's, of which the adapter uses one form each.
	const driver = client as unknown as LibsqlDriverCalls;
	return {
		async execute(statement, signal) {
			throwIfAborted(signal);
			return toRows(await driver.execute(toInStatement(statement)));
		},
		async batch(statements, mode, signal) {
			throwIfAborted(signal);
			if (statements.length === 0) {
				return [];
			}
			const results = await driver.batch(statements.map(toInStatement), mode);
			return results.map(toRows);
		},
		async transaction(mode, fn) {
			const tx = await driver.transaction(mode);
			try {
				const result = await fn({
					async execute(statement, signal) {
						throwIfAborted(signal);
						return toRows(await tx.execute(toInStatement(statement)));
					},
				});
				await tx.commit();
				return result;
			} catch (error) {
				if (!tx.closed) {
					await tx.rollback().catch(() => undefined);
				}
				throw error;
			} finally {
				tx.close();
			}
		},
	};
}
