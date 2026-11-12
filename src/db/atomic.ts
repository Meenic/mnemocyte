import { MnemocyteError } from "../errors.js";
import type {
	SqlExecutor,
	SqlQueryOptions,
	SqlStatement,
} from "../sql/executor.js";

/**
 * Rows per multi-row `INSERT`. postgres.js rejects 65,534 or more bind
 * parameters (Postgres's own limit is 65,535); a memory row binds 23, so one
 * statement could hold 2,849 rows. 250 rows keep a statement near 4 MB at
 * 1,536 dimensions, well under the 64 MB request limit of HTTP drivers such
 * as Neon's, which send a whole batch as one request.
 */
export const INSERT_CHUNK_ROWS = 250;

/** Split `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let start = 0; start < items.length; start += size) {
		chunks.push(items.slice(start, start + size));
	}
	return chunks;
}

/**
 * Check that `client` can run Mnemocyte's statements: a `query` function and
 * at least one of `transaction` and `batch`.
 */
export function assertSqlExecutor(
	client: unknown,
): asserts client is SqlExecutor {
	const executor = client as Partial<SqlExecutor> | null | undefined;
	if (
		typeof executor !== "object" ||
		executor === null ||
		typeof executor.query !== "function"
	) {
		throw new MnemocyteError(
			"client must be a SqlExecutor with a query function, for example postgresJs(sql).",
			"CONFIG",
		);
	}
	if (
		typeof executor.transaction !== "function" &&
		typeof executor.batch !== "function"
	) {
		throw new MnemocyteError(
			"client must implement SqlExecutor.transaction or SqlExecutor.batch.",
			"CONFIG",
		);
	}
}

/**
 * Run `statements` in order, all or nothing, and return each one's rows.
 *
 * - One statement is atomic by itself and goes through `query`.
 * - Otherwise `batch` when the executor has it: one non-interactive
 *   transaction, which stateless HTTP drivers support and postgres.js
 *   pipelines.
 * - Otherwise a `transaction` that sends the statements one at a time.
 */
export async function runAtomically(
	db: SqlExecutor,
	statements: readonly SqlStatement[],
	options?: SqlQueryOptions,
): Promise<Record<string, unknown>[][]> {
	const [first] = statements;
	if (first === undefined) {
		return [];
	}
	if (statements.length === 1) {
		return [await db.query(first.sql, first.params, options)];
	}
	if (db.batch) {
		const results = await db.batch(statements, options);
		if (!Array.isArray(results) || results.length !== statements.length) {
			throw new MnemocyteError(
				`SqlExecutor.batch returned ${Array.isArray(results) ? results.length : "no"} results for ${statements.length} statements.`,
				"DB",
			);
		}
		return results;
	}
	if (db.transaction) {
		return db.transaction(async (tx) => {
			const results: Record<string, unknown>[][] = [];
			for (const statement of statements) {
				results.push(await tx.query(statement.sql, statement.params, options));
			}
			return results;
		});
	}
	throw new MnemocyteError(
		"client must implement SqlExecutor.transaction or SqlExecutor.batch.",
		"CONFIG",
	);
}
