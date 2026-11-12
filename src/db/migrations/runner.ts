import { MnemocyteError } from "../../errors.js";
import { throwIfAborted } from "../../resilience.js";
import type { SqlExecutor, SqlQueryOptions } from "../../sql/executor.js";
import type { MigrateResult } from "../../types.js";
import { postgresErrorCode } from "../errors.js";
import {
	type BundledMigration,
	INITIAL_SCHEMA_TEMPLATE,
	MIGRATIONS,
} from "./bundled.js";

/**
 * Key of the transaction-level advisory lock every migration step takes:
 * "mnemocyt" in ASCII, read as a bigint. A session-level lock would have to be
 * released on the connection that took it, which a pooled executor does not
 * guarantee, and transaction-mode poolers do not support session locks.
 */
export const MIGRATION_LOCK_KEY = "7885351518266947956";

// pgvector's HNSW index supports `vector` up to 2,000 dimensions; above that
// the column is `halfvec`. Same rule as migrations/render-initial.mjs; the
// 4,000-dimension `halfvec` limit is checked by `assertMigrateDimensions`.
const MAX_VECTOR_DIMENSIONS = 2000;

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export interface RunMigrationsInput {
	dimensions?: number;
	createExtension?: boolean;
	dryRun?: boolean;
	signal?: AbortSignal;
}

interface MigrationStep extends MigrateResult {
	done: boolean;
}

/**
 * What one locked look at the database found, before anything changes. A
 * real run acts on it one step at a time; a dry run turns it into the whole
 * result at once.
 */
type Inspection =
	| {
			kind: "fresh";
			trackingTable: boolean;
			pgvector: boolean;
			dimensions: number;
	  }
	| { kind: "untracked"; trackingTable: boolean; installed: number }
	| { kind: "tracked"; versions: number[] };

interface CatalogState {
	memories: boolean;
	events: boolean;
	meta: boolean;
	metaModel: boolean;
	scoped: boolean;
}

/**
 * Split a migration into its statements. Each one is sent as its own query,
 * because the extended query protocol, which parameterized drivers use,
 * accepts one statement at a time.
 */
export function splitStatements(sql: string): string[] {
	return sql
		.split(STATEMENT_BREAKPOINT)
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/** The final schema for `dimensions`, as `render-initial.mjs` renders it. */
export function renderInitialSchema(dimensions: number): string {
	const vectorType = dimensions > MAX_VECTOR_DIMENSIONS ? "halfvec" : "vector";
	return INITIAL_SCHEMA_TEMPLATE.replaceAll(
		"{{EMBEDDING_DIMENSIONS}}",
		String(dimensions),
	).replaceAll("{{VECTOR_TYPE}}", vectorType);
}

/**
 * The newest migration an untracked schema has applied: -1 for no Mnemocyte
 * tables. Each migration leaves an object the previous one lacks: `0001`
 * creates `mnemocyte_meta`, `0002` adds its `embedding_model`, `0003` adds
 * `mnemocyte_memories.namespace`.
 */
export function installedVersion(state: CatalogState): number {
	const { memories, events, meta, metaModel, scoped } = state;
	if (!memories && !events && !meta) {
		return -1;
	}
	if (memories && events) {
		if (!meta && !metaModel && !scoped) return 0;
		if (meta && !metaModel && !scoped) return 1;
		if (meta && metaModel && !scoped) return 2;
		if (meta && metaModel && scoped) return 3;
	}
	throw new MnemocyteError(
		`The Mnemocyte tables match no migration (${JSON.stringify(state)}), so migrate() cannot tell which migrations were applied. Compare the schema with migrations/ and finish or undo the partial one.`,
		"MIGRATION",
	);
}

async function readCatalogState(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<CatalogState> {
	const rows = await tx.query<CatalogState>(
		`SELECT
			to_regclass('mnemocyte_memories') IS NOT NULL AS "memories",
			to_regclass('mnemocyte_events') IS NOT NULL AS "events",
			to_regclass('mnemocyte_meta') IS NOT NULL AS "meta",
			EXISTS (
				SELECT 1 FROM pg_catalog.pg_attribute
				WHERE attrelid = to_regclass('mnemocyte_meta')
					AND attname = 'embedding_model'
					AND NOT attisdropped
			) AS "metaModel",
			EXISTS (
				SELECT 1 FROM pg_catalog.pg_attribute
				WHERE attrelid = to_regclass('mnemocyte_memories')
					AND attname = 'namespace'
					AND NOT attisdropped
			) AS "scoped"`,
		[],
		options,
	);
	const row = rows[0];
	if (!row) {
		throw new MnemocyteError("The catalog query returned no row.", "DB");
	}
	return row;
}

/**
 * Dimensions of the installed embedding column, or null without a memories
 * table. pgvector stores the declared size of `vector(n)` and `halfvec(n)` as
 * the column's type modifier.
 */
async function readInstalledDimensions(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<number | null> {
	const rows = await tx.query<{ dimensions: number }>(
		`SELECT atttypmod AS "dimensions"
		FROM pg_catalog.pg_attribute
		WHERE attrelid = to_regclass('mnemocyte_memories')
			AND attname = 'embedding'
			AND NOT attisdropped`,
		[],
		options,
	);
	const row = rows[0];
	return row ? Number(row.dimensions) : null;
}

/** Applied versions in order, or null when the tracking table is missing. */
async function readAppliedVersions(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<number[] | null> {
	const [table] = await tx.query<{ exists: boolean }>(
		`SELECT to_regclass('mnemocyte_migrations') IS NOT NULL AS "exists"`,
		[],
		options,
	);
	if (!table?.exists) {
		return null;
	}
	const rows = await tx.query<{ version: number }>(
		"SELECT version FROM mnemocyte_migrations ORDER BY version",
		[],
		options,
	);
	return rows.map((row) => Number(row.version));
}

async function createTrackingTable(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<void> {
	// Checked for absence under the lock first, so no `IF NOT EXISTS`, which
	// would send a notice on every later call.
	await tx.query(
		`CREATE TABLE mnemocyte_migrations (
			version integer PRIMARY KEY NOT NULL,
			name text NOT NULL,
			applied_at timestamp with time zone DEFAULT now() NOT NULL
		)`,
		[],
		options,
	);
}

async function recordMigrations(
	tx: SqlExecutor,
	migrations: readonly BundledMigration[],
	options: SqlQueryOptions,
): Promise<string[]> {
	for (const migration of migrations) {
		await tx.query(
			"INSERT INTO mnemocyte_migrations (version, name) VALUES ($1::integer, $2)",
			[migration.version, migration.name],
			options,
		);
	}
	return migrations.map((migration) => migration.name);
}

async function runStatements(
	tx: SqlExecutor,
	name: string,
	sql: string,
	options: SqlQueryOptions,
): Promise<void> {
	try {
		for (const statement of splitStatements(sql)) {
			await tx.query(statement, [], options);
		}
	} catch (error) {
		if (error instanceof MnemocyteError) {
			throw error;
		}
		throw new MnemocyteError(
			`Migration ${name} failed and was rolled back.`,
			"MIGRATION",
			error,
		);
	}
}

function assertContiguous(versions: readonly number[]): void {
	versions.forEach((version, index) => {
		if (version !== index) {
			throw new MnemocyteError(
				`mnemocyte_migrations lists versions ${versions.join(", ")}; expected 0 through ${versions.length - 1} with no gaps.`,
				"MIGRATION",
			);
		}
	});
	if (versions.length > MIGRATIONS.length) {
		throw new MnemocyteError(
			`The database has ${versions.length} Mnemocyte migrations applied, but this version of Mnemocyte knows ${MIGRATIONS.length}. It was migrated by a newer Mnemocyte.`,
			"MIGRATION",
		);
	}
}

async function hasPgvector(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<boolean> {
	const rows = await tx.query(
		"SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector'",
		[],
		options,
	);
	return rows.length > 0;
}

/**
 * `CREATE EXTENSION` under the advisory lock, in the fresh install's
 * transaction: concurrent callers take turns, and a schema that fails rolls
 * the extension back with it. pgvector's control file is not `trusted`, so
 * the role needs superuser or a provider's admin role.
 */
async function createVectorExtension(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<void> {
	try {
		await tx.query("CREATE EXTENSION IF NOT EXISTS vector", [], options);
	} catch (error) {
		if (error instanceof MnemocyteError) {
			throw error;
		}
		const code = postgresErrorCode(error);
		const message =
			code === "42501"
				? "This database role may not create pgvector: CREATE EXTENSION vector needs a superuser or the provider's admin role. Have an admin run CREATE EXTENSION vector; once, then run migrate without createExtension."
				: code === "0A000"
					? "pgvector is not available on this Postgres server. Install it on the server (or pick a provider or image that ships it), then run migrate again."
					: "CREATE EXTENSION vector failed.";
		throw new MnemocyteError(message, "MIGRATION", error);
	}
}

/**
 * Take the advisory lock and find out what a run has to do. Throws the
 * errors a real run raises before its first change, so a dry run raises
 * them too.
 */
async function inspect(
	tx: SqlExecutor,
	input: RunMigrationsInput,
	options: SqlQueryOptions,
): Promise<Inspection> {
	await tx.query(
		`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`,
		[],
		options,
	);

	const installedDimensions = await readInstalledDimensions(tx, options);
	if (
		input.dimensions !== undefined &&
		installedDimensions !== null &&
		installedDimensions !== input.dimensions
	) {
		throw new MnemocyteError(
			`The installation stores ${installedDimensions}-dimension embeddings; migrate() was called with dimensions ${input.dimensions}.`,
			"CONFIG",
		);
	}

	const versions = await readAppliedVersions(tx, options);
	if (versions !== null && versions.length > 0) {
		assertContiguous(versions);
		return { kind: "tracked", versions };
	}

	const trackingTable = versions !== null;
	const installed = installedVersion(await readCatalogState(tx, options));
	if (installed !== -1) {
		return { kind: "untracked", trackingTable, installed };
	}
	if (input.dimensions === undefined) {
		throw new MnemocyteError(
			"dimensions is required for a fresh install: it fixes the embedding column for the installation. Pass memory (the client) or dimensions.",
			"VALIDATION",
		);
	}
	const pgvector = await hasPgvector(tx, options);
	if (!pgvector && input.createExtension !== true) {
		throw new MnemocyteError(
			"pgvector is not installed in this database. Pass createExtension: true to have migrate() run CREATE EXTENSION vector, or have an admin run it first.",
			"MIGRATION",
		);
	}
	return {
		kind: "fresh",
		trackingTable,
		pgvector,
		dimensions: input.dimensions,
	};
}

/**
 * One locked transaction: inspect, then apply or adopt at most one step.
 * Under `READ COMMITTED` each statement after the lock sees what a
 * concurrent `migrate()` committed before releasing it, so a second caller
 * skips work the first one did.
 */
async function migrateStep(
	tx: SqlExecutor,
	input: RunMigrationsInput,
): Promise<MigrationStep> {
	const options: SqlQueryOptions =
		input.signal === undefined ? {} : { signal: input.signal };
	const found = await inspect(tx, input, options);

	if (found.kind === "tracked") {
		const next = MIGRATIONS[found.versions.length];
		if (!next) {
			return { applied: [], adopted: [], extensionCreated: false, done: true };
		}
		await runStatements(tx, next.name, next.sql, options);
		await recordMigrations(tx, [next], options);
		return {
			applied: [next.name],
			adopted: [],
			extensionCreated: false,
			done: next.version + 1 === MIGRATIONS.length,
		};
	}

	if (!found.trackingTable) {
		await createTrackingTable(tx, options);
	}

	if (found.kind === "untracked") {
		const adopted = await recordMigrations(
			tx,
			MIGRATIONS.slice(0, found.installed + 1),
			options,
		);
		return {
			applied: [],
			adopted,
			extensionCreated: false,
			done: found.installed + 1 === MIGRATIONS.length,
		};
	}

	if (!found.pgvector) {
		await createVectorExtension(tx, options);
	}
	await runStatements(
		tx,
		"0000_initial (fresh install)",
		renderInitialSchema(found.dimensions),
		options,
	);
	return {
		applied: await recordMigrations(tx, MIGRATIONS, options),
		adopted: [],
		extensionCreated: !found.pgvector,
		done: true,
	};
}

/**
 * The whole result of a run, from one read-only transaction. It takes the
 * advisory lock too, so it waits for a running `migrate()` step and reports
 * what is left after it.
 */
async function dryRun(
	tx: SqlExecutor,
	input: RunMigrationsInput,
): Promise<MigrateResult> {
	const options: SqlQueryOptions =
		input.signal === undefined ? {} : { signal: input.signal };
	// Must be the transaction's first statement. Any write, even one this
	// code should never send, then fails instead of changing the database.
	await tx.query("SET TRANSACTION READ ONLY", [], options);
	const found = await inspect(tx, input, options);
	const names = MIGRATIONS.map((migration) => migration.name);
	switch (found.kind) {
		case "tracked":
			return {
				applied: names.slice(found.versions.length),
				adopted: [],
				extensionCreated: false,
			};
		case "untracked":
			return {
				applied: names.slice(found.installed + 1),
				adopted: names.slice(0, found.installed + 1),
				extensionCreated: false,
			};
		case "fresh":
			return { applied: names, adopted: [], extensionCreated: !found.pgvector };
	}
}

function toMigrationError(error: unknown): MnemocyteError {
	return error instanceof MnemocyteError
		? error
		: new MnemocyteError("Postgres migration failed.", "DB", error);
}

/**
 * Apply pending migrations, one transaction per migration, or with `dryRun`
 * report them from one read-only transaction. Requires an executor with
 * interactive transactions: each step reads the tracking table and decides
 * what to run from it, which a `batch` cannot express.
 */
export async function runPostgresMigrations(
	db: SqlExecutor,
	input: RunMigrationsInput,
): Promise<MigrateResult> {
	const transaction = db.transaction?.bind(db);
	if (transaction === undefined) {
		throw new MnemocyteError(
			"migrate needs an executor with interactive transactions (SqlExecutor.transaction). Run it over a regular connection, not a stateless HTTP driver.",
			"CONFIG",
		);
	}
	if (input.dryRun === true) {
		throwIfAborted(input.signal);
		try {
			return await transaction((tx) => dryRun(tx, input));
		} catch (error) {
			throw toMigrationError(error);
		}
	}
	const result: MigrateResult = {
		applied: [],
		adopted: [],
		extensionCreated: false,
	};
	for (;;) {
		throwIfAborted(input.signal);
		let step: MigrationStep;
		try {
			step = await transaction((tx) => migrateStep(tx, input));
		} catch (error) {
			throw toMigrationError(error);
		}
		result.applied.push(...step.applied);
		result.adopted.push(...step.adopted);
		result.extensionCreated ||= step.extensionCreated;
		if (step.done) {
			return result;
		}
	}
}
