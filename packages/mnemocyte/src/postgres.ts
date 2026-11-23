import { assertSchemaName } from "./db/tables.js";
import { createPostgresStore } from "./memory/postgres.js";
import { createMnemocyteStoreConfig } from "./memory/store-config.js";
import { assertKnownKeys } from "./options.js";
import { type PostgresClient, toSqlExecutor } from "./sql/clients.js";
import type { MnemocyteStoreConfig } from "./types.js";

export type {
	DrizzleClient,
	NeonHttpClient,
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

/** Options for {@link postgresStore}. */
export interface PostgresStoreOptions {
	/**
	 * The caller-owned database client: a postgres.js `sql` function, a
	 * node-postgres `Pool`, a PGlite instance, Neon's `neon()` function, a
	 * Drizzle instance over one of them, or a hand-written
	 * {@link SqlExecutor}.
	 */
	client: PostgresClient;
	/**
	 * The Postgres schema that holds Mnemocyte's tables, such as `"memory"`.
	 * Every query names it, so the tables are found whatever `search_path`
	 * says; `migrate()` installs into it and creates the schema when it is
	 * missing. Lower case letters, digits and underscores, at most 63
	 * characters, not starting with a digit or `pg_`.
	 *
	 * Left out, the tables are found through the connection's `search_path`,
	 * which is `public` on a default setup.
	 */
	schemaName?: string | undefined;
}

/**
 * Create a Postgres + pgvector storage adapter for
 * {@link MemoryConfig.store}.
 *
 * The client is recognised by its shape, without importing any driver:
 * postgres.js, then Drizzle (`db.$client`), then PGlite, then a
 * node-postgres `Pool`, then a {@link SqlExecutor}. The Mnemocyte tables must
 * already exist, through `migrate()` or the bundled migrations: in
 * `schemaName` when it is set, otherwise in the schema the connection's
 * `search_path` resolves. Mnemocyte never closes `client`.
 *
 * @example
 * ```ts
 * import postgres from "postgres";
 * import { postgresStore } from "mnemocyte/postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 5 });
 * const store = postgresStore({ client: sql, schemaName: "memory" });
 * ```
 *
 * @throws {MnemocyteError} `"CONFIG"` when `client` is none of the above,
 * including a node-postgres `Client` (pass a `Pool`), or `schemaName` is
 * not a name Mnemocyte accepts.
 */
export function postgresStore(
	options: PostgresStoreOptions,
): MnemocyteStoreConfig {
	assertKnownKeys("postgresStore", options, ["client", "schemaName"]);
	const { schemaName } = options;
	if (schemaName !== undefined) {
		assertSchemaName(schemaName, "schemaName");
	}
	return createMnemocyteStoreConfig(
		createPostgresStore(
			toSqlExecutor(options.client),
			schemaName === undefined ? {} : { schemaName },
		),
	);
}
