/** Options for a single {@link SqlExecutor.query} or {@link SqlExecutor.batch} call. */
export interface SqlQueryOptions {
	/**
	 * Cancels the statement when aborted. The adapter rejects with a
	 * `MnemocyteError` whose code is `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/** One statement of a {@link SqlExecutor.batch}. */
export interface SqlStatement {
	/** Statement text with positional `$1`, `$2`, … placeholders. */
	sql: string;
	/** Values for the placeholders, in order. */
	params: readonly unknown[];
}

/**
 * The contract between Mnemocyte and the database client the application
 * already owns.
 *
 * Statements use positional `$1`, `$2`, … placeholders. Mnemocyte never
 * creates or closes the underlying client, so TLS, pool size and statement
 * caching stay under the caller's control.
 *
 * `query` is required, and so is at least one of `transaction` and `batch`.
 * When both exist, Mnemocyte uses `batch` for statements that must run
 * together and `transaction` only where a later statement depends on an
 * earlier result (`migrate`).
 */
export interface SqlExecutor {
	/** Run one statement and return its rows as plain objects. */
	query<Row = Record<string, unknown>>(
		sql: string,
		params: readonly unknown[],
		options?: SqlQueryOptions,
	): Promise<Row[]>;
	/**
	 * Run `fn` in a transaction. The transaction commits when `fn` resolves and
	 * rolls back when it throws. Called on an executor that is already inside a
	 * transaction, it opens a savepoint.
	 *
	 * Optional for drivers without interactive transactions (stateless HTTP
	 * drivers); such an executor implements `batch` instead and cannot run
	 * `migrate`.
	 */
	transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
	/**
	 * Run `statements` in order in one transaction and return each one's rows,
	 * in the same order. All or nothing: when a statement fails, none of them
	 * takes effect and the call rejects. Settings made with
	 * `set_config(…, true)` by one statement apply to the later ones.
	 *
	 * Optional; maps to a non-interactive transaction (postgres.js 4.1+
	 * `sql.batch`, or pipelining inside `sql.begin` before that; Neon's
	 * `sql.transaction([...])`).
	 */
	batch?(
		statements: readonly SqlStatement[],
		options?: SqlQueryOptions,
	): Promise<Record<string, unknown>[][]>;
}
