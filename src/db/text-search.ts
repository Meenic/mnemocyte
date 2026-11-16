import { isMnemocyteError, MnemocyteError } from "../errors.js";
import type { SqlExecutor, SqlQueryOptions } from "../sql/executor.js";
import { postgresErrorCode } from "./errors.js";

/**
 * The text search configuration `0003` and the default fresh install give
 * `content_tsv`. Changing it rewrites the table, so it stays the default for
 * new installs too (decision 50).
 */
export const DEFAULT_TEXT_SEARCH_CONFIG = "english";

/**
 * SQLSTATEs of a configuration name that does not resolve: no such
 * configuration (`42704`), no such schema (`3F000`), a database-qualified
 * name (`0A000`), too many dotted names (`42601`), an invalid name
 * (`42602`) or malformed text (`22P02`).
 */
const UNKNOWN_CONFIG_CODES: ReadonlySet<string> = new Set([
	"42704",
	"0A000",
	"3F000",
	"42601",
	"42602",
	"22P02",
]);

/**
 * `name` as an SQL string literal. DDL takes no bind parameters, so the
 * generated column's expression gets the name inline; `name` is either
 * canonical (read back from `regconfig`) or printed for the user to apply.
 */
export function textSearchConfigLiteral(name: string): string {
	return `'${name.replaceAll("'", "''")}'`;
}

/**
 * The generated expression of `content_tsv` for `name`, as the template
 * writes it. Postgres only accepts immutable functions in a generated
 * column, so the configuration is named, never left to
 * `default_text_search_config`.
 */
export function contentTsvExpression(name: string): string {
	return `to_tsvector(${textSearchConfigLiteral(name)}::regconfig, "content")`;
}

// `pg_get_expr` prints the expression as `to_tsvector('english'::regconfig,
// content)`: the name is `regconfig`'s output (schema-qualified when the
// schema is not on `search_path`, quoted when it needs quotes) inside a
// string literal, whose quotes are doubled.
const CONTENT_TSV_EXPRESSION =
	/^to_tsvector\('((?:[^']|'')+)'::regconfig, "?content"?\)$/;

/**
 * The configuration named in `content_tsv`'s generated expression, or null
 * when the expression has another shape (the column was changed by hand).
 */
export function parseContentTsvExpression(expression: string): string | null {
	const match = CONTENT_TSV_EXPRESSION.exec(expression.trim());
	return match?.[1] === undefined ? null : match[1].replaceAll("''", "'");
}

/** What {@link readInstalledTextSearchConfig} found in the catalog. */
export type InstalledTextSearchConfig =
	/** `mnemocyte_memories.content_tsv` does not exist (or the table). */
	| { readonly kind: "missing" }
	| { readonly kind: "config"; readonly name: string }
	/** A generated expression Mnemocyte did not write. */
	| { readonly kind: "unrecognized"; readonly expression: string };

/**
 * Read the configuration from `content_tsv`'s generated expression. The
 * column is the only record: `mnemocyte_meta` does not repeat it, so the
 * two cannot disagree, and every 1.x schema already has the column.
 */
export async function readInstalledTextSearchConfig(
	db: SqlExecutor,
	options: SqlQueryOptions = {},
): Promise<InstalledTextSearchConfig> {
	const rows = await db.query<{ expression: string | null }>(
		`SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "expression"
		FROM pg_catalog.pg_attribute a
		LEFT JOIN pg_catalog.pg_attrdef d
			ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid = to_regclass('mnemocyte_memories')
			AND a.attname = 'content_tsv'
			AND NOT a.attisdropped`,
		[],
		options,
	);
	const row = rows[0];
	if (row === undefined) {
		return { kind: "missing" };
	}
	const expression = row.expression ?? "";
	const name = parseContentTsvExpression(expression);
	return name === null
		? { kind: "unrecognized", expression }
		: { kind: "config", name };
}

/** The error for a `content_tsv` whose expression Mnemocyte did not write. */
export function unrecognizedTextSearchError(
	expression: string,
): MnemocyteError {
	return new MnemocyteError({
		message: `mnemocyte_memories.content_tsv is generated as ${JSON.stringify(expression)}, not to_tsvector('<configuration>'::regconfig, content), so Mnemocyte cannot tell its text search configuration. Recreate the column as the Postgres guide shows.`,
		code: "MIGRATION",
		reason: "SCHEMA_UNRECOGNIZED",
	});
}

/**
 * The canonical name of the configuration `name` resolves to, as
 * `regconfig` prints it, and whether it is the same configuration as
 * `installed`. A name that does not resolve rejects with `"VALIDATION"`.
 *
 * Inside a transaction a failed cast aborts it, so callers throw right
 * after, which rolls it back.
 */
export async function resolveTextSearchConfig(
	db: SqlExecutor,
	name: string,
	installed: string | null,
	options: SqlQueryOptions = {},
): Promise<{ readonly name: string; readonly same: boolean }> {
	let rows: Array<{ name: string; same: boolean | null }>;
	try {
		rows = await db.query(
			`SELECT $1::regconfig::text AS "name",
				$1::regconfig::oid = $2::regconfig::oid AS "same"`,
			[name, installed],
			options,
		);
	} catch (error) {
		if (isMnemocyteError(error)) {
			throw error;
		}
		const code = postgresErrorCode(error);
		if (code !== undefined && UNKNOWN_CONFIG_CODES.has(code)) {
			throw new MnemocyteError({
				message: `textSearchConfig ${JSON.stringify(name)} is not a text search configuration in this database. List them with SELECT cfgname FROM pg_ts_config;`,
				code: "VALIDATION",
				cause: error,
			});
		}
		throw error;
	}
	const row = rows[0];
	if (row === undefined) {
		throw new MnemocyteError({
			message: "The text search configuration query returned no row.",
			code: "DB",
		});
	}
	return { name: row.name, same: row.same === true };
}

/**
 * The statements that give `content_tsv` the configuration `name`. Both
 * rewrite `mnemocyte_memories` under `ACCESS EXCLUSIVE` and rebuild every
 * index on it, HNSW included.
 *
 * - Postgres 17+ (`server_version_num` 170000): `ALTER COLUMN … SET
 *   EXPRESSION`, which keeps the column's position and its GIN index.
 * - Older: Postgres has no `SET EXPRESSION`, so the column is dropped and
 *   added back in one `ALTER TABLE` (one rewrite), which drops its index,
 *   so the index is created again. The column was the table's last one, so
 *   it still is.
 *
 * `ANALYZE` follows because a rewrite leaves the column without statistics,
 * which the planner reads to estimate a keyword match, and autovacuum counts
 * changed rows, not rewrites, so it may not analyze soon.
 */
export function changeTextSearchStatements(
	name: string,
	serverVersionNum: number,
): string[] {
	const expression = contentTsvExpression(name);
	const rewrite =
		serverVersionNum >= 170000
			? [
					`ALTER TABLE "mnemocyte_memories" ALTER COLUMN "content_tsv" SET EXPRESSION AS (${expression})`,
				]
			: [
					`ALTER TABLE "mnemocyte_memories" DROP COLUMN "content_tsv", ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS (${expression}) STORED`,
					`CREATE INDEX "mnemocyte_memories_content_tsv_idx" ON "mnemocyte_memories" USING gin ("content_tsv")`,
				];
	return [...rewrite, `ANALYZE "mnemocyte_memories" ("content_tsv")`];
}
