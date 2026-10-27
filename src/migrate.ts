import { unwrapMnemocyteStoreConfig } from "./memory/store-config.js";
import { validateMigrateInput } from "./memory/validation.js";
import type { MigrateInput, MigrateResult } from "./types.js";

/**
 * Apply the store's pending schema migrations.
 *
 * Postgres: each migration runs in its own transaction, which first takes a
 * transaction-level advisory lock, so app instances that call `migrate()` at
 * the same time apply each migration once. Applied migrations are recorded in
 * `mnemocyte_migrations`. A database with no Mnemocyte tables gets the final
 * schema in one transaction; an existing installation without the tracking
 * table (installed with `psql` or drizzle-kit) is detected and adopted.
 * pgvector must already be installed (`CREATE EXTENSION vector`), and the
 * client needs interactive transactions, so HTTP drivers cannot run it.
 *
 * @throws {MnemocyteError} `"VALIDATION"` for malformed input or a fresh
 * install without `dimensions`; `"CONFIG"` when `dimensions` differs from
 * the installation or `store` is not a Mnemocyte store; `"MIGRATION"` when
 * pgvector is missing, a migration fails (it is rolled back) or the schema
 * matches no known migration; `"ABORTED"` when `signal` aborts; `"DB"` for
 * other driver failures.
 *
 * @example
 * ```ts
 * import { migrate } from "mnemocyte";
 * import { postgresJs, postgresStore } from "mnemocyte/postgres";
 * import postgres from "postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL!);
 * const store = postgresStore({ client: postgresJs(sql) });
 * await migrate({ store, dimensions: 1536 });
 * ```
 */
export async function migrate(input: MigrateInput): Promise<MigrateResult> {
	validateMigrateInput(input);
	const store = unwrapMnemocyteStoreConfig(input.store);
	return await store.migrate({
		...(input.dimensions === undefined ? {} : { dimensions: input.dimensions }),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}
