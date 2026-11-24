import { statSync } from "node:fs";
import { join } from "node:path";

/** Folders searched for a memory file, in order, relative to the project. */
export const MEMORY_FILE_DIRECTORIES: readonly string[] = [
	"",
	"lib",
	"src",
	"src/lib",
];

/** File names tried in each folder, in order. */
export const MEMORY_FILE_NAMES: readonly string[] = [
	"memory.ts",
	"memory.mts",
	"memory.js",
	"memory.mjs",
];

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** The first memory file in the project, or null. */
export function findMemoryFile(cwd: string): string | null {
	for (const directory of MEMORY_FILE_DIRECTORIES) {
		for (const name of MEMORY_FILE_NAMES) {
			const candidate = join(cwd, directory, name);
			if (isFile(candidate)) {
				return candidate;
			}
		}
	}
	return null;
}
