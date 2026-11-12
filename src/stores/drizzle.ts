import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { MnemocyteError } from "../errors.js";
import { createPostgresStore } from "../memory/postgres.js";
import { createMnemocyteStoreConfig } from "../memory/store-config.js";
import { type DrizzleClient, toSqlExecutor } from "../sql/clients.js";
import type { MnemocyteStoreConfig } from "../types.js";

export type { DrizzleClient } from "../sql/clients.js";

/**
 * Wrap a caller-owned Drizzle instance for {@link MemoryConfig.store}. The
 * same as `postgresStore({ client: db })` from `mnemocyte/postgres`.
 *
 * Mnemocyte runs its own SQL on the client behind `db` (`db.$client`), so it
 * shares that client's pool and settings. Supported: `drizzle-orm/postgres-js`,
 * `drizzle-orm/node-postgres` with a `Pool`, and `drizzle-orm/pglite`. The
 * Mnemocyte tables must already exist through `migrate()` or the bundled
 * migrations. Mnemocyte never closes the Drizzle instance or its client.
 *
 * @param db - A Drizzle instance over postgres.js, a node-postgres `Pool` or
 * PGlite.
 * @throws {MnemocyteError} With code `"CONFIG"` if `db` has no `$client` of a
 * supported driver.
 */
export function drizzleStore<TSchema extends Record<string, unknown>>(
	// `PostgresJsDatabase` does not declare `$client`; it stays accepted so
	// code that annotates its instance with it keeps compiling.
	db: DrizzleClient | PostgresJsDatabase<TSchema>,
): MnemocyteStoreConfig {
	const candidate: unknown = db;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		!("$client" in candidate)
	) {
		throw new MnemocyteError(
			"drizzleStore requires a Drizzle instance created with drizzle-orm/postgres-js, drizzle-orm/node-postgres or drizzle-orm/pglite.",
			"CONFIG",
		);
	}
	return createMnemocyteStoreConfig(createPostgresStore(toSqlExecutor(db)));
}
