import { createInterface } from "node:readline";

/**
 * Everything the CLI touches outside the database and the file system, so
 * tests can run a command in process and read what it printed.
 */
export interface CliIo {
	/** The project folder: where the memory file and `.env` are looked up. */
	readonly cwd: string;
	/** Write to standard output. */
	write(text: string): void;
	/** Write to standard error. */
	error(text: string): void;
	/**
	 * Ask a yes/no question. Resolves with `undefined` when there is no
	 * terminal to ask on (a pipe, CI), so the caller never waits for input
	 * that cannot come.
	 */
	confirm(question: string): Promise<boolean | undefined>;
}

/** Thrown for a failure the CLI explains itself, with the exit code to use. */
export class CliError extends Error {
	readonly exitCode: number;

	constructor(message: string, exitCode: number, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "CliError";
		this.exitCode = exitCode;
	}
}

/** Exit code for a command that could not run: bad flags, no memory file. */
export const EXIT_USAGE = 2;

/** The process's own streams and terminal. */
export function createProcessIo(): CliIo {
	return {
		cwd: process.cwd(),
		write(text) {
			process.stdout.write(text);
		},
		error(text) {
			process.stderr.write(text);
		},
		confirm(question) {
			if (!process.stdin.isTTY || !process.stdout.isTTY) {
				return Promise.resolve(undefined);
			}
			return new Promise((resolve) => {
				const prompt = createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				let answered = false;
				prompt.question(question, (answer) => {
					answered = true;
					prompt.close();
					resolve(/^y(es)?$/i.test(answer.trim()));
				});
				// Ctrl+C or a closed terminal counts as "no". Without the SIGINT
				// listener readline only pauses the input, and an open database
				// pool would keep the process alive.
				prompt.once("SIGINT", () => prompt.close());
				prompt.once("close", () => {
					if (!answered) {
						process.stdout.write("\n");
						resolve(false);
					}
				});
			});
		},
	};
}
