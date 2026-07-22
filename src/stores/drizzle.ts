import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createCallerOwnedDatabaseHandle } from "../db/index.js";
import { createPostgresStore } from "../memory/postgres.js";
import { createMnemocyteStoreConfig } from "../memory/store-config.js";
import type { MnemocyteStoreConfig } from "../types.js";

/**
 * Wrap a caller-owned postgres.js Drizzle instance for
 * {@link MnemocyteConfig.store}.
 *
 * The Mnemocyte tables must already exist in the public schema through the
 * bundled migrations. Closing the Mnemocyte client does not close the supplied
 * Drizzle instance or its underlying postgres.js client.
 *
 * @param db - A Drizzle instance created with `drizzle-orm/postgres-js`.
 */
export function drizzleStore<TSchema extends Record<string, unknown>>(
	db: PostgresJsDatabase<TSchema>,
): MnemocyteStoreConfig {
	return createMnemocyteStoreConfig(
		createPostgresStore(createCallerOwnedDatabaseHandle(db)),
	);
}
