import { MnemocyteError } from "./errors.js";
import { readMemoryClientInternals } from "./memory/client-internals.js";
import type { MemoryStore } from "./memory/store.js";
import { resolveStore } from "./memory/store-input.js";
import {
	assertMigrateDimensions,
	validateMigrateInput,
	validateSetTextSearchConfigInput,
} from "./memory/validation.js";
import type {
	MigrateInput,
	MigrateResult,
	SetTextSearchConfigInput,
	TextSearchConfigResult,
} from "./types.js";

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
 * `textSearchConfig` picks the Postgres text search configuration keyword
 * search uses (`english` by default) on a fresh install; on an existing one
 * it must match, and {@link setTextSearchConfig} changes it.
 *
 * @throws {MnemocyteError} `"VALIDATION"` for malformed input, both or
 * neither of `memory` and `store`, a fresh install without dimensions, or
 * a `textSearchConfig` the database does not have;
 * `"CONFIG"` when `dimensions` differs from the embedder or the
 * installation, `textSearchConfig` differs from the installation's, `memory` did not come from Mnemocyte, or `store` is neither
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
			throw new MnemocyteError({
				message: `migrate() was called with dimensions ${dimensions}, but the client's embedder has dimensions ${embedderDimensions}. Drop dimensions, or fix the embedder.`,
				code: "CONFIG",
				reason: "INVALID_OPTION",
			});
		}
		assertMigrateDimensions(embedderDimensions, "embedder.dimensions");
		store = internals.store;
		dimensions = embedderDimensions;
	} else {
		store = resolveStore(input.store);
	}
	return await store.migrate({
		...(dimensions === undefined ? {} : { dimensions }),
		...(input.textSearchConfig === undefined
			? {}
			: { textSearchConfig: input.textSearchConfig }),
		...(input.createExtension === true ? { createExtension: true } : {}),
		...(input.dryRun === true ? { dryRun: true } : {}),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}

/**
 * Change the text search configuration keyword search uses on an existing
 * installation, such as from `"english"` to `"simple"` for memories in
 * several languages.
 *
 * Postgres: `content_tsv` is a stored generated column, so the change
 * rewrites `mnemocyte_memories` and rebuilds every index on it, the HNSW
 * index included. Reads and writes of memories wait until it commits, so
 * run it in a maintenance window. It runs in one transaction under the
 * advisory lock `migrate()` takes, needs every migration applied and an
 * executor with interactive transactions, and does nothing when the
 * configuration is already in place. Other running clients keep the
 * configuration they read first until they restart. `dryRun` reports what
 * would change from a read-only transaction.
 *
 * The in-memory store has no configuration: it resolves with `null` names
 * and `changed: false`.
 *
 * @throws {MnemocyteError} `"VALIDATION"` for malformed input, both or
 * neither of `memory` and `store`, or a configuration the database does not
 * have; `"CONFIG"` for an executor without transactions, or a `memory` or
 * `store` Mnemocyte does not recognize; `"MIGRATION"` when the schema is
 * missing or behind, `content_tsv` was changed by hand, or the rewrite
 * fails (it is rolled back); `"ABORTED"` when `signal` aborts; `"DB"` for
 * other driver failures.
 *
 * @example
 * ```ts
 * import { setTextSearchConfig } from "mnemocyte";
 * import { memory } from "./memory";
 *
 * await setTextSearchConfig({ memory, textSearchConfig: "simple" });
 * ```
 */
export async function setTextSearchConfig(
	input: SetTextSearchConfigInput,
): Promise<TextSearchConfigResult> {
	validateSetTextSearchConfigInput(input);
	const store: MemoryStore =
		input.memory === undefined
			? resolveStore(input.store)
			: readMemoryClientInternals(input.memory).store;
	return await store.setTextSearchConfig({
		textSearchConfig: input.textSearchConfig,
		...(input.dryRun === true ? { dryRun: true } : {}),
		...(input.signal === undefined ? {} : { signal: input.signal }),
	});
}
