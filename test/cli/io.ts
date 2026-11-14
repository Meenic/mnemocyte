import type { CliIo } from "../../src/cli/io.js";

export interface TestIo extends CliIo {
	/** Everything written to standard output so far. */
	stdout(): string;
	/** Everything written to standard error so far. */
	stderr(): string;
	/** The questions `confirm` was asked. */
	readonly questions: string[];
}

/**
 * A {@link CliIo} that records output. `answer` is what the terminal says
 * to a question: `true` or `false`, or `undefined` for no terminal.
 */
export function createTestIo(cwd: string, answer?: boolean): TestIo {
	let out = "";
	let err = "";
	const questions: string[] = [];
	return {
		cwd,
		questions,
		write(text) {
			out += text;
		},
		error(text) {
			err += text;
		},
		async confirm(question) {
			questions.push(question);
			return answer;
		},
		stdout: () => out,
		stderr: () => err,
	};
}
