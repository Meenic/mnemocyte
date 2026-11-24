import { parseArgs } from "node:util";
import { assertSchemaName } from "../db/tables.js";
import {
	assertMigrateDimensions,
	assertTextSearchConfigName,
} from "../memory/validation.js";
import { INIT_EMBEDDERS, type InitEmbedder } from "./init.js";
import { CliError, EXIT_USAGE } from "./io.js";

export type CliCommand =
	| "init"
	| "migrate"
	| "check"
	| "sql"
	| "generate"
	| "text-search"
	| "help"
	| "version";

/** The command line, validated. */
export interface CliArgs {
	readonly command: CliCommand;
	/** `--config`: the memory file, relative to the working directory. */
	readonly config?: string;
	/** `--env-file`: loaded instead of `./.env.local` and `./.env`. */
	readonly envFile?: string;
	/** `--dimensions`: 1 to 4,000. */
	readonly dimensions?: number;
	/**
	 * `--text-search-config` for `migrate`, `check`, `sql` and `generate`, or the name
	 * `text-search` takes.
	 */
	readonly textSearchConfig?: string;
	/**
	 * `--schema`: the schema of the tables, for a run without a memory file
	 * (the memory file's `postgresStore()` names its own).
	 */
	readonly schema?: string;
	/** `--yes`: enable pgvector, or rewrite for `text-search`, without asking. */
	readonly yes: boolean;
	/**
	 * `--dry-run`: report what `migrate`, `init` or `text-search` would do;
	 * `generate` prints the file instead of writing it.
	 */
	readonly dryRun: boolean;
	/**
	 * `--json`: print one JSON result for `check`, `migrate --dry-run` or
	 * `text-search --dry-run`.
	 */
	readonly json: boolean;
	/**
	 * `--out`: where `sql` writes instead of standard output, or the file
	 * `generate` writes.
	 */
	readonly out?: string;
	/** `--embedder`: the embedder `init` writes; `openai` when left out. */
	readonly embedder?: InitEmbedder;
	/** `--db`: the file with the app's Drizzle client, for `init`. */
	readonly db?: string;
	/** `--adapter`: the schema format `generate` writes. */
	readonly adapter?: GenerateAdapter;
}

/** The formats `generate --adapter` writes. */
export const GENERATE_ADAPTERS = ["drizzle"] as const;

export type GenerateAdapter = (typeof GENERATE_ADAPTERS)[number];

export const USAGE: string = `Usage: mnemocyte <command> [options]

Commands
  init                Write a memory.ts that uses the app's Drizzle client,
                      or one for the driver in package.json
  migrate             Create or upgrade the Mnemocyte schema
  check               Report pgvector, migrations and dimensions; exit 1 on
                      a problem
  sql                 Print the fresh-install schema, without a database
  generate            Write the tables as a schema for another tool
                      (--adapter drizzle), without a database
  text-search <name>  Change the text search configuration of keyword
                      search; rewrites the memories table

Options
  -c, --config <path>    Memory file to load (default: memory.ts, .mts, .js
                         or .mjs in ., lib, src or src/lib)
      --dimensions <n>   Embedding dimensions, when no memory file gives them
      --text-search-config <name>
                         migrate, sql, generate: the text search
                         configuration of a fresh install (default:
                         english); check: the one expected
      --schema <name>    The Postgres schema of the tables, when no memory
                         file names one (default: search_path, usually
                         public)
      --env-file <path>  Load this file instead of ./.env.local and ./.env
  -y, --yes              migrate: enable pgvector without asking;
                         text-search: rewrite without asking
      --dry-run          migrate, init, text-search: show what would run and
                         change nothing; generate: print the file
      --embedder <name>  init: openai (default) or openai-compatible, such
                         as a local Ollama
      --db <path>        init: the file that exports the app's Drizzle
                         client, when init does not find it
      --json             check, migrate --dry-run, text-search --dry-run:
                         print the result as JSON
      --out <file>       sql: write to a file instead of standard output;
                         generate: the file to write (default:
                         mnemocyte-schema.ts)
      --adapter <name>   generate: drizzle, a Drizzle schema for drizzle-kit
  -h, --help             Show this help
  -v, --version          Show the version

Without a memory file, migrate and check connect to DATABASE_URL with the
"postgres" package and take the embedding size from --dimensions.
`;

const COMMANDS: ReadonlySet<string> = new Set([
	"init",
	"migrate",
	"check",
	"sql",
	"generate",
	"text-search",
]);

/** Flags that only some commands read; anywhere else they are a mistake. */
const COMMAND_FLAGS = {
	yes: ["migrate", "text-search"],
	"dry-run": ["migrate", "init", "generate", "text-search"],
	json: ["check", "migrate", "text-search"],
	out: ["sql", "generate"],
	embedder: ["init"],
	db: ["init"],
	adapter: ["generate"],
	"text-search-config": ["migrate", "check", "sql", "generate"],
	schema: ["migrate", "check", "sql", "generate", "text-search"],
} as const satisfies Record<string, readonly CliCommand[]>;

/** The commands whose `--json` needs `--dry-run`. */
const JSON_NEEDS_DRY_RUN: ReadonlySet<string> = new Set([
	"migrate",
	"text-search",
]);

/** Flags every command but `init` reads: it loads no memory file. */
const NOT_FOR_INIT = ["config", "env-file", "dimensions"] as const;

function usageError(message: string): CliError {
	return new CliError(message, EXIT_USAGE);
}

function parseDimensions(value: string): number {
	// Digits only: Number() would also take "1e3", " 12" and "0x10".
	const dimensions = /^\d+$/.test(value) ? Number(value) : Number.NaN;
	try {
		assertMigrateDimensions(dimensions, "--dimensions");
	} catch (error) {
		throw usageError(error instanceof Error ? error.message : String(error));
	}
	return dimensions;
}

function parseSchema(value: string): string {
	try {
		assertSchemaName(value, "--schema");
	} catch (error) {
		throw usageError(error instanceof Error ? error.message : String(error));
	}
	return value;
}

function parseTextSearchConfig(value: string, field: string): string {
	try {
		assertTextSearchConfigName(value, field);
	} catch (error) {
		throw usageError(error instanceof Error ? error.message : String(error));
	}
	return value;
}

/**
 * Parse the arguments after `mnemocyte`.
 *
 * @throws {CliError} With exit code 2 for an unknown command or flag, a
 * flag another command owns, or a malformed value.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		// parseArgs reports unknown options and missing values as TypeErrors
		// whose messages already name the flag. Its advice about positional
		// arguments that start with "-" does not apply here.
		const message = error instanceof Error ? error.message : String(error);
		throw usageError(message.split(" To specify")[0] ?? message);
	}
	const { values, positionals } = parsed;

	if (values.help === true || positionals[0] === "help") {
		return { command: "help", yes: false, dryRun: false, json: false };
	}
	if (values.version === true) {
		return { command: "version", yes: false, dryRun: false, json: false };
	}
	const [command, ...rest] = positionals;
	if (command === undefined) {
		throw usageError(
			"Name a command: init, migrate, check, sql, generate or text-search.",
		);
	}
	if (!COMMANDS.has(command)) {
		throw usageError(
			`Unknown command "${command}". Commands: init, migrate, check, sql, generate, text-search.`,
		);
	}
	// text-search takes the configuration's name; no other command takes an
	// argument.
	const [name, ...extra] = command === "text-search" ? rest : [];
	if (command === "text-search" && name === undefined) {
		throw usageError(
			"Name the text search configuration: mnemocyte text-search <name>, such as simple.",
		);
	}
	const unexpected = command === "text-search" ? extra : rest;
	if (unexpected.length > 0) {
		throw usageError(`Unexpected argument "${unexpected[0]}".`);
	}
	for (const flag of [
		"yes",
		"dry-run",
		"json",
		"out",
		"embedder",
		"db",
		"adapter",
		"text-search-config",
		"schema",
	] as const) {
		const owners: readonly string[] = COMMAND_FLAGS[flag];
		if (values[flag] !== undefined && !owners.includes(command)) {
			const last = owners.at(-1);
			const list =
				owners.length > 1
					? `${owners.slice(0, -1).join(", ")} and ${last}`
					: `${last}`;
			throw usageError(`--${flag} applies to ${list}, not to ${command}.`);
		}
	}
	// A real migrate or text-search can ask on standard output, which would
	// break the JSON, so --json reports only the plan.
	if (
		JSON_NEEDS_DRY_RUN.has(command) &&
		values.json === true &&
		values["dry-run"] !== true
	) {
		throw usageError(`--json on ${command} needs --dry-run.`);
	}
	if (command === "init") {
		for (const flag of NOT_FOR_INIT) {
			if (values[flag] !== undefined) {
				throw usageError(`--${flag} does not apply to init.`);
			}
		}
	}
	if (command === "text-search" && values.dimensions !== undefined) {
		throw usageError("--dimensions does not apply to text-search.");
	}
	for (const flag of ["config", "env-file", "out", "db"] as const) {
		if (values[flag] === "") {
			throw usageError(`--${flag} needs a path.`);
		}
	}
	const embedder = values.embedder;
	if (embedder !== undefined && !isInitEmbedder(embedder)) {
		throw usageError(
			`Unknown embedder "${embedder}". Embedders: ${INIT_EMBEDDERS.join(", ")}.`,
		);
	}
	const adapter = values.adapter;
	if (command === "generate" && adapter === undefined) {
		throw usageError(
			`generate needs --adapter: ${GENERATE_ADAPTERS.join(", ")}.`,
		);
	}
	if (adapter !== undefined && !isGenerateAdapter(adapter)) {
		throw usageError(
			`Unknown adapter "${adapter}". Adapters: ${GENERATE_ADAPTERS.join(", ")}.`,
		);
	}

	const textSearchConfig =
		name !== undefined
			? parseTextSearchConfig(name, "The configuration name")
			: values["text-search-config"] === undefined
				? undefined
				: parseTextSearchConfig(
						values["text-search-config"],
						"--text-search-config",
					);

	return {
		command: command as CliCommand,
		yes: values.yes === true,
		dryRun: values["dry-run"] === true,
		json: values.json === true,
		...(values.config === undefined ? {} : { config: values.config }),
		...(values["env-file"] === undefined
			? {}
			: { envFile: values["env-file"] }),
		...(values.dimensions === undefined
			? {}
			: { dimensions: parseDimensions(values.dimensions) }),
		...(values.out === undefined ? {} : { out: values.out }),
		...(embedder === undefined ? {} : { embedder }),
		...(values.db === undefined ? {} : { db: values.db }),
		...(adapter === undefined ? {} : { adapter }),
		...(textSearchConfig === undefined ? {} : { textSearchConfig }),
		...(values.schema === undefined
			? {}
			: { schema: parseSchema(values.schema) }),
	};
}

function isInitEmbedder(value: string): value is InitEmbedder {
	return (INIT_EMBEDDERS as readonly string[]).includes(value);
}

function isGenerateAdapter(value: string): value is GenerateAdapter {
	return (GENERATE_ADAPTERS as readonly string[]).includes(value);
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			config: { type: "string", short: "c" },
			dimensions: { type: "string" },
			"text-search-config": { type: "string" },
			schema: { type: "string" },
			"env-file": { type: "string" },
			yes: { type: "boolean", short: "y" },
			"dry-run": { type: "boolean" },
			json: { type: "boolean" },
			out: { type: "string" },
			embedder: { type: "string" },
			db: { type: "string" },
			adapter: { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}
