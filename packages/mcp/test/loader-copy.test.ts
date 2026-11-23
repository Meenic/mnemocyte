import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	MEMORY_FILE_DIRECTORIES,
	MEMORY_FILE_NAMES,
} from "../src/cli/memory-file.js";

// The bin loads a memory file the way the `mnemocyte` CLI does. The resolve
// hook and the tsconfig reader are copies of the CLI's, which has the tests
// for them; these checks fail when one side changes without the other.

function read(path: string): string {
	return readFileSync(new URL(path, import.meta.url), "utf8").replaceAll(
		"\r\n",
		"\n",
	);
}

function arrayLiteral(source: string, name: string): string[] {
	const match = new RegExp(
		`export const ${name}: readonly string\\[\\] = \\[([^\\]]*)\\]`,
	).exec(source);
	if (match?.[1] === undefined) {
		throw new Error(`${name} not found.`);
	}
	return [...match[1].matchAll(/"([^"]*)"/g)].map((item) => item[1] ?? "");
}

describe("the copy of the CLI's loader", () => {
	it.each(["resolve-hook.ts", "tsconfig.ts"])("%s is unchanged", (file) => {
		expect(read(`../src/loader/${file}`)).toBe(
			read(`../../mnemocyte/src/cli/${file}`),
		);
	});

	it("looks for the same memory files", () => {
		const cli = read("../../mnemocyte/src/cli/memory-file.ts");
		expect(MEMORY_FILE_DIRECTORIES).toEqual(
			arrayLiteral(cli, "MEMORY_FILE_DIRECTORIES"),
		);
		expect(MEMORY_FILE_NAMES).toEqual(arrayLiteral(cli, "MEMORY_FILE_NAMES"));
	});
});
