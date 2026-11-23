import { statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { BoundMemoryClient } from "mnemocyte";
import { isMnemocyteError } from "mnemocyte";
import { createMemoryMcpServer, toolNames } from "../server.js";
import { parseCliArgs, type ServeScope, USAGE, UsageError } from "./args.js";
import { loadMemoryClient, locateMemoryFile } from "./memory-file.js";

/** Where the bin reads and writes. Tests pass a recording one. */
export interface CliIo {
	readonly cwd: string;
	/** Standard output: help and version only. */
	write(text: string): void;
	/** Standard error: errors and the startup line. */
	error(text: string): void;
}

/** What the bin does after {@link prepare}. */
export type Prepared =
	| { readonly kind: "exit"; readonly code: number }
	| {
			readonly kind: "serve";
			/** A new server for each connection. */
			readonly createServer: () => McpServer;
	  };

/** Exit code for bad flags or a memory file that cannot be used. */
export const EXIT_USAGE = 2;

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * `--env-file` when given, else `.env` in the app's folder when it exists,
 * as the `mnemocyte` CLI does. A variable that is already set is kept.
 */
export function loadEnvironment(
	cwd: string,
	envFile: string | undefined,
): void {
	if (envFile === undefined) {
		const path = join(cwd, ".env");
		if (isFile(path)) {
			process.loadEnvFile(path);
		}
		return;
	}
	try {
		process.loadEnvFile(resolve(cwd, envFile));
	} catch (error) {
		throw new UsageError(`--env-file: could not read ${envFile}.`, {
			cause: error,
		});
	}
}

/**
 * The app's folder: `--project` resolved against the working directory, or
 * the working directory itself. MCP clients do not all say which folder
 * they start a server in.
 *
 * @throws {UsageError} When `--project` is not a folder.
 */
export function projectFolder(
	cwd: string,
	project: string | undefined,
): string {
	if (project === undefined) {
		return cwd;
	}
	const folder = resolve(cwd, project);
	if (statSync(folder, { throwIfNoEntry: false })?.isDirectory() !== true) {
		throw new UsageError(`--project: ${project} is not a folder.`);
	}
	return folder;
}

function describeError(error: unknown): string {
	return `mnemocyte-mcp: ${error instanceof Error ? error.message : String(error)}\n`;
}

function describeScope(scope: Readonly<Record<string, unknown>>): string {
	return Object.entries(scope)
		.filter(([, value]) => value !== undefined)
		.map(([field, value]) => `${field}=${String(value)}`)
		.join(" ");
}

/**
 * Parse the arguments, load the memory file and bind its client to the
 * scope in the flags. Resolves with what to do next; never rejects. Errors
 * are written to `io.error`: bad flags and an unusable memory file exit 2,
 * anything else 1.
 */
export async function prepare(
	argv: readonly string[],
	io: CliIo,
	version: string,
): Promise<Prepared> {
	let args: ReturnType<typeof parseCliArgs>;
	try {
		args = parseCliArgs(argv);
	} catch (error) {
		io.error(`${describeError(error)}\n${USAGE}`);
		return { kind: "exit", code: EXIT_USAGE };
	}
	if (args.command === "help") {
		io.write(USAGE);
		return { kind: "exit", code: 0 };
	}
	if (args.command === "version") {
		io.write(`${version}\n`);
		return { kind: "exit", code: 0 };
	}

	try {
		const project = projectFolder(io.cwd, args.project);
		loadEnvironment(project, args.envFile);
		const file = locateMemoryFile(project, args.config);
		const client = await loadMemoryClient(file, project);
		const memory = bind(client, args.scope);
		const { allowForget, readOnly } = args;
		// Built once here so a bad option fails at startup, not on connect.
		createMemoryMcpServer({ memory, allowForget, readOnly });
		const label = relative(project, file).replaceAll("\\", "/") || file;
		io.error(
			`mnemocyte-mcp ${version}: ${label}, scope ${describeScope(memory.scope)}, tools ${toolNames({ allowForget, readOnly }).join(", ")}\n`,
		);
		return {
			kind: "serve",
			createServer: () =>
				createMemoryMcpServer({ memory, allowForget, readOnly }),
		};
	} catch (error) {
		io.error(describeError(error));
		return {
			kind: "exit",
			code:
				error instanceof UsageError ||
				(isMnemocyteError(error) &&
					(error.code === "VALIDATION" || error.code === "CONFIG"))
					? EXIT_USAGE
					: 1,
		};
	}
}

function bind(
	client: { for(scope: ServeScope): BoundMemoryClient },
	scope: ServeScope,
): BoundMemoryClient {
	try {
		return client.for(scope);
	} catch (error) {
		if (isMnemocyteError(error) && error.code === "VALIDATION") {
			const hint =
				scope.namespace === undefined
					? " Pass --namespace, or set namespace in the memory file's createMemory()."
					: "";
			throw new UsageError(
				`The scope in the flags is not valid: ${error.message}${hint}`,
				{ cause: error },
			);
		}
		throw error;
	}
}
