import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderInitialSchema } from "../db/migrations/runner.js";
import { quoteIdentifier } from "../db/tables.js";
import { assertMigrateDimensions } from "../memory/validation.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { loadMemoryFile, locateMemoryFile } from "./memory-file.js";
import { assertSchemaFlag, loadEnvironment } from "./target.js";

/**
 * What goes before the schema when the tables live in `schema`: the
 * template's names are bare, so it creates the schema and puts it first on
 * `search_path`, keeping `public` for pgvector's `vector` type.
 */
function schemaPreamble(schema: string): string {
	const quoted = quoteIdentifier(schema);
	return `-- Mnemocyte's tables go into the ${schema} schema. Keep the schema that holds
-- pgvector on search_path after it (public on most setups).
CREATE SCHEMA IF NOT EXISTS ${quoted};
--> statement-breakpoint
SET search_path TO ${quoted}, public;
--> statement-breakpoint
`;
}

/** What a schema rendered without a database is for. */
export interface SchemaShape {
	readonly dimensions: number;
	/** The schema of the tables, or undefined for `search_path`. */
	readonly schema: string | undefined;
}

/**
 * The embedding size and schema for `sql` and `generate`, which never query
 * a database.
 *
 * `--dimensions` alone loads no file. Without it the size is the embedder's
 * in the memory file, which is imported, so whatever that file does at the
 * top level (creating a client, opening a PGlite folder) happens. The schema
 * is `--schema`, or the memory file's `schemaName` when the file is loaded.
 *
 * @throws {CliError} With exit code 2 when no dimensions can be found.
 */
export async function resolveSchemaShape(
	args: CliArgs,
	io: CliIo,
): Promise<SchemaShape> {
	if (args.dimensions !== undefined) {
		return { dimensions: args.dimensions, schema: args.schema };
	}
	loadEnvironment(io.cwd, args.envFile);
	const file = locateMemoryFile(io.cwd, args.config);
	if (file === null) {
		throw new CliError(
			`${args.command} needs the embedding size: pass --dimensions <n>, or run it where a memory file is.`,
			EXIT_USAGE,
		);
	}
	const { embedder, store } = await loadMemoryFile(file, io.cwd);
	assertSchemaFlag(args.schema, store, file);
	assertMigrateDimensions(embedder.dimensions, "embedder.dimensions");
	return { dimensions: embedder.dimensions, schema: store.schemaName };
}

/**
 * `mnemocyte sql`: print the schema a fresh install creates, for teams that
 * apply SQL with their own tools. It never queries a database.
 *
 * @returns The exit code.
 * @throws {CliError} With exit code 2 when no dimensions can be found.
 */
export async function sqlCommand(args: CliArgs, io: CliIo): Promise<number> {
	const { dimensions, schema } = await resolveSchemaShape(args, io);

	// Postgres checks the configuration's name when the SQL is applied.
	const sql =
		(schema === undefined ? "" : schemaPreamble(schema)) +
		renderInitialSchema(dimensions, args.textSearchConfig, schema ?? null);
	if (args.out === undefined) {
		io.write(sql);
	} else {
		await writeFile(resolve(io.cwd, args.out), sql);
		io.error(`Wrote ${args.out} (${dimensions} dimensions)
`);
	}
	return 0;
}
