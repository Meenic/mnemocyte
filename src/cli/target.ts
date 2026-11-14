import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { MemoryStore } from "../memory/store.js";
import { resolveStore } from "../memory/store-input.js";
import type { PostgresJsClient } from "../sql/detect.js";
import type { BoundMemoryClient, Embedder, MemoryClient } from "../types.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import {
	loadMemoryFile,
	locateMemoryFile,
	MEMORY_FILE_NAMES,
} from "./memory-file.js";

interface TargetBase {
	/** What the command names in its first line of output. */
	readonly label: string;
	readonly store: MemoryStore;
	/** Ends a connection the CLI opened; does nothing for the app's client. */
	close(): Promise<void>;
}

/** The app's own client, from its memory file. */
export interface MemoryTarget extends TargetBase {
	readonly kind: "memory";
	readonly memory: MemoryClient<boolean> | BoundMemoryClient;
	readonly embedder: Embedder;
}

/** A postgres.js client the CLI opened on `DATABASE_URL`. */
export interface DatabaseUrlTarget extends TargetBase {
	readonly kind: "database-url";
	readonly client: PostgresJsClient;
}

export type CliTarget = MemoryTarget | DatabaseUrlTarget;

/** The part of postgres.js the CLI calls. */
type PostgresFactory = (
	url: string,
	options: { max: number; onnotice: () => void },
) => PostgresJsClient & { end(options?: { timeout?: number }): Promise<void> };

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * Load the project's environment file into `process.env`, before the memory
 * file reads it: `--env-file` when given, which must exist, otherwise
 * `./.env` when there is one. `process.loadEnvFile` keeps a variable that is
 * already set, so the real environment (CI, a deploy) wins over the file.
 *
 * @throws {CliError} With exit code 2 when `--env-file` cannot be read.
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
		throw new CliError(
			`--env-file: could not read ${envFile}.`,
			EXIT_USAGE,
			error,
		);
	}
}

/**
 * The app's `postgres` package: looked up from the project first, then from
 * where Mnemocyte is installed (under pnpm an optional peer is linked next
 * to the package, not above it). It is resolved at run time and imported by
 * path, so the build has no `postgres` import and the package keeps zero
 * dependencies.
 */
async function importPostgres(cwd: string): Promise<PostgresFactory> {
	for (const from of [join(cwd, "package.json"), import.meta.url]) {
		let path: string;
		try {
			path = createRequire(from).resolve("postgres");
		} catch {
			continue;
		}
		const module = (await import(pathToFileURL(path).href)) as {
			default?: unknown;
		};
		if (typeof module.default === "function") {
			// postgres.js exports its factory as the default export.
			return module.default as PostgresFactory;
		}
	}
	throw new CliError(
		'Connecting to DATABASE_URL needs the "postgres" package, which is not installed here. Install it (npm install postgres), or pass --config <path> to use your app\'s own client.',
		EXIT_USAGE,
	);
}

/**
 * What `migrate` and `check` run against: the client the app's memory file
 * exports, or, without a memory file, a connection to `DATABASE_URL`.
 *
 * @throws {CliError} With exit code 2 when there is neither.
 */
export async function resolveTarget(
	args: CliArgs,
	io: CliIo,
): Promise<CliTarget> {
	loadEnvironment(io.cwd, args.envFile);
	const file = locateMemoryFile(io.cwd, args.config);
	if (file !== null) {
		const loaded = await loadMemoryFile(file, io.cwd);
		return {
			kind: "memory",
			label: relative(io.cwd, file).replaceAll("\\", "/") || file,
			memory: loaded.memory,
			store: loaded.store,
			embedder: loaded.embedder,
			async close() {},
		};
	}

	const url = process.env.DATABASE_URL;
	if (url === undefined || url === "") {
		throw new CliError(
			`No memory file found (${MEMORY_FILE_NAMES.join(", ")} in ., lib, src or src/lib) and DATABASE_URL is not set. Pass --config <path>, or set DATABASE_URL to connect with the "postgres" package.`,
			EXIT_USAGE,
		);
	}
	const postgres = await importPostgres(io.cwd);
	// One connection is enough, and notices would print over the output.
	const client = postgres(url, { max: 1, onnotice() {} });
	return {
		kind: "database-url",
		label: "DATABASE_URL",
		client,
		store: resolveStore(client),
		close: () => client.end({ timeout: 5 }),
	};
}
