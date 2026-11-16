import { MnemocyteError } from "../errors.js";

/**
 * The SQL names of Mnemocyte's tables for one installation. Without a
 * schema they are bare (`mnemocyte_memories`) and resolve through the
 * connection's `search_path`, exactly as before `schemaName` existed. With
 * one they are schema-qualified (`"memory".mnemocyte_memories`), so they
 * resolve to that schema whatever `search_path` says.
 *
 * Only `FROM`, `INTO`, `UPDATE` and `DELETE FROM` targets need these:
 * Postgres lets a column name its table without the schema
 * (`mnemocyte_memories.id`) when the `FROM` item is qualified.
 */
export interface PostgresTables {
	/** The schema name as given, or null for `search_path`. */
	readonly schema: string | null;
	readonly memories: string;
	readonly events: string;
	readonly meta: string;
	readonly migrations: string;
}

/**
 * A Postgres identifier is at most 63 bytes (`NAMEDATALEN - 1`); Postgres
 * cuts a longer one without an error, so it is refused instead.
 */
const MAX_SCHEMA_NAME_BYTES = 63;

/**
 * Lower case letters, digits and underscores, not starting with a digit:
 * the names that work unquoted in `psql` and need no case thought. The
 * quoting below would accept anything, so this can be loosened later
 * without a break.
 */
const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Throw `"CONFIG"` (`INVALID_OPTION`) unless `value` is a schema name
 * Mnemocyte accepts: matching {@link SCHEMA_NAME_PATTERN}, at most 63
 * characters, and not starting with `pg_`, which Postgres reserves for
 * system schemas.
 */
export function assertSchemaName(
	value: unknown,
	field: string,
): asserts value is string {
	const invalid = (why: string): MnemocyteError =>
		new MnemocyteError({
			message: `${field} ${why}`,
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	if (typeof value !== "string") {
		throw invalid("must be a string.");
	}
	if (!SCHEMA_NAME_PATTERN.test(value)) {
		throw invalid(
			`must be lower case letters, digits and underscores, not starting with a digit; got ${JSON.stringify(value)}.`,
		);
	}
	if (value.length > MAX_SCHEMA_NAME_BYTES) {
		throw invalid(
			`must be at most ${MAX_SCHEMA_NAME_BYTES} characters, the longest name Postgres keeps.`,
		);
	}
	if (value.startsWith("pg_")) {
		throw invalid(
			"must not start with pg_, which Postgres reserves for system schemas.",
		);
	}
}

/**
 * `name` as a quoted SQL identifier, with any double quote doubled. Quoted,
 * a name that is also a keyword (`user`, `order`) still works.
 */
export function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

/** `value` as an SQL string literal, with any single quote doubled. */
export function sqlStringLiteral(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

/** The table names for `schema`, or for `search_path` when it is null. */
export function postgresTables(schema: string | null): PostgresTables {
	const prefix = schema === null ? "" : `${quoteIdentifier(schema)}.`;
	return Object.freeze({
		schema,
		memories: `${prefix}mnemocyte_memories`,
		events: `${prefix}mnemocyte_events`,
		meta: `${prefix}mnemocyte_meta`,
		migrations: `${prefix}mnemocyte_migrations`,
	});
}

/** The bare names, resolved through `search_path`. */
export const DEFAULT_TABLES: PostgresTables = postgresTables(null);

/**
 * `to_regclass(…)` for one of the tables: null when it does not exist,
 * including when the schema does not. The name is a string literal holding
 * the same text the queries use.
 */
export function regclass(table: string): string {
	return `to_regclass(${sqlStringLiteral(table)})`;
}
