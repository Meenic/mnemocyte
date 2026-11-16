import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { DEFAULT_TEXT_SEARCH_CONFIG } from "../db/text-search.js";
import type { CliArgs } from "./args.js";
import {
	DRIZZLE_SCHEMA_HEADER,
	type DrizzleSchemaShape,
	drizzleContentTsvSource,
	readDrizzleSchemaShape,
	renderDrizzleSchema,
	renderDrizzleSetupSql,
	renderDrizzleTextSearchIndexSql,
} from "./drizzle.js";
import { projectRunner } from "./init.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { resolveSchemaShape } from "./sql.js";

/** Where `generate --adapter drizzle` writes without `--out`. */
export const DEFAULT_DRIZZLE_SCHEMA_FILE = "mnemocyte-schema.ts";

/** `sql` indented under a step of a printed list. */
function indent(sql: string): string {
	return sql
		.trimEnd()
		.split("\n")
		.map((line) => `       ${line}`)
		.join("\n");
}

/**
 * The steps after a first `generate`: the schema entry, the two custom
 * migrations drizzle-kit cannot write, and the commands in order. `run` is
 * what runs a bin in the project, such as `pnpm exec`.
 */
export function drizzleNextSteps(input: {
	readonly file: string;
	readonly dimensions: number;
	readonly schema?: string | null;
	readonly run: string;
}): string {
	const { run } = input;
	const setup = renderDrizzleSetupSql(input);
	return `Next, with drizzle-kit:
  1. Add "${input.file}" to schema in drizzle.config.ts.
  2. Unless pgvector is enabled already, run
       ${run} drizzle-kit generate --custom --name=pgvector
     and put this in the new migration:
${indent(setup.before)}
  3. ${run} drizzle-kit generate
  4. ${run} drizzle-kit generate --custom --name=mnemocyte
     and put this in the new migration:
${indent(setup.after)}
  5. ${run} drizzle-kit migrate, then ${run} mnemocyte check
drizzle-kit manages these tables now. Do not run mnemocyte migrate on them,
and do not use drizzle-kit push, which drops the key index.
`;
}

/**
 * The steps after `generate` replaced its file. A new text search
 * configuration needs the `content_tsv` index added to drizzle-kit's
 * migration, because drizzle-kit drops the column with its index.
 */
export function drizzleUpdateSteps(input: {
	readonly textSearchChanged: boolean;
	readonly schema?: string | null;
	readonly run: string;
}): string {
	const { run } = input;
	const steps = `Next: ${run} drizzle-kit generate, read the new migration, then
${run} drizzle-kit migrate.
`;
	if (!input.textSearchChanged) {
		return steps;
	}
	return `${steps}
The text search configuration changed. drizzle-kit drops content_tsv and
adds it back, which drops its index, so add this to the end of the new
migration before you apply it:
${indent(renderDrizzleTextSearchIndexSql(input))}
`;
}

/** `path` as drizzle.config.ts names it: relative, `./`, forward slashes. */
function configPath(cwd: string, path: string): string {
	const relativePath = relative(cwd, path).split(sep).join("/");
	return relativePath.startsWith("../") ? relativePath : `./${relativePath}`;
}

/**
 * Throw unless the file at `out` is for the same dimensions and schema.
 * drizzle-kit would turn a new size into an `ALTER` of the embedding
 * column and a new schema into moved or new tables, while the
 * installation row keeps the old size; `migrate` refuses both for the same
 * reason.
 *
 * @throws {CliError} With exit code 2 when either differs.
 */
function assertSameInstallation(
	out: string,
	existing: string,
	wanted: DrizzleSchemaShape,
): void {
	const found = readDrizzleSchemaShape(existing);
	if (found === null) {
		throw new CliError(
			`${out} was changed by hand: its embedding column is not the one generate writes, so it was left as is. Restore it from version control, or pass --out <file> to write somewhere else.`,
			EXIT_USAGE,
		);
	}
	const where = (schema: string | null) =>
		schema === null ? "search_path" : `schema ${schema}`;
	if (found.dimensions !== wanted.dimensions) {
		throw new CliError(
			`${out} is for ${found.dimensions} dimensions, not ${wanted.dimensions}. An installation keeps its embedding size, so it was left as is. Use an embedder with ${found.dimensions} dimensions, or pass --out <file> for a new installation in another database or schema.`,
			EXIT_USAGE,
		);
	}
	if (found.schema !== wanted.schema) {
		throw new CliError(
			`${out} puts the tables in ${where(found.schema)}, not ${where(wanted.schema)}, so it was left as is. generate does not move an installation; see the Postgres guide on moving one.`,
			EXIT_USAGE,
		);
	}
}

async function readExisting(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw error;
	}
}

/**
 * `mnemocyte generate --adapter drizzle`: write the tables as a Drizzle
 * schema for drizzle-kit. It never queries a database; the size and schema
 * come from the flags or the memory file, as for `sql`.
 *
 * The file is replaced only when it starts with
 * {@link DRIZZLE_SCHEMA_HEADER}, since running the command again is how a
 * schema follows a new Mnemocyte release or text search configuration. Any
 * other file at the path is left alone (exit 2). A new file is created
 * with `wx` (`O_CREAT | O_EXCL`), so one that appears after the check is
 * kept too.
 *
 * @returns The exit code.
 */
export async function generateCommand(
	args: CliArgs,
	io: CliIo,
	version: string,
): Promise<number> {
	const { dimensions, schema } = await resolveSchemaShape(args, io);
	const textSearchConfig = args.textSearchConfig ?? DEFAULT_TEXT_SEARCH_CONFIG;
	const source = renderDrizzleSchema({
		dimensions,
		textSearchConfig,
		schema: schema ?? null,
		version,
	});
	const out = args.out ?? DEFAULT_DRIZZLE_SCHEMA_FILE;
	const path = resolve(io.cwd, out);
	const run = await projectRunner(io.cwd);
	const what = `${dimensions} dimensions, text search configuration ${textSearchConfig}${schema === undefined ? "" : `, schema ${schema}`}`;
	const firstSteps = drizzleNextSteps({
		file: configPath(io.cwd, path),
		dimensions,
		schema: schema ?? null,
		run,
	});

	if (args.dryRun) {
		io.write(source);
		io.error(`\n${firstSteps}`);
		return 0;
	}

	const existing = await readExisting(path);
	if (existing !== null && !existing.startsWith(DRIZZLE_SCHEMA_HEADER)) {
		throw new CliError(
			`${out} exists and was not written by mnemocyte generate, so it was left as is. Pass --out <file> to write somewhere else.`,
			EXIT_USAGE,
		);
	}
	if (existing !== null) {
		assertSameInstallation(out, existing, {
			dimensions,
			schema: schema ?? null,
		});
	}
	if (existing === source) {
		io.write(`${out} is up to date (${what}).\n`);
		return 0;
	}
	if (existing === null) {
		await mkdir(dirname(path), { recursive: true });
		try {
			await writeFile(path, source, { flag: "wx" });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				throw new CliError(
					`${out} appeared while generate ran, so it was left as is.`,
					EXIT_USAGE,
				);
			}
			throw error;
		}
		io.write(`Wrote ${out} (${what}).\n\n${firstSteps}`);
		return 0;
	}
	await writeFile(path, source);
	const textSearchChanged = !existing.includes(
		drizzleContentTsvSource(textSearchConfig),
	);
	io.write(
		`Updated ${out} (${what}).\n\n${drizzleUpdateSteps({ textSearchChanged, schema: schema ?? null, run })}`,
	);
	return 0;
}
