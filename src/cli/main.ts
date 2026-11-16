import { type CliArgs, parseCliArgs, USAGE } from "./args.js";
import { checkCommand } from "./check.js";
import { initCommand } from "./init.js";
import { CliError, type CliIo, errorCauses } from "./io.js";
import { errorJson, writeJson } from "./json.js";
import { migrateCommand } from "./migrate.js";
import { sqlCommand } from "./sql.js";
import { textSearchCommand } from "./text-search.js";

/**
 * An error as the CLI prints it: its message, then each `cause` (see
 * {@link errorCauses}).
 */
export function describeError(error: unknown): string {
	const lines = [
		`mnemocyte: ${error instanceof Error ? error.message : String(error)}`,
		...errorCauses(error).map((cause) => `  cause: ${cause}`),
	];
	return `${lines.join("\n")}\n`;
}

function run(args: CliArgs, io: CliIo, version: string): Promise<number> {
	switch (args.command) {
		case "help":
			io.write(USAGE);
			return Promise.resolve(0);
		case "version":
			io.write(`${version}\n`);
			return Promise.resolve(0);
		case "init":
			return initCommand(args, io);
		case "migrate":
			return migrateCommand(args, io);
		case "check":
			return checkCommand(args, io);
		case "sql":
			return sqlCommand(args, io);
		case "text-search":
			return textSearchCommand(args, io);
	}
}

/**
 * Run the CLI on `argv` (the arguments after `mnemocyte`) and resolve with
 * its exit code: 0 on success, 1 when a command found or hit a problem, 2
 * when it could not run (bad flags, no memory file, no connection for
 * `check`). It never rejects and never exits the process; the bin does
 * that, because the app's database client would keep the process alive.
 */
export async function main(
	argv: readonly string[],
	io: CliIo,
	version: string,
): Promise<number> {
	let args: CliArgs;
	try {
		args = parseCliArgs(argv);
	} catch (error) {
		io.error(`${describeError(error)}\n${USAGE}`);
		return error instanceof CliError ? error.exitCode : 1;
	}
	try {
		return await run(args, io, version);
	} catch (error) {
		// With --json, standard output still gets one result to read, and the
		// text goes to standard error for the log as without it.
		if (
			args.json &&
			(args.command === "check" ||
				args.command === "migrate" ||
				args.command === "text-search")
		) {
			writeJson(io, errorJson(args.command, error));
		}
		io.error(describeError(error));
		return error instanceof CliError ? error.exitCode : 1;
	}
}
