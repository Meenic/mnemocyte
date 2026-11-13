import { MnemocyteError } from "../errors.js";
import type { SqlExecutor } from "./executor.js";
import type { NodePostgresPool } from "./node-postgres.js";
import type { PGliteClient } from "./pglite.js";

/**
 * The part of a postgres.js `sql` function Mnemocyte checks for, on 3.4.9+
 * and 4.x. Any client created with `postgres(...)` matches, and so does the
 * `sql` a `sql.begin` callback receives, which has `savepoint` instead of
 * (3.x) or next to (4.x) `begin`. A reserved connection (`sql.reserve()`)
 * has neither and does not match.
 */
export type PostgresJsClient =
	// Only the presence of these methods is checked; postgres.js's own
	// overloads take a callback of its `TransactionSql`, which a narrower
	// signature here could not accept.
	| {
			unsafe(...args: never[]): unknown;
			begin(...args: never[]): unknown;
	  }
	| {
			unsafe(...args: never[]): unknown;
			savepoint(...args: never[]): unknown;
	  };

/**
 * A Drizzle instance built on postgres.js (`drizzle-orm/postgres-js`),
 * node-postgres (`drizzle-orm/node-postgres`, with a `Pool`) or PGlite
 * (`drizzle-orm/pglite`). Mnemocyte runs its SQL on `db.$client`.
 */
export interface DrizzleClient {
	readonly $client: PostgresJsClient | NodePostgresPool | PGliteClient;
}

/**
 * Any database client Mnemocyte accepts: a driver's own client, a Drizzle
 * instance over one, or a hand-written {@link SqlExecutor}.
 */
export type PostgresClient =
	| PostgresJsClient
	| NodePostgresPool
	| PGliteClient
	| DrizzleClient
	| SqlExecutor;

/**
 * A recognised client, unwrapped from Drizzle. Turning it into a
 * {@link SqlExecutor} is left to `toSqlExecutor` in `sql/clients.ts`, so
 * this module stays free of the adapters and can sit in the root entry.
 */
export type DetectedClient =
	| { readonly driver: "postgres-js"; readonly client: PostgresJsClient }
	| { readonly driver: "pglite"; readonly client: PGliteClient }
	| { readonly driver: "node-postgres"; readonly client: NodePostgresPool }
	| { readonly driver: "executor"; readonly client: SqlExecutor };

/** What the caller called the value, for error messages. */
export type ClientSubject = "client" | "store";

/** The clients every "unrecognised" message lists. */
export const SUPPORTED_CLIENTS =
	"a postgres.js sql function, a node-postgres Pool, a PGlite instance, a Drizzle instance over one of them, or a SqlExecutor (query plus transaction or batch)";

function hasFunctions(value: object, names: readonly string[]): boolean {
	const record = value as Record<string, unknown>;
	return names.every((name) => typeof record[name] === "function");
}

function isPostgresJs(value: unknown): value is PostgresJsClient {
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

function isSqlExecutor(value: unknown): value is SqlExecutor {
	return (
		typeof value === "object" &&
		value !== null &&
		hasFunctions(value, ["query"]) &&
		(hasFunctions(value, ["transaction"]) || hasFunctions(value, ["batch"]))
	);
}

/** postgres.js, PGlite or a pg Pool; `undefined` for anything else. */
function detectDriver(client: unknown): DetectedClient | undefined {
	if (isPostgresJs(client)) {
		return { driver: "postgres-js", client };
	}
	// PGlite before the SqlExecutor check: it also has `query` and
	// `transaction`, but its `query` returns `{ rows }`.
	if (isPGlite(client)) {
		return { driver: "pglite", client };
	}
	if (isNodePostgresPool(client)) {
		return { driver: "node-postgres", client };
	}
	return undefined;
}

function nodePostgresClientError(subject: ClientSubject): MnemocyteError {
	return new MnemocyteError(
		`${subject} looks like a node-postgres Client. Pass a Pool instead: transactions check out their own connection with pool.connect().`,
		"CONFIG",
	);
}

/**
 * Recognise a database client by its shape. Reads properties only and
 * imports no driver. Checks run in this order (ARCHITECTURE decision 21):
 *
 * 1. postgres.js: a function with `unsafe` and `begin` (or `savepoint`).
 * 2. Drizzle: an object with `$client`, which must be one of the drivers
 *    below or above.
 * 3. PGlite: `query`, `exec` and `transaction`.
 * 4. node-postgres `Pool`: `query`, `connect` and a numeric `totalCount`.
 * 5. A hand-written `SqlExecutor` object: `query` and `transaction` or
 *    `batch`.
 *
 * @returns `undefined` when `client` matches none of them, so each caller
 * can name what it accepts.
 * @throws {MnemocyteError} `"CONFIG"` for a node-postgres `Client` and for a
 * Drizzle instance over an unsupported driver.
 */
export function detectClient(
	client: unknown,
	subject: ClientSubject,
): DetectedClient | undefined {
	const driver = detectDriver(client);
	if (driver) {
		return driver;
	}
	if (typeof client === "object" && client !== null && "$client" in client) {
		const inner = (client as { $client: unknown }).$client;
		const detected = detectDriver(inner);
		if (detected) {
			return detected;
		}
		if (isNodePostgresClient(inner)) {
			throw nodePostgresClientError(subject);
		}
		throw new MnemocyteError(
			`${subject} is a Drizzle instance over an unsupported driver. Supported: drizzle-orm/postgres-js, drizzle-orm/node-postgres with a Pool, and drizzle-orm/pglite; for others, implement SqlExecutor.`,
			"CONFIG",
		);
	}
	if (isSqlExecutor(client)) {
		return { driver: "executor", client };
	}
	if (isNodePostgresClient(client)) {
		throw nodePostgresClientError(subject);
	}
	return undefined;
}
