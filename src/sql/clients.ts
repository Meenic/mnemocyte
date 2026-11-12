import type { Sql } from "postgres";
import { assertSqlExecutor } from "../db/atomic.js";
import { MnemocyteError } from "../errors.js";
import type { SqlExecutor } from "./executor.js";
import {
	type NodePostgresPool,
	nodePostgresExecutor,
} from "./node-postgres.js";
import { type PGliteClient, pgliteExecutor } from "./pglite.js";
import { postgresJs } from "./postgres-js.js";

/**
 * The part of a postgres.js `sql` function Mnemocyte checks for. Any client
 * created with `postgres(...)` matches.
 */
export interface PostgresJsClient {
	// Only the presence of these methods is checked; postgres.js's own
	// overloads take a callback of its `TransactionSql`, which a narrower
	// signature here could not accept.
	unsafe(...args: never[]): unknown;
	begin(...args: never[]): unknown;
}

/**
 * A Drizzle instance built on postgres.js (`drizzle-orm/postgres-js`),
 * node-postgres (`drizzle-orm/node-postgres`, with a `Pool`) or PGlite
 * (`drizzle-orm/pglite`). Mnemocyte runs its SQL on `db.$client`.
 */
export interface DrizzleClient {
	readonly $client: PostgresJsClient | NodePostgresPool | PGliteClient;
}

/**
 * Any client {@link postgresStore} accepts: a driver's own client, a Drizzle
 * instance over one, or a hand-written {@link SqlExecutor}.
 */
export type PostgresClient =
	| PostgresJsClient
	| NodePostgresPool
	| PGliteClient
	| DrizzleClient
	| SqlExecutor;

const SUPPORTED =
	"a postgres.js sql function, a node-postgres Pool, a PGlite instance, a Drizzle instance over one of them, or a SqlExecutor (query plus transaction or batch)";

function hasFunctions(value: object, names: readonly string[]): boolean {
	const record = value as Record<string, unknown>;
	return names.every((name) => typeof record[name] === "function");
}

function isPostgresJs(value: unknown): boolean {
	// A transaction's `sql` has `savepoint` instead of (3.x) or next to (4.x)
	// `begin`.
	return (
		typeof value === "function" &&
		hasFunctions(value, ["unsafe"]) &&
		(hasFunctions(value, ["begin"]) || hasFunctions(value, ["savepoint"]))
	);
}

function isPGlite(value: unknown): value is PGliteClient {
	return (
		typeof value === "object" &&
		value !== null &&
		hasFunctions(value, ["query", "exec", "transaction"])
	);
}

function isNodePostgresPool(value: unknown): value is NodePostgresPool {
	return (
		typeof value === "object" &&
		value !== null &&
		hasFunctions(value, ["query", "connect"]) &&
		typeof (value as { totalCount?: unknown }).totalCount === "number"
	);
}

/** A node-postgres `Client`: `query` and `connect`, no pool counters. */
function isNodePostgresClient(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		hasFunctions(value, ["query", "connect"]) &&
		!("totalCount" in value)
	);
}

/** postgres.js, PGlite or a pg Pool; `undefined` for anything else. */
function driverExecutor(client: unknown): SqlExecutor | undefined {
	if (isPostgresJs(client)) {
		// Matched by shape above; postgresJs only calls unsafe, begin and
		// savepoint.
		return postgresJs(client as Sql);
	}
	// PGlite before the SqlExecutor check: it also has `query` and
	// `transaction`, but its `query` returns `{ rows }`.
	if (isPGlite(client)) {
		return pgliteExecutor(client);
	}
	if (isNodePostgresPool(client)) {
		return nodePostgresExecutor(client);
	}
	return undefined;
}

function nodePostgresClientError(): MnemocyteError {
	return new MnemocyteError(
		"client looks like a node-postgres Client. Pass a Pool instead: transactions check out their own connection with pool.connect().",
		"CONFIG",
	);
}

/**
 * Turn any supported client into a {@link SqlExecutor}. Detection reads
 * properties only and imports no driver. Checks run in this order:
 *
 * 1. postgres.js: a function with `unsafe` and `begin` (or `savepoint`).
 * 2. Drizzle: an object with `$client`, which must be one of the drivers
 *    below or above.
 * 3. PGlite: `query`, `exec` and `transaction`.
 * 4. node-postgres `Pool`: `query`, `connect` and a numeric `totalCount`.
 * 5. A hand-written `SqlExecutor` object: `query` and `transaction` or
 *    `batch`.
 *
 * @throws {MnemocyteError} `"CONFIG"` for anything else, including a
 * node-postgres `Client`.
 */
export function toSqlExecutor(client: unknown): SqlExecutor {
	const driver = driverExecutor(client);
	if (driver) {
		return driver;
	}
	if (typeof client === "object" && client !== null && "$client" in client) {
		const inner = (client as { $client: unknown }).$client;
		const executor = driverExecutor(inner);
		if (executor) {
			return executor;
		}
		if (isNodePostgresClient(inner)) {
			throw nodePostgresClientError();
		}
		throw new MnemocyteError(
			"client is a Drizzle instance over an unsupported driver. Supported: drizzle-orm/postgres-js, drizzle-orm/node-postgres with a Pool, and drizzle-orm/pglite; for others, implement SqlExecutor.",
			"CONFIG",
		);
	}
	if (
		typeof client === "object" &&
		client !== null &&
		hasFunctions(client, ["query"]) &&
		(hasFunctions(client, ["transaction"]) || hasFunctions(client, ["batch"]))
	) {
		assertSqlExecutor(client);
		return client;
	}
	if (isNodePostgresClient(client)) {
		throw nodePostgresClientError();
	}
	throw new MnemocyteError(`client must be ${SUPPORTED}.`, "CONFIG");
}
