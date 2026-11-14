import { type CliArgs, parseCliArgs, USAGE } from "./args.js";
import { checkCommand } from "./check.js";
import { CliError, type CliIo } from "./io.js";
import { migrateCommand } from "./migrate.js";
import { sqlCommand } from "./sql.js";

/** How many `cause` links an error report follows. */
const MAX_CAUSE_DEPTH = 3;

/**
 * An error as the CLI prints it: its message, then each `cause`. A
 * `MnemocyteError` keeps the driver's error as its cause, and that is where
 * "connection refused" or "permission denied" is.
 */
export function describeError(error: unknown): string {
	const lines = [
		`mnemocyte: ${error instanceof Error ? error.message : String(error)}`,
	];
	let cause: unknown = error instanceof Error ? error.cause : undefined;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause != null; depth += 1) {
		let detail: string;
		if (cause instanceof Error) {
			const code =
				"code" in cause && typeof cause.code === "string" ? cause.code : "";
			detail = cause.message.trim().replace(/\s+/g, " ") || code;
		} else {
			detail = String(cause);
		}
		// A message that already quotes its cause is not repeated.
		if (detail !== "" && !lines.some((line) => line.includes(detail))) {
			lines.push(`  cause: ${detail}`);
		}
		cause = cause instanceof Error ? cause.cause : undefined;
	}
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
		case "migrate":
			return migrateCommand(args, io);
		case "check":
			return checkCommand(args, io);
		case "sql":
			return sqlCommand(args, io);
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
		io.error(describeError(error));
		return error instanceof CliError ? error.exitCode : 1;
	}
}
