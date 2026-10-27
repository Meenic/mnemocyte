import { createPostgresStore } from "./memory/postgres.js";
import { createMnemocyteStoreConfig } from "./memory/store-config.js";
import type { SqlExecutor } from "./sql/executor.js";
import type { MnemocyteStoreConfig } from "./types.js";

export type { SqlExecutor, SqlQueryOptions } from "./sql/executor.js";
export { postgresJs } from "./sql/postgres-js.js";

/** Options for {@link postgresStore}. */
export interface PostgresStoreOptions {
	/** The caller-owned database client, wrapped as a {@link SqlExecutor}. */
	client: SqlExecutor;
}

/**
 * Create a Postgres + pgvector storage adapter for
 * {@link MnemocyteConfig.store}.
 *
 * The Mnemocyte tables must already exist in the schema the connection's
 * `search_path` resolves, through the bundled migrations. Closing the Mnemocyte
 * client does not close `client`.
 *
 * @example
 * ```ts
 * import postgres from "postgres";
 * import { postgresJs, postgresStore } from "mnemocyte/postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL, { ssl: "require", max: 5 });
 * const store = postgresStore({ client: postgresJs(sql) });
 * ```
 */
export function postgresStore(
	options: PostgresStoreOptions,
): MnemocyteStoreConfig {
	return createMnemocyteStoreConfig(createPostgresStore(options.client));
}
