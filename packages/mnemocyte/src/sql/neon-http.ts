import { throwIfAborted } from "../resilience.js";
import type { SqlExecutor, SqlQueryOptions, SqlStatement } from "./executor.js";

/**
 * The part of the `neon()` function from `@neondatabase/serverless` 1.x
 * Mnemocyte checks for: a function with `query` and `transaction`. Any
 * function created with `neon(...)` matches, and so does a Drizzle
 * `neon-http` instance's `$client`. Only the presence of these members is
 * checked; the driver's own generic signatures could not be assigned to
 * narrower ones here.
 */
export interface NeonHttpClient {
	(...args: never[]): unknown;
	query(...args: never[]): unknown;
	transaction(...args: never[]): unknown;
}

/**
 * The options Mnemocyte passes on every call. `arrayMode` and `fullResults`
 * are set explicitly, so rows come back as plain objects whatever defaults
 * the caller gave `neon()`. `fetchOptions` is shallow-merged by the driver
 * into the caller's own, so it replaces only a `signal` set there.
 */
interface NeonCallOptions {
	arrayMode: false;
	fullResults: false;
	fetchOptions?: { signal: AbortSignal };
}

/**
 * What the adapter calls, as `@neondatabase/serverless` 1.x declares it for
 * `arrayMode: false` and `fullResults: false`. `query` returns a lazy
 * promise: it sends its request when awaited, or as part of a
 * `transaction` it is passed to, without being awaited first.
 */
interface NeonQueryFunctionShape {
	query(
		text: string,
		params: unknown[],
		options: NeonCallOptions,
	): Promise<Record<string, unknown>[]>;
	transaction(
		queries: Promise<Record<string, unknown>[]>[],
		options: NeonCallOptions,
	): Promise<Record<string, unknown>[][]>;
}

function callOptions(signal: AbortSignal | undefined): NeonCallOptions {
	return signal === undefined
		? { arrayMode: false, fullResults: false }
		: { arrayMode: false, fullResults: false, fetchOptions: { signal } };
}

/**
 * Await one request. An abort makes `fetch` reject, which the driver wraps
 * in a `NeonDbError` ("Error connecting to database"); it becomes
 * `"ABORTED"` here.
 */
async function send<T>(
	signal: AbortSignal | undefined,
	request: () => Promise<T>,
): Promise<T> {
	throwIfAborted(signal);
	try {
		return await request();
	} catch (error) {
		throwIfAborted(signal);
		throw error;
	}
}

/**
 * Run Mnemocyte's statements on a caller-owned `neon()` function from
 * `@neondatabase/serverless` 1.x, Neon's driver over HTTP.
 *
 * `query` is `sql.query(text, params)`, one HTTP request per statement.
 * `batch` is `sql.transaction([...])`: every statement in one request, run
 * by Neon as one non-interactive transaction. There is no `transaction`,
 * because each request stands alone, so `migrate` and
 * `setTextSearchConfig` need another connection.
 *
 * The signal is passed to `fetch` through `fetchOptions`. An abort rejects
 * the call with `"ABORTED"` at once, but Neon does not document whether it
 * stops the statement on the server, so it may still run to the end and,
 * for a write, commit.
 */
export function neonHttpExecutor(client: NeonHttpClient): SqlExecutor {
	// Matched by shape in detect.ts; only `query` and `transaction` are
	// called, with the signatures above.
	const sql = client as unknown as NeonQueryFunctionShape;
	return {
		async query<Row>(
			text: string,
			params: readonly unknown[],
			options?: SqlQueryOptions,
		): Promise<Row[]> {
			const signal = options?.signal;
			const rows = await send(signal, () =>
				sql.query(text, [...params], callOptions(signal)),
			);
			// Rows are plain objects keyed by column name; `Row` is the caller's
			// description of them.
			return rows as Row[];
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
			return await send(signal, () =>
				sql.transaction(
					// Not awaited: the transaction sends them together.
					statements.map((statement) =>
						sql.query(
							statement.sql,
							[...statement.params],
							callOptions(undefined),
						),
					),
					callOptions(signal),
				),
			);
		},
	};
}
