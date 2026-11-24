import { relative, resolve } from "node:path";
import { loadEnvFiles, MEMORY_FILE_NAMES } from "@mnemocyte/loader";
import type { MemoryStore } from "../memory/store.js";
import { createMnemocyteStoreConfig } from "../memory/store-config.js";
import { resolveStore } from "../memory/store-input.js";
import type { PostgresJsClient } from "../sql/detect.js";
import type {
	BoundMemoryClient,
	Embedder,
	MemoryClient,
	MnemocyteStoreConfig,
} from "../types.js";
import type { CliArgs } from "./args.js";
import {
	type DirectTarget,
	importPostgres,
	openDirectTarget,
} from "./direct.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import type { JsonConnection } from "./json.js";
import { loadMemoryFile, locateMemoryFile } from "./memory-file.js";

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
	/** `store` as `migrate()` and `setTextSearchConfig()` take it. */
	readonly storeConfig: MnemocyteStoreConfig;
}

export type { DirectTarget } from "./direct.js";

/**
 * The memory file's client, a connection on `DATABASE_URL` without one, or
 * the CLI's own connection for a memory file whose store cannot migrate.
 */
export type CliTarget = MemoryTarget | DatabaseUrlTarget | DirectTarget;

/** Options for {@link resolveTarget}. */
export interface ResolveTargetOptions {
	/**
	 * Open the CLI's own connection when the memory file's store has no
	 * interactive transactions (`migrate`, `text-search`). `check` reads
	 * through the app's client instead.
	 */
	readonly direct?: boolean;
}

/**
 * Load the project's environment files into `process.env`, before the memory
 * file reads them: `--env-file` when given, which must exist, otherwise
 * `./.env.local` and then `./.env`, each when it exists (`.env.local` not
 * when `NODE_ENV` is `test`; see `loadEnvFiles`). `process.loadEnvFile`
 * keeps a variable that is already set, so the real environment (CI, a
 * deploy) wins over the files, and `.env.local` over `.env`.
 *
 * @throws {CliError} With exit code 2 when `--env-file` cannot be read.
 */
export function loadEnvironment(
	cwd: string,
	envFile: string | undefined,
): void {
	if (envFile === undefined) {
		loadEnvFiles({ directory: cwd });
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
 * What a command runs against: the client the app's memory file exports,
 * or, without a memory file, a connection to `DATABASE_URL`. With
 * `direct`, a memory file whose store has no interactive transactions gets
 * a connection of the CLI's own ({@link openDirectTarget}).
 *
 * @throws {CliError} With exit code 2 when there is neither, or when a
 * direct connection has no URL or driver.
 */
export async function resolveTarget(
	args: CliArgs,
	io: CliIo,
	options: ResolveTargetOptions = {},
): Promise<CliTarget> {
	loadEnvironment(io.cwd, args.envFile);
	const file = locateMemoryFile(io.cwd, args.config);
	if (file !== null) {
		const loaded = await loadMemoryFile(file, io.cwd);
		const label = relative(io.cwd, file).replaceAll("\\", "/") || file;
		assertSchemaFlag(args.schema, loaded.store, label);
		const connection = loaded.store.directConnection;
		if (options.direct === true && connection !== undefined) {
			return openDirectTarget({
				label,
				appStore: loaded.store,
				embedder: loaded.embedder,
				connection,
				io,
			});
		}
		return {
			kind: "memory",
			label,
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
	const postgres = await importPostgres(
		io.cwd,
		", or pass --config <path> to use your app's own client.",
	);
	// One connection is enough, and notices would print over the output.
	const client = postgres(url, { max: 1, onnotice() {} });
	const store = resolveStore(
		client,
		args.schema === undefined ? {} : { schemaName: args.schema },
	);
	return {
		kind: "database-url",
		label: "DATABASE_URL",
		client,
		store,
		storeConfig: createMnemocyteStoreConfig(store),
		close: () => client.end({ timeout: 5 }),
	};
}

/** {@link JsonConnection} for a target. */
export function targetConnection(target: CliTarget): JsonConnection {
	switch (target.kind) {
		case "memory":
			return null;
		case "database-url":
			return "DATABASE_URL";
		case "direct":
			return target.variable;
	}
}

/**
 * `--schema` with a memory file: the file's `postgresStore()` already says
 * where the tables are, so the flag may only repeat it. A libSQL store has
 * no schema to name.
 *
 * @throws {CliError} With exit code 2 when the two differ.
 */
export function assertSchemaFlag(
	flag: string | undefined,
	store: MemoryStore,
	label: string,
): void {
	if (flag !== undefined && store.backend === "libsql") {
		throw new CliError(
			`--schema applies to Postgres, but the store in ${label} is libSQL, which keeps one schema per database. Drop --schema.`,
			EXIT_USAGE,
		);
	}
	if (flag !== undefined && store.custom !== undefined) {
		throw new CliError(
			`--schema applies to Postgres, but the store in ${label} is the custom store "${store.custom.name}". Drop --schema.`,
			EXIT_USAGE,
		);
	}
	if (flag === undefined || flag === store.schemaName) {
		return;
	}
	throw new CliError(
		store.schemaName === undefined
			? `--schema is ${flag}, but the store in ${label} names no schema. Set schemaName: "${flag}" in its postgresStore(), or run without the memory file (DATABASE_URL).`
			: `--schema is ${flag}, but the store in ${label} uses the "${store.schemaName}" schema. Drop --schema; the memory file decides.`,
		EXIT_USAGE,
	);
}
