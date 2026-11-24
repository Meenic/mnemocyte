import { statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { findMemoryFile, registerAppResolver } from "@mnemocyte/loader";
import type { MemoryClient } from "mnemocyte";
import { UsageError } from "./args.js";

// The lookup and the resolve hook come from @mnemocyte/loader, the private
// package the `mnemocyte` CLI bundles too, so both bins find and load the
// same file. Reading the client uses only the public API: the CLI's symbol
// for the store and embedder is not needed to call `for`.

/** An unbound client, as `createMemory` returns it. */
export type UnboundMemoryClient = MemoryClient<boolean>;

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The memory file to load: `--config` when given, which must exist,
 * otherwise the first one found.
 *
 * @throws {UsageError} When `--config` names no file or no file is found.
 */
export function locateMemoryFile(
	cwd: string,
	config: string | undefined,
): string {
	if (config !== undefined) {
		const file = resolve(cwd, config);
		if (!isFile(file)) {
			throw new UsageError(`--config: ${config} is not a file.`);
		}
		return file;
	}
	const found = findMemoryFile(cwd);
	if (found === null) {
		throw new UsageError(
			`No memory file found in ${cwd}. Pass --config <file> with the file that exports createMemory()'s client.`,
		);
	}
	return found;
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

const BUILD_HINT = "Build the file and pass --config <built .js>.";

function loadError(name: string, error: unknown): UsageError {
	const detail = firstLine(error);
	switch (errorCode(error)) {
		case "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX":
			return new UsageError(
				`${name} uses TypeScript syntax Node cannot run (${detail}). Node loads TypeScript by removing the types, so enums, namespaces with code and parameter properties do not load. ${BUILD_HINT}`,
				{ cause: error },
			);
		case "ERR_UNKNOWN_FILE_EXTENSION":
			return new UsageError(
				`Node cannot load ${name} (${detail}). .tsx files are not supported, and neither is a Node started with type stripping turned off. ${BUILD_HINT}`,
				{ cause: error },
			);
		case "ERR_MODULE_NOT_FOUND":
			return new UsageError(
				`${name} imports a module that was not found (${detail}). Relative imports resolve without an extension or with ".js" for a ".ts" file, and through tsconfig "paths"; for other aliases, build the file and pass --config <built .js>.`,
				{ cause: error },
			);
		default:
			return new UsageError(`Loading ${name} failed: ${detail}`, {
				cause: error,
			});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isUnboundClient(value: unknown): value is UnboundMemoryClient {
	return (
		isRecord(value) &&
		typeof value.for === "function" &&
		typeof value.search === "function" &&
		typeof value.add === "function" &&
		typeof value.delete === "function"
	);
}

function isBoundClient(value: unknown): boolean {
	return (
		isRecord(value) &&
		isRecord(value.scope) &&
		typeof value.search === "function" &&
		!("for" in value)
	);
}

/**
 * Import the app's memory file and return its client: the `memory` export,
 * else the default export's `memory`, else the default export, as the
 * `mnemocyte` CLI reads it. A `.ts` file loads through Node's type stripping
 * with the shared resolve hook (`@mnemocyte/loader`) for extensionless,
 * `.js`-for-`.ts` and tsconfig `paths` imports.
 *
 * @throws {UsageError} When the file does not load, or exports a bound
 * client or no client.
 */
export async function loadMemoryClient(
	file: string,
	cwd: string,
): Promise<UnboundMemoryClient> {
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
		isRecord(fallback) && "memory" in fallback ? fallback.memory : undefined,
		fallback,
	].filter((candidate) => candidate !== undefined);
	const client = candidates.find(isUnboundClient);
	if (client !== undefined) {
		return client;
	}
	if (candidates.some(isBoundClient)) {
		throw new UsageError(
			`${name} exports a bound client from memory.for(...). Export the client from createMemory() itself; mnemocyte-mcp binds it to the scope in its flags.`,
		);
	}
	throw new UsageError(
		`${name} does not export a memory client. Export the result of createMemory() as "memory": export const memory = createMemory({ ... });`,
	);
}
