/** Options for a single {@link SqlExecutor.query} call. */
export interface SqlQueryOptions {
	/**
	 * Cancels the statement when aborted. The adapter rejects with a
	 * `MnemocyteError` whose code is `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/**
 * The two-method contract between Mnemocyte and the database client the
 * application already owns.
 *
 * Statements use positional `$1`, `$2`, … placeholders. Mnemocyte never
 * creates or closes the underlying client, so TLS, pool size and statement
 * caching stay under the caller's control.
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
	 */
	transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
