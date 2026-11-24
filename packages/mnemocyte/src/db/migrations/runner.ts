import { isMnemocyteError, MnemocyteError } from "../../errors.js";
import { throwIfAborted } from "../../resilience.js";
import type { SqlExecutor, SqlQueryOptions } from "../../sql/executor.js";
import type { MigrateResult } from "../../types.js";
import { postgresErrorCode } from "../errors.js";
import {
	DEFAULT_TABLES,
	type PostgresTables,
	quoteIdentifier,
	regclass,
} from "../tables.js";
import {
	DEFAULT_TEXT_SEARCH_CONFIG,
	readInstalledTextSearchConfig,
	resolveTextSearchConfig,
	textSearchConfigLiteral,
	unrecognizedTextSearchError,
} from "../text-search.js";
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
// the column is `halfvec`. scripts/bundle-migrations.ts renders
// fresh-install.sql with the same rule; the 4,000-dimension `halfvec` limit
// is checked by `assertMigrateDimensions`.
const MAX_VECTOR_DIMENSIONS = 2000;

/** The embedding column's type for `dimensions`: `halfvec` above 2,000. */
export function vectorTypeFor(dimensions: number): "vector" | "halfvec" {
	return dimensions > MAX_VECTOR_DIMENSIONS ? "halfvec" : "vector";
}

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export interface RunMigrationsInput {
	/** Where the tables live. @defaultValue {@link DEFAULT_TABLES} */
	tables?: PostgresTables;
	dimensions?: number;
	textSearchConfig?: string;
	createExtension?: boolean;
	dryRun?: boolean;
	signal?: AbortSignal;
}

interface MigrationStep extends MigrateResult {
	done: boolean;
}

/** A result that applied, adopted and created nothing. */
function nothing(): MigrateResult {
	return {
		applied: [],
		adopted: [],
		extensionCreated: false,
		schemaCreated: false,
	};
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
			/** False when `schemaName` names a schema that does not exist yet. */
			schema: boolean;
			dimensions: number;
			/** Canonical, as `regconfig` prints it. */
			textSearchConfig: string;
	  }
	| { kind: "untracked"; trackingTable: boolean; installed: number }
	| { kind: "tracked"; versions: number[] };

export interface CatalogState {
	memories: boolean;
	events: boolean;
	meta: boolean;
	metaModel: boolean;
	scoped: boolean;
	eventMemoryId: boolean;
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

/**
 * The self foreign key's target as `0000`, `0003` and the template name
 * it. Every other name in the migrations is bare and resolves through
 * `search_path`.
 */
const PUBLIC_SELF_REFERENCE = '"public"."mnemocyte_memories"';

/**
 * `sql` with the self foreign key pointing at the memories table in
 * `schema`, for an installation outside `public`. Unchanged without one.
 */
export function qualifySelfReference(
	sql: string,
	schema: string | null,
): string {
	return schema === null
		? sql
		: sql.replaceAll(
				PUBLIC_SELF_REFERENCE,
				`${quoteIdentifier(schema)}."mnemocyte_memories"`,
			);
}

/**
 * The final schema for `dimensions` (`halfvec` above 2,000) and the text
 * search configuration of `content_tsv` (`english` by default). The name is
 * written as a string literal; Postgres resolves it when the schema runs.
 * With `schema`, the self foreign key names that schema; the other names
 * stay bare, so the caller puts the schema first on `search_path`.
 */
export function renderInitialSchema(
	dimensions: number,
	textSearchConfig: string = DEFAULT_TEXT_SEARCH_CONFIG,
	schema: string | null = null,
): string {
	const vectorType = vectorTypeFor(dimensions);
	const rendered = INITIAL_SCHEMA_TEMPLATE.replaceAll(
		"{{EMBEDDING_DIMENSIONS}}",
		String(dimensions),
	)
		.replaceAll("{{VECTOR_TYPE}}", vectorType)
		.replaceAll(
			"'{{TEXT_SEARCH_CONFIG}}'",
			textSearchConfigLiteral(textSearchConfig),
		);
	return qualifySelfReference(rendered, schema);
}

/**
 * The newest migration an untracked schema has applied: -1 for no Mnemocyte
 * tables. Each migration leaves an object the previous one lacks: `0001`
 * creates `mnemocyte_meta`, `0002` adds its `embedding_model`, `0003` adds
 * `mnemocyte_memories.namespace`, `0004` adds `mnemocyte_events.memory_id`.
 */
export function installedVersion(state: CatalogState): number {
	const { memories, events, meta, metaModel, scoped, eventMemoryId } = state;
	if (!memories && !events && !meta) {
		return -1;
	}
	if (memories && events) {
		if (!eventMemoryId) {
			if (!meta && !metaModel && !scoped) return 0;
			if (meta && !metaModel && !scoped) return 1;
			if (meta && metaModel && !scoped) return 2;
			if (meta && metaModel && scoped) return 3;
		} else if (meta && metaModel && scoped) {
			return 4;
		}
	}
	throw new MnemocyteError({
		message: `The Mnemocyte tables match no migration (${JSON.stringify(state)}), so migrate() cannot tell which migrations were applied. Compare the schema with migrations/ and finish or undo the partial one.`,
		code: "MIGRATION",
		reason: "SCHEMA_UNRECOGNIZED",
	});
}

export async function readCatalogState(
	tx: SqlExecutor,
	options: SqlQueryOptions,
	tables: PostgresTables = DEFAULT_TABLES,
): Promise<CatalogState> {
	const memories = regclass(tables.memories);
	const events = regclass(tables.events);
	const meta = regclass(tables.meta);
	const rows = await tx.query<CatalogState>(
		`SELECT
			${memories} IS NOT NULL AS "memories",
			${events} IS NOT NULL AS "events",
			${meta} IS NOT NULL AS "meta",
			EXISTS (
				SELECT 1 FROM pg_catalog.pg_attribute
				WHERE attrelid = ${meta}
					AND attname = 'embedding_model'
					AND NOT attisdropped
			) AS "metaModel",
			EXISTS (
				SELECT 1 FROM pg_catalog.pg_attribute
				WHERE attrelid = ${memories}
					AND attname = 'namespace'
					AND NOT attisdropped
			) AS "scoped",
			EXISTS (
				SELECT 1 FROM pg_catalog.pg_attribute
				WHERE attrelid = ${events}
					AND attname = 'memory_id'
					AND NOT attisdropped
			) AS "eventMemoryId"`,
		[],
		options,
	);
	const row = rows[0];
	if (!row) {
		throw new MnemocyteError({
			message: "The catalog query returned no row.",
			code: "DB",
		});
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
	tables: PostgresTables,
	options: SqlQueryOptions,
): Promise<number | null> {
	const rows = await tx.query<{ dimensions: number }>(
		`SELECT atttypmod AS "dimensions"
		FROM pg_catalog.pg_attribute
		WHERE attrelid = ${regclass(tables.memories)}
			AND attname = 'embedding'
			AND NOT attisdropped`,
		[],
		options,
	);
	const row = rows[0];
	return row ? Number(row.dimensions) : null;
}

/** Applied versions in order, or null when the tracking table is missing. */
export async function readAppliedVersions(
	tx: SqlExecutor,
	options: SqlQueryOptions,
	tables: PostgresTables = DEFAULT_TABLES,
): Promise<number[] | null> {
	const [table] = await tx.query<{ exists: boolean }>(
		`SELECT ${regclass(tables.migrations)} IS NOT NULL AS "exists"`,
		[],
		options,
	);
	if (!table?.exists) {
		return null;
	}
	const rows = await tx.query<{ version: number }>(
		`SELECT version FROM ${tables.migrations} ORDER BY version`,
		[],
		options,
	);
	return rows.map((row) => Number(row.version));
}

async function createTrackingTable(
	tx: SqlExecutor,
	tables: PostgresTables,
	options: SqlQueryOptions,
): Promise<void> {
	// Checked for absence under the lock first, so no `IF NOT EXISTS`, which
	// would send a notice on every later call.
	await tx.query(
		`CREATE TABLE ${tables.migrations} (
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
	tables: PostgresTables,
	migrations: readonly BundledMigration[],
	options: SqlQueryOptions,
): Promise<string[]> {
	for (const migration of migrations) {
		await tx.query(
			`INSERT INTO ${tables.migrations} (version, name) VALUES ($1::integer, $2)`,
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
		if (isMnemocyteError(error)) {
			throw error;
		}
		throw new MnemocyteError({
			message: `Migration ${name} failed and was rolled back.`,
			code: "MIGRATION",
			reason: "MIGRATION_FAILED",
			cause: error,
		});
	}
}

export function assertContiguous(versions: readonly number[]): void {
	versions.forEach((version, index) => {
		if (version !== index) {
			throw new MnemocyteError({
				message: `mnemocyte_migrations lists versions ${versions.join(", ")}; expected 0 through ${versions.length - 1} with no gaps.`,
				code: "MIGRATION",
				reason: "SCHEMA_UNRECOGNIZED",
			});
		}
	});
	if (versions.length > MIGRATIONS.length) {
		throw new MnemocyteError({
			message: `The database has ${versions.length} Mnemocyte migrations applied, but this version of Mnemocyte knows ${MIGRATIONS.length}. It was migrated by a newer Mnemocyte.`,
			code: "MIGRATION",
			reason: "SCHEMA_NEWER",
		});
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

async function hasSchema(
	tx: SqlExecutor,
	schema: string,
	options: SqlQueryOptions,
): Promise<boolean> {
	const rows = await tx.query(
		"SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = $1",
		[schema],
		options,
	);
	return rows.length > 0;
}

/**
 * The schema that the bare name `mnemocyte_memories` resolves to through
 * `search_path`, or null when it resolves to none. That is the installation
 * a client without `schemaName` uses.
 */
async function searchPathInstallation(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<string | null> {
	const rows = await tx.query<{ schema: string }>(
		`SELECT n.nspname AS "schema"
		FROM pg_catalog.pg_class c
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE c.oid = to_regclass('mnemocyte_memories')`,
		[],
		options,
	);
	return rows[0]?.schema ?? null;
}

/**
 * `CREATE SCHEMA` for a fresh install outside `public`, in the install's
 * transaction, so a schema that fails takes the new schema with it.
 * Checked for absence under the lock first, so no `IF NOT EXISTS`, which
 * would send a notice.
 */
async function createSchema(
	tx: SqlExecutor,
	schema: string,
	options: SqlQueryOptions,
): Promise<void> {
	try {
		await tx.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`, [], options);
	} catch (error) {
		if (isMnemocyteError(error)) {
			throw error;
		}
		throw new MnemocyteError({
			message:
				postgresErrorCode(error) === "42501"
					? `This database role may not create the schema "${schema}": CREATE SCHEMA needs the CREATE privilege on the database. Have an admin run CREATE SCHEMA ${schema} AUTHORIZATION <your role>; then run migrate again.`
					: `CREATE SCHEMA ${schema} failed and was rolled back.`,
			code: "MIGRATION",
			reason: "MIGRATION_FAILED",
			cause: error,
		});
	}
}

/**
 * Put `schema` first on `search_path` until the transaction ends
 * (`set_config(…, true)` is `SET LOCAL`), so the bundled SQL, whose names
 * are bare, creates and changes the tables there. The rest of the path
 * stays, so `vector` and its operators resolve as before, wherever
 * pgvector is installed.
 */
async function useSchema(
	tx: SqlExecutor,
	schema: string,
	options: SqlQueryOptions,
): Promise<void> {
	await tx.query(
		`SELECT set_config(
			'search_path',
			CASE WHEN current_setting('search_path') = '' THEN $1
				ELSE $1 || ', ' || current_setting('search_path') END,
			true
		)`,
		[quoteIdentifier(schema)],
		options,
	);
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
		if (isMnemocyteError(error)) {
			throw error;
		}
		const code = postgresErrorCode(error);
		const message =
			code === "42501"
				? "This database role may not create pgvector: CREATE EXTENSION vector needs a superuser or the provider's admin role. Have an admin run CREATE EXTENSION vector; once, then run migrate without createExtension."
				: code === "0A000"
					? "pgvector is not available on this Postgres server. Install it on the server (or pick a provider or image that ships it), then run migrate again."
					: "CREATE EXTENSION vector failed.";
		throw new MnemocyteError({
			message,
			code: "MIGRATION",
			reason: "PGVECTOR_UNAVAILABLE",
			cause: error,
		});
	}
}

/**
 * The configuration a fresh install gives `content_tsv`, canonical. When
 * `migrate` names one and the installation exists, it must be the same
 * configuration (`"CONFIG"` otherwise): `migrate` sets it only on a fresh
 * install, because changing it rewrites the table. A schema before `0003`
 * has no `content_tsv` yet and gets `english` from `0003`.
 */
async function checkTextSearchConfig(
	tx: SqlExecutor,
	input: RunMigrationsInput,
	tables: PostgresTables,
	hasMemories: boolean,
	options: SqlQueryOptions,
): Promise<string> {
	if (input.textSearchConfig === undefined) {
		return DEFAULT_TEXT_SEARCH_CONFIG;
	}
	let installed: string | null = null;
	if (hasMemories) {
		const found = await readInstalledTextSearchConfig(tx, options, tables);
		if (found.kind === "unrecognized") {
			throw unrecognizedTextSearchError(found.expression);
		}
		installed =
			found.kind === "config" ? found.name : DEFAULT_TEXT_SEARCH_CONFIG;
	}
	const requested = await resolveTextSearchConfig(
		tx,
		input.textSearchConfig,
		installed,
		options,
	);
	if (installed !== null && !requested.same) {
		throw new MnemocyteError({
			message: `The installation's keyword search uses the "${installed}" text search configuration; migrate() was called with textSearchConfig "${input.textSearchConfig}". migrate() sets it only on a fresh install. Change it with setTextSearchConfig() or mnemocyte text-search ${requested.name}, which rewrites the memories table.`,
			code: "CONFIG",
			reason: "TEXT_SEARCH_CONFIG_MISMATCH",
		});
	}
	return requested.name;
}

/**
 * Take the advisory lock and find out what a run has to do. Throws the
 * errors a real run raises before its first change, so a dry run raises
 * them too.
 */
async function inspect(
	tx: SqlExecutor,
	input: RunMigrationsInput,
	tables: PostgresTables,
	options: SqlQueryOptions,
): Promise<Inspection> {
	await tx.query(
		`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`,
		[],
		options,
	);

	const installedDimensions = await readInstalledDimensions(
		tx,
		tables,
		options,
	);
	if (
		input.dimensions !== undefined &&
		installedDimensions !== null &&
		installedDimensions !== input.dimensions
	) {
		throw new MnemocyteError({
			message: `The installation stores ${installedDimensions}-dimension embeddings; migrate() was called with dimensions ${input.dimensions}.`,
			code: "CONFIG",
			reason: "DIMENSIONS_MISMATCH",
		});
	}

	// The embedding column exists exactly when the memories table does: it
	// is in every migration since 0000.
	const textSearchConfig = await checkTextSearchConfig(
		tx,
		input,
		tables,
		installedDimensions !== null,
		options,
	);

	const versions = await readAppliedVersions(tx, options, tables);
	if (versions !== null && versions.length > 0) {
		assertContiguous(versions);
		return { kind: "tracked", versions };
	}

	const trackingTable = versions !== null;
	const installed = installedVersion(
		await readCatalogState(tx, options, tables),
	);
	if (installed !== -1) {
		return { kind: "untracked", trackingTable, installed };
	}
	if (tables.schema !== null) {
		// A client without schemaName would use the tables `search_path`
		// finds; a fresh install here would leave its memories behind.
		const elsewhere = await searchPathInstallation(tx, options);
		if (elsewhere !== null && elsewhere !== tables.schema) {
			throw new MnemocyteError({
				message: `schemaName is "${tables.schema}", which has no Mnemocyte tables, but this connection already finds them in the "${elsewhere}" schema. migrate() does not move an installation: move the tables first as the Postgres guide shows (ALTER TABLE … SET SCHEMA ${tables.schema}), or remove schemaName to keep using "${elsewhere}".`,
				code: "CONFIG",
				reason: "INSTALLATION_ELSEWHERE",
			});
		}
	}
	if (input.dimensions === undefined) {
		throw new MnemocyteError({
			message:
				"dimensions is required for a fresh install: it fixes the embedding column for the installation. Pass memory (the client) or dimensions.",
			code: "VALIDATION",
		});
	}
	const pgvector = await hasPgvector(tx, options);
	if (!pgvector && input.createExtension !== true) {
		throw new MnemocyteError({
			message:
				"pgvector is not installed in this database. Pass createExtension: true to have migrate() run CREATE EXTENSION vector, or have an admin run it first.",
			code: "MIGRATION",
			reason: "PGVECTOR_UNAVAILABLE",
		});
	}
	return {
		kind: "fresh",
		trackingTable,
		pgvector,
		schema:
			tables.schema === null || (await hasSchema(tx, tables.schema, options)),
		dimensions: input.dimensions,
		textSearchConfig,
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
	tables: PostgresTables,
): Promise<MigrationStep> {
	const options: SqlQueryOptions =
		input.signal === undefined ? {} : { signal: input.signal };
	const found = await inspect(tx, input, tables, options);
	const { schema } = tables;

	if (found.kind === "tracked") {
		const next = MIGRATIONS[found.versions.length];
		if (!next) {
			return { ...nothing(), done: true };
		}
		if (schema !== null) {
			await useSchema(tx, schema, options);
		}
		await runStatements(
			tx,
			next.name,
			qualifySelfReference(next.sql, schema),
			options,
		);
		await recordMigrations(tx, tables, [next], options);
		return {
			...nothing(),
			applied: [next.name],
			done: next.version + 1 === MIGRATIONS.length,
		};
	}

	if (found.kind === "untracked") {
		if (!found.trackingTable) {
			await createTrackingTable(tx, tables, options);
		}
		const adopted = await recordMigrations(
			tx,
			tables,
			MIGRATIONS.slice(0, found.installed + 1),
			options,
		);
		return {
			...nothing(),
			adopted,
			done: found.installed + 1 === MIGRATIONS.length,
		};
	}

	if (!found.schema && schema !== null) {
		await createSchema(tx, schema, options);
	}
	if (!found.trackingTable) {
		await createTrackingTable(tx, tables, options);
	}
	// Before useSchema: CREATE EXTENSION without a SCHEMA clause installs
	// into the first schema on search_path, which must not be Mnemocyte's.
	if (!found.pgvector) {
		await createVectorExtension(tx, options);
	}
	if (schema !== null) {
		await useSchema(tx, schema, options);
	}
	await runStatements(
		tx,
		"0000_initial (fresh install)",
		renderInitialSchema(found.dimensions, found.textSearchConfig, schema),
		options,
	);
	return {
		applied: await recordMigrations(tx, tables, MIGRATIONS, options),
		adopted: [],
		extensionCreated: !found.pgvector,
		schemaCreated: !found.schema,
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
	tables: PostgresTables,
): Promise<MigrateResult> {
	const options: SqlQueryOptions =
		input.signal === undefined ? {} : { signal: input.signal };
	// Must be the transaction's first statement. Any write, even one this
	// code should never send, then fails instead of changing the database.
	await tx.query("SET TRANSACTION READ ONLY", [], options);
	const found = await inspect(tx, input, tables, options);
	const names = MIGRATIONS.map((migration) => migration.name);
	switch (found.kind) {
		case "tracked":
			return { ...nothing(), applied: names.slice(found.versions.length) };
		case "untracked":
			return {
				...nothing(),
				applied: names.slice(found.installed + 1),
				adopted: names.slice(0, found.installed + 1),
			};
		case "fresh":
			return {
				applied: names,
				adopted: [],
				extensionCreated: !found.pgvector,
				schemaCreated: !found.schema,
			};
	}
}

function toMigrationError(error: unknown): MnemocyteError {
	return isMnemocyteError(error)
		? error
		: new MnemocyteError({
				message: "Postgres migration failed.",
				code: "DB",
				cause: error,
			});
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
		throw new MnemocyteError({
			message:
				"migrate needs interactive transactions (SqlExecutor.transaction), which stateless HTTP drivers such as Neon's neon() function do not have. Migrate over a Pool on the same database (from @neondatabase/serverless or pg), or run mnemocyte migrate, which opens its own connection on DATABASE_URL_UNPOOLED (Neon) or DATABASE_URL.",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
	const tables = input.tables ?? DEFAULT_TABLES;
	if (input.dryRun === true) {
		throwIfAborted(input.signal);
		try {
			return await transaction((tx) => dryRun(tx, input, tables));
		} catch (error) {
			throw toMigrationError(error);
		}
	}
	const result: MigrateResult = {
		applied: [],
		adopted: [],
		extensionCreated: false,
		schemaCreated: false,
	};
	for (;;) {
		throwIfAborted(input.signal);
		let step: MigrationStep;
		try {
			step = await transaction((tx) => migrateStep(tx, input, tables));
		} catch (error) {
			throw toMigrationError(error);
		}
		result.applied.push(...step.applied);
		result.adopted.push(...step.adopted);
		result.extensionCreated ||= step.extensionCreated;
		result.schemaCreated ||= step.schemaCreated;
		if (step.done) {
			return result;
		}
	}
}
