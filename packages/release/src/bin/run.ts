// What the three commands share: the repository root, the argument parser
// and one-line errors.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ReleaseError } from "../release.ts";

/** The repository root, from packages/release/src/bin/. */
export const ROOT: string = join(import.meta.dirname, "..", "..", "..", "..");

/**
 * Runs a command: prints `usage` for --help, exits 2 on a usage error and 1
 * on a release error, each as one line on standard error.
 */
export function run(
	usage: string,
	main: (positionals: readonly string[]) => number,
): void {
	let positionals: string[];
	try {
		const parsed = parseArgs({
			allowPositionals: true,
			options: { help: { type: "boolean", short: "h" } },
		});
		if (parsed.values.help) {
			process.stdout.write(`${usage}\n`);
			return;
		}
		positionals = parsed.positionals;
	} catch (error) {
		process.stderr.write(`${(error as Error).message}\n`);
		process.exitCode = usageError(usage);
		return;
	}
	try {
		process.exitCode = main(positionals);
	} catch (error) {
		if (!(error instanceof ReleaseError)) throw error;
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	}
}

/** Prints the usage on standard error and returns exit code 2. */
export function usageError(usage: string): number {
	process.stderr.write(`${usage}\n`);
	return 2;
}

/** Today's date where the command runs, `YYYY-MM-DD`. */
export function today(): string {
	const now = new Date();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}
