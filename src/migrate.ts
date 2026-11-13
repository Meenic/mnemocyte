import { MnemocyteError } from "./errors.js";
import { readMemoryClientInternals } from "./memory/client-internals.js";
import type { MemoryStore } from "./memory/store.js";
import { resolveStore } from "./memory/store-input.js";
import {
	assertMigrateDimensions,
	validateMigrateInput,
} from "./memory/validation.js";
import type { MigrateInput, MigrateResult } from "./types.js";

/**
 * Apply the store's pending schema migrations.
 *
 * Pass the app's client as `memory`: its store is migrated and its
 * `embedder.dimensions` fixes the embedding column on a fresh install. A
 * deploy step without a client passes `store` (the database client, or a
 * store from `postgresStore()`) and `dimensions` instead.
 *
 * Postgres: each migration runs in its own transaction, which first takes a
 * transaction-level advisory lock, so app instances that call `migrate()` at
 * the same time apply each migration once. Applied migrations are recorded in
 * `mnemocyte_migrations`. A database with no Mnemocyte tables gets the final
 * schema in one transaction; an existing installation without the tracking
 * table (installed with `psql` or drizzle-kit) is detected and adopted.
 * pgvector must be installed (`CREATE EXTENSION vector`) unless
 * `createExtension` is set, and the client needs interactive transactions,
 * so HTTP drivers cannot run it. `dryRun` reports what a run would do and
 * changes nothing.
 *
 * @throws {MnemocyteError} `"VALIDATION"` for malformed input, both or
 * neither of `memory` and `store`, or a fresh install without dimensions;
 * `"CONFIG"` when `dimensions` differs from the embedder or the
 * installation, `memory` did not come from Mnemocyte, or `store` is neither
 * a store from Mnemocyte nor a supported client;
 * `"MIGRATION"` when pgvector is missing (or `createExtension` lacks the
 * privilege), a migration fails (it is rolled back) or the schema matches no
 * known migration; `"ABORTED"` when `signal` aborts; `"DB"` for other driver
 * failures.
 *
 * @example
 * ```ts
 * import { createMemory, migrate } from "mnemocyte";
 * import postgres from "postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL!);
 * const memory = createMemory({ store: sql, embedder });
 * await migrate({ memory, createExtension: true });
 * ```
 */
export async function migrate(input: MigrateInput): Promise<MigrateResult> {
	validateMigrateInput(input);
	let store: MemoryStore;
	let dimensions = input.dimensions;
	if (input.memory !== undefined) {
		const internals = readMemoryClientInternals(input.memory);
		const embedderDimensions = internals.embedder.dimensions;
		if (dimensions !== undefined && dimensions !== embedderDimensions) {
			throw new MnemocyteError(
				`migrate() was called with dimensions ${dimensions}, but the client's embedder has dimensions ${embedderDimensions}. Drop dimensions, or fix the embedder.`,
				"CONFIG",
			);
		}
		assertMigrateDimensions(embedderDimensions, "embedder.dimensions");
		store = internals.store;
		dimensions = embedderDimensions;
	} else {
		store = resolveStore(input.store);
	}
	return await store.migrate({
		...(dimensions === undefined ? {} : { dimensions }),
		...(input.createExtension === true ? { createExtension: true } : {}),
		...(input.dryRun === true ? { dryRun: true } : {}),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}
