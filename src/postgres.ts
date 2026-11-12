import { createPostgresStore } from "./memory/postgres.js";
import { createMnemocyteStoreConfig } from "./memory/store-config.js";
import { type PostgresClient, toSqlExecutor } from "./sql/clients.js";
import type { MnemocyteStoreConfig } from "./types.js";

export type {
	DrizzleClient,
	PostgresClient,
	PostgresJsClient,
} from "./sql/clients.js";
export type {
	SqlExecutor,
	SqlQueryOptions,
	SqlStatement,
} from "./sql/executor.js";
export type {
	NodePostgresPool,
	NodePostgresPoolClient,
	NodePostgresQueryResult,
} from "./sql/node-postgres.js";
export type {
	PGliteClient,
	PGliteQueryResult,
	PGliteTransaction,
} from "./sql/pglite.js";
export { type PostgresJsExecutor, postgresJs } from "./sql/postgres-js.js";

/** Options for {@link postgresStore}. */
export interface PostgresStoreOptions {
	/**
	 * The caller-owned database client: a postgres.js `sql` function, a
	 * node-postgres `Pool`, a PGlite instance, a Drizzle instance over one of
	 * them, or a hand-written {@link SqlExecutor}.
	 */
	client: PostgresClient;
}

/**
 * Create a Postgres + pgvector storage adapter for
 * {@link MemoryConfig.store}.
 *
 * The client is recognised by its shape, without importing any driver:
 * postgres.js, then Drizzle (`db.$client`), then PGlite, then a
 * node-postgres `Pool`, then a {@link SqlExecutor}. The Mnemocyte tables must
 * already exist in the schema the connection's `search_path` resolves,
 * through `migrate()` or the bundled migrations. Mnemocyte never closes
 * `client`.
 *
 * @example
 * ```ts
 * import postgres from "postgres";
 * import { postgresStore } from "mnemocyte/postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 5 });
 * const store = postgresStore({ client: sql });
 * ```
 *
 * @throws {MnemocyteError} `"CONFIG"` when `client` is none of the above,
 * including a node-postgres `Client` (pass a `Pool`).
 */
export function postgresStore(
	options: PostgresStoreOptions,
): MnemocyteStoreConfig {
	return createMnemocyteStoreConfig(
		createPostgresStore(toSqlExecutor(options.client)),
	);
}
