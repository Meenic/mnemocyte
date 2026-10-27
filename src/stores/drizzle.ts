import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { Sql } from "postgres";
import { MnemocyteError } from "../errors.js";
import { createPostgresStore } from "../memory/postgres.js";
import { createMnemocyteStoreConfig } from "../memory/store-config.js";
import { postgresJs } from "../sql/postgres-js.js";
import type { MnemocyteStoreConfig } from "../types.js";

/**
 * Wrap a caller-owned postgres.js Drizzle instance for
 * {@link MnemocyteConfig.store}.
 *
 * Mnemocyte runs its own SQL on the postgres.js client behind `db`
 * (`db.$client`), so it shares that client's pool and settings. The Mnemocyte
 * tables must already exist in the public schema through the bundled
 * migrations. Closing the Mnemocyte client does not close the supplied Drizzle
 * instance or its underlying postgres.js client.
 *
 * @param db - A Drizzle instance created with `drizzle-orm/postgres-js`.
 * @throws {MnemocyteError} With code `"CONFIG"` if `db` has no postgres.js
 * client.
 */
export function drizzleStore<TSchema extends Record<string, unknown>>(
	db: PostgresJsDatabase<TSchema>,
): MnemocyteStoreConfig {
	// drizzle-orm/postgres-js exposes the postgres.js client as `$client`; the
	// exported database type does not declare it.
	const client = (db as { $client?: Sql }).$client;
	if (typeof client !== "function") {
		throw new MnemocyteError(
			"drizzleStore requires a Drizzle instance created with drizzle-orm/postgres-js.",
			"CONFIG",
		);
	}
	return createMnemocyteStoreConfig(createPostgresStore(postgresJs(client)));
}
