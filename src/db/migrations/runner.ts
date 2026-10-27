import { MnemocyteError } from "../../errors.js";
import { throwIfAborted } from "../../resilience.js";
import type { SqlExecutor, SqlQueryOptions } from "../../sql/executor.js";
import type { MigrateResult } from "../../types.js";
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
// 4,000-dimension `halfvec` limit is checked by `validateMigrateInput`.
const MAX_VECTOR_DIMENSIONS = 2000;

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export interface RunMigrationsInput {
	dimensions?: number;
	signal?: AbortSignal;
}

interface MigrationStep {
	applied: string[];
	adopted: string[];
	done: boolean;
}

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

async function freshInstall(
	tx: SqlExecutor,
	dimensions: number | undefined,
	options: SqlQueryOptions,
): Promise<MigrationStep> {
	if (dimensions === undefined) {
		throw new MnemocyteError(
			"dimensions is required for a fresh install: it fixes the embedding column for the installation.",
			"VALIDATION",
		);
	}
	const extension = await tx.query(
		"SELECT 1 FROM pg_catalog.pg_extension WHERE extname = 'vector'",
		[],
		options,
	);
	if (extension.length === 0) {
		throw new MnemocyteError(
			"pgvector is not installed in this database. Run CREATE EXTENSION vector; first; migrate() never creates extensions.",
			"MIGRATION",
		);
	}
	await runStatements(
		tx,
		"0000_initial (fresh install)",
		renderInitialSchema(dimensions),
		options,
	);
	return {
		applied: await recordMigrations(tx, MIGRATIONS, options),
		adopted: [],
		done: true,
	};
}

/**
 * One locked transaction: take the advisory lock, re-read the tracking
 * table, then apply or adopt at most one step. Under `READ COMMITTED` each
 * statement after the lock sees what a concurrent `migrate()` committed
 * before releasing it, so a second caller skips work the first one did.
 */
async function migrateStep(
	tx: SqlExecutor,
	input: RunMigrationsInput,
): Promise<MigrationStep> {
	const options: SqlQueryOptions =
		input.signal === undefined ? {} : { signal: input.signal };
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

	let versions = await readAppliedVersions(tx, options);
	if (versions === null) {
		await createTrackingTable(tx, options);
		versions = [];
	}

	if (versions.length === 0) {
		const installed = installedVersion(await readCatalogState(tx, options));
		if (installed === -1) {
			return await freshInstall(tx, input.dimensions, options);
		}
		const adopted = await recordMigrations(
			tx,
			MIGRATIONS.slice(0, installed + 1),
			options,
		);
		return {
			applied: [],
			adopted,
			done: installed + 1 === MIGRATIONS.length,
		};
	}

	assertContiguous(versions);
	const next = MIGRATIONS[versions.length];
	if (!next) {
		return { applied: [], adopted: [], done: true };
	}
	await runStatements(tx, next.name, next.sql, options);
	await recordMigrations(tx, [next], options);
	return {
		applied: [next.name],
		adopted: [],
		done: next.version + 1 === MIGRATIONS.length,
	};
}

/**
 * Apply pending migrations, one transaction per migration. Requires an
 * executor with interactive transactions.
 */
export async function runPostgresMigrations(
	db: SqlExecutor,
	input: RunMigrationsInput,
): Promise<MigrateResult> {
	const result: MigrateResult = { applied: [], adopted: [] };
	for (;;) {
		throwIfAborted(input.signal);
		let step: MigrationStep;
		try {
			step = await db.transaction((tx) => migrateStep(tx, input));
		} catch (error) {
			if (error instanceof MnemocyteError) {
				throw error;
			}
			throw new MnemocyteError("Postgres migration failed.", "DB", error);
		}
		result.applied.push(...step.applied);
		result.adopted.push(...step.adopted);
		if (step.done) {
			return result;
		}
	}
}
