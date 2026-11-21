import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readMemoryClientInternals } from "../memory/client-internals.js";
import type { MemoryStore } from "../memory/store.js";
import type { BoundMemoryClient, Embedder, MemoryClient } from "../types.js";
import { CliError, EXIT_USAGE } from "./io.js";
import { registerAppResolver } from "./resolve-hook.js";

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

/** What the CLI takes from the app's memory file. */
export interface LoadedMemory {
	/** Absolute path of the file. */
	readonly file: string;
	readonly memory: MemoryClient<boolean> | BoundMemoryClient;
	readonly store: MemoryStore;
	readonly embedder: Embedder;
}

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

/**
 * The memory file a command uses: `--config` when given, which must exist,
 * otherwise the first one found, or null.
 *
 * @throws {CliError} With exit code 2 when `--config` names no file.
 */
export function locateMemoryFile(
	cwd: string,
	config: string | undefined,
): string | null {
	if (config === undefined) {
		return findMemoryFile(cwd);
	}
	const file = resolve(cwd, config);
	if (!isFile(file)) {
		throw new CliError(`--config: ${config} is not a file.`, EXIT_USAGE);
	}
	return file;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return typeof error.code === "string" ? error.code : undefined;
}

function firstLine(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n")[0]?.trim() ?? "";
}

const BUILD_HINT =
	"Build the file and pass --config <built .js>, or call migrate({ memory }) from a script of your own.";

function loadError(name: string, error: unknown): CliError {
	const detail = firstLine(error);
	switch (errorCode(error)) {
		case "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX":
			return new CliError(
				`${name} uses TypeScript syntax Node cannot run (${detail}). Node loads TypeScript by removing the types, so enums, namespaces with code and parameter properties do not load. ${BUILD_HINT}`,
				EXIT_USAGE,
				error,
			);
		case "ERR_UNKNOWN_FILE_EXTENSION":
			return new CliError(
				`Node cannot load ${name} (${detail}). .tsx files are not supported, and neither is a Node started with type stripping turned off. ${BUILD_HINT}`,
				EXIT_USAGE,
				error,
			);
		case "ERR_MODULE_NOT_FOUND":
			return new CliError(
				`${name} imports a module that was not found (${detail}). The CLI resolves relative imports without an extension or with ".js" for a ".ts" file, and tsconfig "paths"; for other aliases, ${BUILD_HINT.charAt(0).toLowerCase()}${BUILD_HINT.slice(1)}`,
				EXIT_USAGE,
				error,
			);
		default:
			return new CliError(
				`Loading ${name} failed: ${detail}`,
				EXIT_USAGE,
				error,
			);
	}
}

/**
 * Import the app's memory file and read its client.
 *
 * The file is loaded with `import()`. For a `.ts` file Node removes the
 * types itself (type stripping, on by default from Node 22.18), and
 * {@link registerAppResolver} adds the import forms that needs. The client
 * is the `memory` export, or the default export (or its `memory`) when
 * there is none.
 *
 * @throws {CliError} With exit code 2 when the file does not load or
 * exports no client from `createMemory()`.
 */
export async function loadMemoryFile(
	file: string,
	cwd: string,
): Promise<LoadedMemory> {
	const name = relative(cwd, file).replaceAll("\\", "/") || file;
	registerAppResolver();
	let exports: Record<string, unknown>;
	try {
		exports = (await import(pathToFileURL(file).href)) as Record<
			string,
			unknown
		>;
	} catch (error) {
		throw loadError(name, error);
	}

	const fallback = exports.default;
	const candidates = [
		exports.memory,
		typeof fallback === "object" && fallback !== null && "memory" in fallback
			? fallback.memory
			: undefined,
		fallback,
	];
	for (const candidate of candidates) {
		if (candidate === undefined) {
			continue;
		}
		try {
			const { store, embedder } = readMemoryClientInternals(candidate);
			return {
				file,
				// `readMemoryClientInternals` accepted it, so it came from
				// createMemory() or memory.for().
				memory: candidate as MemoryClient<boolean> | BoundMemoryClient,
				store,
				embedder,
			};
		} catch {
			// Not a client; try the next export.
		}
	}
	throw new CliError(
		`${name} does not export a memory client. Export the result of createMemory() as "memory": export const memory = createMemory({ ... });`,
		EXIT_USAGE,
	);
}
