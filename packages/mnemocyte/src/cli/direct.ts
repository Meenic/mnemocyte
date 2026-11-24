import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { InstallationReport } from "../db/migrations/inspect.js";
import type { MemoryStore } from "../memory/store.js";
import { createMnemocyteStoreConfig } from "../memory/store-config.js";
import { resolveStore } from "../memory/store-input.js";
import type { DirectConnection, PostgresJsClient } from "../sql/detect.js";
import type { Embedder, MnemocyteStoreConfig } from "../types.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";

/*
 * A memory file whose store has no interactive transactions (Neon's HTTP
 * driver, a `batch`-only `SqlExecutor`): `migrate` and `text-search` open a
 * connection of their own and take the dimensions and the schema name from
 * the memory file (ARCHITECTURE decision 77).
 */

/** The variables a direct connection reads its URL from. */
export type DirectUrlVariable = "DATABASE_URL_UNPOOLED" | "DATABASE_URL";

/** `migrate` and `text-search` over the CLI's own connection. */
export interface DirectTarget {
	readonly kind: "direct";
	/** The memory file, relative to the working directory. */
	readonly label: string;
	/** The store over the CLI's connection, with the memory file's schema. */
	readonly store: MemoryStore;
	/** {@link store} as `migrate()` and `setTextSearchConfig()` take it. */
	readonly storeConfig: MnemocyteStoreConfig;
	/** The memory file's own store, read to compare installations. */
	readonly appStore: MemoryStore;
	readonly embedder: Embedder;
	readonly connection: DirectConnection;
	/** The variable whose URL the CLI connected to; the URL is never printed. */
	readonly variable: DirectUrlVariable;
	/** Ends the connection the CLI opened. */
	close(): Promise<void>;
}

/**
 * The variable to connect with, from `env`: for a Neon store
 * `DATABASE_URL_UNPOOLED` (the direct connection string Neon's Vercel
 * integration sets), falling back to `DATABASE_URL`; for any other store
 * `DATABASE_URL`, as without a memory file. `null` when none is set.
 */
export function chooseDirectUrl(
	connection: DirectConnection,
	env: Readonly<Record<string, string | undefined>>,
): { readonly variable: DirectUrlVariable; readonly url: string } | null {
	const variables: readonly DirectUrlVariable[] =
		connection === "neon"
			? ["DATABASE_URL_UNPOOLED", "DATABASE_URL"]
			: ["DATABASE_URL"];
	for (const variable of variables) {
		const url = env[variable];
		if (url !== undefined && url !== "") {
			return { variable, url };
		}
	}
	return null;
}

/** Why the store cannot migrate, for messages. */
function storeReason(connection: DirectConnection, label: string): string {
	return connection === "neon"
		? `The store in ${label} uses Neon's HTTP driver, which cannot run migrations: they need a transaction on one connection.`
		: `The store in ${label} has no interactive transactions (SqlExecutor.transaction), which migrations need.`;
}

/** The `Using …` line's follow-up: what the CLI connected with. */
export function describeDirectConnection(target: DirectTarget): string {
	const driver =
		target.connection === "neon" ? "Neon's Pool" : 'the "postgres" package';
	const fallback =
		target.connection === "neon" && target.variable === "DATABASE_URL"
			? " (DATABASE_URL_UNPOOLED is not set)"
			: "";
	return `Connecting with ${driver} on ${target.variable}${fallback}: ${storeReason(target.connection, target.label)}\n`;
}

/** The part of a node-postgres-compatible `Pool` the CLI calls. */
interface PoolLike {
	end(): Promise<void>;
	on(event: "error", listener: (error: Error) => void): unknown;
}

type PoolConstructor = new (config: {
	connectionString: string;
	max: number;
}) => PoolLike;

/** The part of postgres.js the CLI calls. */
export type PostgresFactory = (
	url: string,
	options: { max: number; onnotice: () => void },
) => PostgresJsClient & { end(options?: { timeout?: number }): Promise<void> };

const NEON_PACKAGE = "@neondatabase/serverless";

function poolFrom(module: unknown): PoolConstructor | undefined {
	const record = module as {
		Pool?: unknown;
		default?: { Pool?: unknown };
	} | null;
	const pool = record?.Pool ?? record?.default?.Pool;
	return typeof pool === "function" ? (pool as PoolConstructor) : undefined;
}

/**
 * Neon's `Pool`, from `@neondatabase/serverless`. It is imported by name
 * first, which resolves to the copy the memory file imports in most layouts,
 * so the `neonConfig` the file sets (such as `wsProxy` for local
 * development) applies to this pool too. When that fails it is resolved
 * from the project, as `postgres` is. The name is a variable, so the build
 * has no driver import and the package keeps zero dependencies.
 */
async function importNeonPool(cwd: string): Promise<PoolConstructor> {
	try {
		const pool = poolFrom(await import(NEON_PACKAGE));
		if (pool !== undefined) {
			return pool;
		}
	} catch {
		// Not reachable from here; try the project.
	}
	try {
		const path = createRequire(join(cwd, "package.json")).resolve(NEON_PACKAGE);
		const pool = poolFrom(await import(pathToFileURL(path).href));
		if (pool !== undefined) {
			return pool;
		}
	} catch {
		// Reported below.
	}
	throw new CliError(
		`Connecting with Neon's Pool needs the "${NEON_PACKAGE}" package, which is not installed here. Install it (npm install ${NEON_PACKAGE}).`,
		EXIT_USAGE,
	);
}

/**
 * The app's `postgres` package: looked up from the project first, then from
 * where Mnemocyte is installed (under pnpm an optional peer is linked next
 * to the package, not above it). It is resolved at run time and imported by
 * path, so the build has no `postgres` import and the package keeps zero
 * dependencies.
 *
 * @throws {CliError} With exit code 2 when it is not installed; `hint` says
 * what else to do.
 */
export async function importPostgres(
	cwd: string,
	hint: string,
): Promise<PostgresFactory> {
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
		`Connecting to DATABASE_URL needs the "postgres" package, which is not installed here. Install it (npm install postgres)${hint}`,
		EXIT_USAGE,
	);
}

/** Input for {@link openDirectTarget}. */
export interface OpenDirectTargetInput {
	readonly label: string;
	readonly appStore: MemoryStore;
	readonly embedder: Embedder;
	readonly connection: DirectConnection;
	readonly io: CliIo;
}

/**
 * Connect on the variable {@link chooseDirectUrl} picks, with one
 * connection, and build a store on it with the memory file's schema.
 *
 * @throws {CliError} With exit code 2 when no variable is set or the
 * driver is not installed.
 */
export async function openDirectTarget(
	input: OpenDirectTargetInput,
): Promise<DirectTarget> {
	const { connection, label } = input;
	const chosen = chooseDirectUrl(connection, process.env);
	if (chosen === null) {
		throw new CliError(
			connection === "neon"
				? `${storeReason(connection, label)} Set DATABASE_URL_UNPOOLED (or DATABASE_URL) to the same database's direct connection string, then run the command again.`
				: `${storeReason(connection, label)} Set DATABASE_URL to the same database's connection string, then run the command again.`,
			EXIT_USAGE,
		);
	}
	const settings =
		input.appStore.schemaName === undefined
			? {}
			: { schemaName: input.appStore.schemaName };
	let client: unknown;
	let close: () => Promise<void>;
	if (connection === "neon") {
		const Pool = await importNeonPool(input.io.cwd);
		const pool = new Pool({ connectionString: chosen.url, max: 1 });
		// An idle connection's error would otherwise be an unhandled `error`
		// event; a query in flight still rejects with it.
		pool.on("error", () => {});
		client = pool;
		close = () => pool.end();
	} else {
		const postgres = await importPostgres(input.io.cwd, ".");
		// One connection is enough, and notices would print over the output.
		const sql = postgres(chosen.url, { max: 1, onnotice() {} });
		client = sql;
		close = () => sql.end({ timeout: 5 });
	}
	const store = resolveStore(client, settings);
	return {
		kind: "direct",
		label,
		store,
		storeConfig: createMnemocyteStoreConfig(store),
		appStore: input.appStore,
		embedder: input.embedder,
		connection,
		variable: chosen.variable,
		close,
	};
}

/**
 * The facts of a report two connections to one database must agree on, as
 * one line for messages. Stored models are left out: the app may record
 * one between the two reads.
 */
export function summarizeInstallation(
	report: InstallationReport | null,
): string {
	if (report === null) {
		return "no installation";
	}
	const parts: string[] = [];
	const { migrations } = report;
	switch (migrations.state) {
		case "none":
			parts.push("no Mnemocyte tables");
			break;
		case "invalid":
			parts.push(`a schema migrate refuses (${migrations.reason})`);
			break;
		default: {
			const last = migrations.applied.at(-1);
			parts.push(
				last === undefined
					? `${migrations.state}, no migrations applied`
					: `migrations up to ${last} (${migrations.state})`,
			);
			if (migrations.pending.length > 0) {
				parts.push(`${migrations.pending.length} pending`);
			}
		}
	}
	parts.push(
		report.pgvectorVersion === null
			? "no pgvector"
			: `pgvector ${report.pgvectorVersion}`,
	);
	if (report.column !== null) {
		parts.push(`${report.column.vectorType}(${report.column.dimensions})`);
	}
	if (report.meta === null) {
		parts.push("no installation row");
	} else if (report.meta !== undefined) {
		parts.push(`model ${report.meta.model ?? "not recorded"}`);
	}
	if (report.textSearchConfig !== undefined) {
		parts.push(`text search ${report.textSearchConfig}`);
	}
	return parts.join(", ");
}

/** Both reports, summarized: through the CLI's connection and the app's. */
async function readBoth(
	target: DirectTarget,
): Promise<{ readonly direct: string; readonly app: string }> {
	let direct: InstallationReport | null;
	try {
		direct = await target.store.inspectInstallation();
	} catch (error) {
		throw new Error(`Connecting over ${target.variable} failed.`, {
			cause: error,
		});
	}
	const app = await target.appStore.inspectInstallation();
	return {
		direct: summarizeInstallation(direct),
		app: summarizeInstallation(app),
	};
}

/**
 * Before anything changes: the CLI's connection and the memory file's
 * client must see the same installation, or the URL points at another
 * database. Two identical installations (a new branch and its parent) pass;
 * {@link confirmSameInstallation} catches those after the change.
 *
 * @throws {CliError} With exit code 2 when the two differ.
 */
export async function assertSameInstallation(
	target: DirectTarget,
): Promise<void> {
	const seen = await readBoth(target);
	if (seen.direct !== seen.app) {
		throw new CliError(
			`${target.variable} and the client in ${target.label} see different installations, so they point at different databases. Nothing changed. Through ${target.variable}: ${seen.direct}. Through ${target.label}: ${seen.app}. Point ${target.variable} at the database the app uses.`,
			EXIT_USAGE,
		);
	}
}

/**
 * After a change: the memory file's client must see it too. Writes the
 * problem to standard error and returns false when it does not.
 */
export async function confirmSameInstallation(
	target: DirectTarget,
	io: CliIo,
	changed: string,
): Promise<boolean> {
	const seen = await readBoth(target);
	if (seen.direct === seen.app) {
		return true;
	}
	io.error(
		`${changed} the database at ${target.variable}, but the client in ${target.label} does not see it, so they are different databases. Through ${target.variable}: ${seen.direct}. Through ${target.label}: ${seen.app}. Point ${target.variable} at the database the app uses and run the command again.\n`,
	);
	return false;
}
