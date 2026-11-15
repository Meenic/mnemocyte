import { parseArgs } from "node:util";
import { assertMigrateDimensions } from "../memory/validation.js";
import { CliError, EXIT_USAGE } from "./io.js";

export type CliCommand =
	| "init"
	| "migrate"
	| "check"
	| "sql"
	| "help"
	| "version";

/** The command line, validated. */
export interface CliArgs {
	readonly command: CliCommand;
	/** `--config`: the memory file, relative to the working directory. */
	readonly config?: string;
	/** `--env-file`: loaded instead of `./.env`. */
	readonly envFile?: string;
	/** `--dimensions`: 1 to 4,000. */
	readonly dimensions?: number;
	/** `--yes`: enable pgvector without asking. */
	readonly yes: boolean;
	/** `--dry-run`: report what `migrate` or `init` would do. */
	readonly dryRun: boolean;
	/** `--json`: print one JSON result for `check` or `migrate --dry-run`. */
	readonly json: boolean;
	/** `--out`: where `sql` writes instead of standard output. */
	readonly out?: string;
}

export const USAGE: string = `Usage: mnemocyte <command> [options]

Commands
  init      Write a memory.ts for the driver in package.json
  migrate   Create or upgrade the Mnemocyte schema
  check     Report pgvector, migrations and dimensions; exit 1 on a problem
  sql       Print the fresh-install schema, without a database

Options
  -c, --config <path>    Memory file to load (default: memory.ts, .mts, .js
                         or .mjs in ., lib, src or src/lib)
      --dimensions <n>   Embedding dimensions, when no memory file gives them
      --env-file <path>  Load this file instead of ./.env
  -y, --yes              migrate: enable pgvector without asking
      --dry-run          migrate, init: show what would run and change nothing
      --json             check, migrate --dry-run: print the result as JSON
      --out <file>       sql: write to a file instead of standard output
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
]);

/** Flags that only some commands read; anywhere else they are a mistake. */
const COMMAND_FLAGS = {
	yes: ["migrate"],
	"dry-run": ["migrate", "init"],
	json: ["check", "migrate"],
	out: ["sql"],
} as const satisfies Record<string, readonly CliCommand[]>;

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
		throw usageError("Name a command: init, migrate, check or sql.");
	}
	if (!COMMANDS.has(command)) {
		throw usageError(
			`Unknown command "${command}". Commands: init, migrate, check, sql.`,
		);
	}
	if (rest.length > 0) {
		throw usageError(`Unexpected argument "${rest[0]}".`);
	}
	for (const flag of ["yes", "dry-run", "json", "out"] as const) {
		const owners: readonly string[] = COMMAND_FLAGS[flag];
		if (values[flag] !== undefined && !owners.includes(command)) {
			throw usageError(
				`--${flag} applies to ${owners.join(" and ")}, not to ${command}.`,
			);
		}
	}
	// A real migrate can ask about pgvector on standard output, which would
	// break the JSON, so --json reports only the plan.
	if (
		command === "migrate" &&
		values.json === true &&
		values["dry-run"] !== true
	) {
		throw usageError("--json on migrate needs --dry-run.");
	}
	if (command === "init") {
		for (const flag of NOT_FOR_INIT) {
			if (values[flag] !== undefined) {
				throw usageError(`--${flag} does not apply to init.`);
			}
		}
	}
	for (const flag of ["config", "env-file", "out"] as const) {
		if (values[flag] === "") {
			throw usageError(`--${flag} needs a path.`);
		}
	}

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
	};
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			config: { type: "string", short: "c" },
			dimensions: { type: "string" },
			"env-file": { type: "string" },
			yes: { type: "boolean", short: "y" },
			"dry-run": { type: "boolean" },
			json: { type: "boolean" },
			out: { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}
