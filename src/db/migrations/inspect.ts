import { MnemocyteError } from "../../errors.js";
import type { SqlExecutor, SqlQueryOptions } from "../../sql/executor.js";
import { postgresErrorCode } from "../errors.js";
import {
	getInstallationMeta,
	getPgvectorVersion,
	getStoredEmbeddingModels,
} from "../queries/meta.js";
import { MIGRATIONS } from "./bundled.js";
import {
	assertContiguous,
	installedVersion,
	readAppliedVersions,
	readCatalogState,
} from "./runner.js";

/** Which migrations a database has, as `migrate()` would find them. */
export type InstalledMigrations =
	/** No Mnemocyte tables. */
	| { readonly state: "none" }
	/**
	 * `tracked`: recorded in `mnemocyte_migrations`. `untracked`: read from
	 * the schema itself (installed with `psql` or drizzle-kit); `migrate()`
	 * records `applied` without running them.
	 */
	| {
			readonly state: "tracked" | "untracked";
			readonly applied: readonly string[];
			readonly pending: readonly string[];
	  }
	/** A state `migrate()` refuses: `reason` is its error message. */
	| { readonly state: "invalid"; readonly reason: string };

/** The `installation` row of `mnemocyte_meta`. */
export interface InstallationMeta {
	readonly dimensions: number;
	readonly model: string | null;
	readonly vectorType: string;
}

/** What {@link inspectPostgresInstallation} found. Facts only, no verdicts. */
export interface InstallationReport {
	/** `pg_extension.extversion` of `vector`, or null when it is not enabled. */
	readonly pgvectorVersion: string | null;
	readonly migrations: InstalledMigrations;
	/** The embedding column, or null without a memories table. */
	readonly column: {
		readonly dimensions: number;
		readonly vectorType: string;
	} | null;
	/**
	 * The installation row, or null when it is missing. Left out when
	 * migrations are pending, because older schemas lack its columns.
	 */
	readonly meta?: InstallationMeta | null;
	/**
	 * Up to two distinct embedding models of the stored memories. Read only
	 * when the installation row records no model, which is when the client
	 * infers one from them.
	 */
	readonly storedModels?: readonly string[];
}

/** Missing table or column. */
const MISSING_OBJECT_CODES = new Set(["42P01", "42703"]);

async function readEmbeddingColumn(
	db: SqlExecutor,
	options: SqlQueryOptions,
): Promise<InstallationReport["column"]> {
	// pgvector stores the declared size of `vector(n)` and `halfvec(n)` as the
	// column's type modifier.
	const rows = await db.query<{ dimensions: number; vectorType: string }>(
		`SELECT a.atttypmod AS "dimensions", t.typname AS "vectorType"
		FROM pg_catalog.pg_attribute a
		JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
		WHERE a.attrelid = to_regclass('mnemocyte_memories')
			AND a.attname = 'embedding'
			AND NOT a.attisdropped`,
		[],
		options,
	);
	const row = rows[0];
	return row
		? { dimensions: Number(row.dimensions), vectorType: row.vectorType }
		: null;
}

async function readMigrations(
	db: SqlExecutor,
	options: SqlQueryOptions,
): Promise<InstalledMigrations> {
	const names = MIGRATIONS.map((migration) => migration.name);
	const versions = await readAppliedVersions(db, options);
	const state = await readCatalogState(db, options);
	try {
		if (versions !== null && versions.length > 0) {
			assertContiguous(versions);
			return {
				state: "tracked",
				applied: names.slice(0, versions.length),
				pending: names.slice(versions.length),
			};
		}
		const installed = installedVersion(state);
		if (installed === -1) {
			return { state: "none" };
		}
		return {
			state: "untracked",
			applied: names.slice(0, installed + 1),
			pending: names.slice(installed + 1),
		};
	} catch (error) {
		// The runner's own refusals: gaps, a newer Mnemocyte, a schema that
		// matches no migration.
		if (error instanceof MnemocyteError && error.code === "MIGRATION") {
			return { state: "invalid", reason: error.message };
		}
		throw error;
	}
}

/**
 * Read what is installed: pgvector, the migrations, the embedding column
 * and the installation row. Sends only `SELECT`s, takes no advisory lock
 * and needs no transaction, so it also runs on an executor with only
 * `batch`. Statements are separate, so a `migrate()` committing between
 * them can make the parts disagree; run it again in that case.
 *
 * @throws {MnemocyteError} `"DB"` when a query fails.
 */
export async function inspectPostgresInstallation(
	db: SqlExecutor,
	options: SqlQueryOptions = {},
): Promise<InstallationReport> {
	try {
		const pgvectorVersion = await getPgvectorVersion(db);
		const column = await readEmbeddingColumn(db, options);
		const migrations = await readMigrations(db, options);
		const current =
			(migrations.state === "tracked" || migrations.state === "untracked") &&
			migrations.pending.length === 0;
		if (!current) {
			return { pgvectorVersion, migrations, column };
		}
		try {
			const row = await getInstallationMeta(db);
			if (row === null) {
				return { pgvectorVersion, migrations, column, meta: null };
			}
			const meta: InstallationMeta = {
				dimensions: Number(row.embeddingDimensions),
				model: row.embeddingModel,
				vectorType: row.vectorType,
			};
			if (meta.model !== null) {
				return { pgvectorVersion, migrations, column, meta };
			}
			const storedModels = await getStoredEmbeddingModels(db);
			return { pgvectorVersion, migrations, column, meta, storedModels };
		} catch (error) {
			const code = postgresErrorCode(error);
			if (code === undefined || !MISSING_OBJECT_CODES.has(code)) {
				throw error;
			}
			// Every migration is recorded, yet a table or column is gone.
			return {
				pgvectorVersion,
				column,
				migrations: {
					state: "invalid",
					reason:
						"mnemocyte_migrations records every migration, but a Mnemocyte table or column is missing. Compare the schema with migrations/ and restore it.",
				},
			};
		}
	} catch (error) {
		throw error instanceof MnemocyteError
			? error
			: new MnemocyteError(
					"Could not inspect the Postgres installation.",
					"DB",
					error,
				);
	}
}
