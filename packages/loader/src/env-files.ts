import { statSync } from "node:fs";
import { join } from "node:path";

/**
 * The environment files read from the project, in order: Next.js's order
 * for these two (ARCHITECTURE decision 78). The `.env.$(NODE_ENV)` files
 * are left out, since the bins run outside a mode.
 */
export const ENV_FILE_NAMES: readonly string[] = [".env.local", ".env"];

/** Input of {@link loadEnvFiles}. */
export interface LoadEnvFilesInput {
	/** The project folder the files are read from. */
	readonly directory: string;
}

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Load `.env.local`, then `.env`, from the project into `process.env`, each
 * when it exists. `.env.local` is skipped when `NODE_ENV` is `test`, as in
 * Next.js, so tests do not depend on one machine's overrides; only the real
 * environment's `NODE_ENV` counts, since no file is read before the check.
 * `process.loadEnvFile` keeps a variable that is already set, so the real
 * environment wins over both files and `.env.local` over `.env`.
 *
 * @returns The names of the files that were read, in order.
 */
export function loadEnvFiles(input: LoadEnvFilesInput): string[] {
	const skipLocal = process.env.NODE_ENV === "test";
	const loaded: string[] = [];
	for (const name of ENV_FILE_NAMES) {
		if (skipLocal && name === ".env.local") {
			continue;
		}
		const path = join(input.directory, name);
		if (isFile(path)) {
			process.loadEnvFile(path);
			loaded.push(name);
		}
	}
	return loaded;
}
