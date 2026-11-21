import { isMnemocyteError, MnemocyteError } from "../../errors.js";
import type {
	StoreMigrateInput,
	StoreTextSearchConfigInput,
} from "../../memory/store.js";
import { throwIfAborted } from "../../resilience.js";
import type { MigrateResult, TextSearchConfigResult } from "../../types.js";
import type {
	InstallationReport,
	InstalledMigrations,
} from "../migrations/inspect.js";
import {
	LIBSQL_INITIAL_MIGRATION_NAME,
	LIBSQL_MIGRATIONS,
	LIBSQL_SCHEMA_TEMPLATE,
} from "./bundled.js";
import type {
	LibsqlExecutor,
	LibsqlStatement,
	LibsqlTransactionExecutor,
} from "./executor.js";
import { LIBSQL_TABLES, toNumber } from "./sql.js";

/**
 * The keyword search tokenizers a libSQL installation can use, by the name
 * `textSearchConfig` takes. `porter` stems English words, as Postgres's
 * default `english` configuration does; `unicode61` only folds case and
 * removes diacritics, for memories in other languages. FTS5 has no stop
 * words in either.
 */
export const LIBSQL_TOKENIZERS = {
	porter: "porter unicode61 remove_diacritics 2",
	unicode61: "unicode61 remove_diacritics 2",
} as const;

export type LibsqlTextSearchConfig = keyof typeof LIBSQL_TOKENIZERS;

export const DEFAULT_LIBSQL_TEXT_SEARCH_CONFIG: LibsqlTextSearchConfig =
	"porter";

/** The largest vector libSQL operates on. */
export const LIBSQL_MAX_DIMENSIONS = 65_536;

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

/** Every migration name, 0000 first. */
const MIGRATION_NAMES: readonly string[] = [
	LIBSQL_INITIAL_MIGRATION_NAME,
	...LIBSQL_MIGRATIONS.map((migration) => migration.name),
];

function isTextSearchConfig(value: string): value is LibsqlTextSearchConfig {
	return Object.hasOwn(LIBSQL_TOKENIZERS, value);
}

/**
 * The tokenizer for a `textSearchConfig` name.
 *
 * @throws {MnemocyteError} `"VALIDATION"` for any other name.
 */
export function libsqlTextSearchConfig(name: string): LibsqlTextSearchConfig {
	if (!isTextSearchConfig(name)) {
		throw new MnemocyteError({
			message: `textSearchConfig must be "porter" or "unicode61" on libSQL (FTS5 tokenizers); got ${JSON.stringify(name)}.`,
			code: "VALIDATION",
		});
	}
	return name;
}

/** The fresh-install statements for these dimensions and tokenizer. */
export function renderLibsqlSchema(
	dimensions: number,
	textSearchConfig: LibsqlTextSearchConfig,
): string[] {
	return splitStatements(
		LIBSQL_SCHEMA_TEMPLATE.replaceAll(
			"{{EMBEDDING_DIMENSIONS}}",
			String(dimensions),
		).replaceAll("{{FTS_TOKENIZE}}", LIBSQL_TOKENIZERS[textSearchConfig]),
	);
}

function splitStatements(sql: string): string[] {
	return sql
		.split(STATEMENT_BREAKPOINT)
		.map((statement) => statement.trim())
		.filter((statement) => statement !== "");
}

function statement(sql: string, args: LibsqlStatement["args"] = []) {
	return { sql, args };
}

type Reader = Pick<LibsqlTransactionExecutor, "execute">;

async function tableExists(
	db: Reader,
	name: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const rows = await db.execute(
		statement(
			"SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?1",
			[name],
		),
		signal,
	);
	return rows.length > 0;
}

const FTS_TOKENIZE_PATTERN = /tokenize\s*=\s*'([^']*)'/i;

/** What the keyword index was built with, read from its `CREATE` text. */
export type InstalledTokenizer =
	| { readonly kind: "config"; readonly name: LibsqlTextSearchConfig }
	| { readonly kind: "missing" }
	| { readonly kind: "unrecognized"; readonly tokenize: string };

export async function readLibsqlTokenizer(
	db: Reader,
	signal?: AbortSignal,
): Promise<InstalledTokenizer> {
	const rows = await db.execute(
		statement(
			"SELECT sql AS sql FROM sqlite_master WHERE type = 'table' AND name = 'mnemocyte_memories_fts'",
		),
		signal,
	);
	const sql = rows[0]?.sql;
	if (typeof sql !== "string") {
		return { kind: "missing" };
	}
	const tokenize = FTS_TOKENIZE_PATTERN.exec(sql)?.[1] ?? "unicode61";
	for (const [name, value] of Object.entries(LIBSQL_TOKENIZERS)) {
		if (value === tokenize && isTextSearchConfig(name)) {
			return { kind: "config", name };
		}
	}
	return { kind: "unrecognized", tokenize };
}

export function unrecognizedTokenizerError(tokenize: string): MnemocyteError {
	return new MnemocyteError({
		message: `mnemocyte_memories_fts uses the FTS5 tokenizer "${tokenize}", which Mnemocyte did not install. Recreate it with setTextSearchConfig() (textSearchConfig "porter" or "unicode61").`,
		code: "MIGRATION",
		reason: "SCHEMA_UNRECOGNIZED",
	});
}

interface LibsqlInstallation {
	readonly migrations: InstalledMigrations;
	readonly dimensions: number | null;
	readonly vectorType: string | null;
	readonly model: string | null;
	readonly metaFound: boolean;
}

/**
 * Which migrations are recorded, read without a lock. Every installation is
 * created by `migrate()`, which records its migrations in the same
 * transaction, so tables without records match nothing it installed.
 */
async function readInstallation(
	db: Reader,
	signal?: AbortSignal,
): Promise<LibsqlInstallation> {
	const hasMemories = await tableExists(db, "mnemocyte_memories", signal);
	const hasTracking = await tableExists(db, "mnemocyte_migrations", signal);
	const versions = hasTracking
		? (
				await db.execute(
					statement(
						`SELECT version AS version FROM ${LIBSQL_TABLES.migrations} ORDER BY version`,
					),
					signal,
				)
			).map((row) => toNumber(row.version))
		: [];
	const empty = {
		dimensions: null,
		vectorType: null,
		model: null,
		metaFound: false,
	};
	if (versions.length === 0) {
		return {
			...empty,
			migrations: hasMemories
				? {
						state: "invalid",
						reason:
							"Mnemocyte's libSQL tables exist, but mnemocyte_migrations records none of them. A libSQL installation is created only by migrate(); drop the mnemocyte_* tables and run it again, or restore the mnemocyte_migrations rows.",
					}
				: { state: "none" },
		};
	}
	const contiguous = versions.every((version, index) => version === index);
	if (!contiguous) {
		return {
			...empty,
			migrations: {
				state: "invalid",
				reason: `mnemocyte_migrations records versions ${versions.join(", ")}, which have a gap.`,
			},
		};
	}
	if (versions.length > MIGRATION_NAMES.length) {
		return {
			...empty,
			migrations: {
				state: "invalid",
				reason: `mnemocyte_migrations records ${versions.length} migrations, but this version of Mnemocyte knows ${MIGRATION_NAMES.length}: a newer Mnemocyte migrated the database. Upgrade mnemocyte.`,
			},
		};
	}
	const metaRows = await db.execute(
		statement(
			`SELECT embedding_dimensions AS "dimensions", embedding_model AS "model", vector_type AS "vectorType" FROM ${LIBSQL_TABLES.meta} WHERE key = 'installation'`,
		),
		signal,
	);
	const meta = metaRows[0];
	return {
		migrations: {
			state: "tracked",
			applied: MIGRATION_NAMES.slice(0, versions.length),
			pending: MIGRATION_NAMES.slice(versions.length),
		},
		dimensions: meta === undefined ? null : toNumber(meta.dimensions),
		vectorType:
			meta === undefined || meta.vectorType === null
				? null
				: String(meta.vectorType),
		model:
			meta === undefined || meta.model === null || meta.model === undefined
				? null
				: String(meta.model),
		metaFound: meta !== undefined,
	};
}

function invalidSchemaError(reason: string): MnemocyteError {
	return new MnemocyteError({
		message: reason,
		code: "MIGRATION",
		reason: reason.includes("newer Mnemocyte")
			? "SCHEMA_NEWER"
			: "SCHEMA_UNRECOGNIZED",
	});
}

interface MigrationPlan {
	readonly fresh: boolean;
	readonly pending: readonly string[];
	readonly textSearchConfig: LibsqlTextSearchConfig;
	readonly dimensions?: number;
}

/**
 * What a run has to do, and the errors it raises before its first change,
 * so a dry run raises them too.
 */
async function plan(
	db: Reader,
	input: StoreMigrateInput,
): Promise<MigrationPlan> {
	const requested =
		input.textSearchConfig === undefined
			? undefined
			: libsqlTextSearchConfig(input.textSearchConfig);
	const installation = await readInstallation(db, input.signal);
	const { migrations } = installation;
	if (migrations.state === "invalid") {
		throw invalidSchemaError(migrations.reason);
	}
	if (migrations.state === "none") {
		if (input.dimensions === undefined) {
			throw new MnemocyteError({
				message:
					"migrate() needs dimensions to install Mnemocyte in an empty libSQL database: pass { memory } or { store, dimensions }.",
				code: "VALIDATION",
			});
		}
		return {
			fresh: true,
			pending: MIGRATION_NAMES,
			textSearchConfig: requested ?? DEFAULT_LIBSQL_TEXT_SEARCH_CONFIG,
			dimensions: input.dimensions,
		};
	}
	if (
		input.dimensions !== undefined &&
		installation.dimensions !== null &&
		installation.dimensions !== input.dimensions
	) {
		throw new MnemocyteError({
			message: `The installation stores ${installation.dimensions}-dimension embeddings; migrate() was called with dimensions ${input.dimensions}.`,
			code: "CONFIG",
			reason: "DIMENSIONS_MISMATCH",
		});
	}
	const tokenizer = await readLibsqlTokenizer(db, input.signal);
	if (tokenizer.kind === "unrecognized") {
		throw unrecognizedTokenizerError(tokenizer.tokenize);
	}
	const installed =
		tokenizer.kind === "config"
			? tokenizer.name
			: DEFAULT_LIBSQL_TEXT_SEARCH_CONFIG;
	if (requested !== undefined && requested !== installed) {
		throw new MnemocyteError({
			message: `The installation's keyword search uses the "${installed}" tokenizer; migrate() was called with textSearchConfig "${requested}". migrate() sets it only on a fresh install. Change it with setTextSearchConfig() or mnemocyte text-search ${requested}, which rebuilds the keyword index.`,
			code: "CONFIG",
			reason: "TEXT_SEARCH_CONFIG_MISMATCH",
		});
	}
	return {
		fresh: false,
		pending: migrations.pending,
		textSearchConfig: installed,
	};
}

function emptyResult(applied: string[]): MigrateResult {
	return {
		applied,
		adopted: [],
		extensionCreated: false,
		schemaCreated: false,
	};
}

function toMigrationError(error: unknown, migration?: string): MnemocyteError {
	if (isMnemocyteError(error)) {
		return error;
	}
	if (migration === undefined) {
		return new MnemocyteError({
			message: "Could not read the libSQL installation.",
			code: "DB",
			cause: error,
		});
	}
	return new MnemocyteError({
		message: `Migration ${migration} failed and was rolled back.`,
		code: "MIGRATION",
		reason: "MIGRATION_FAILED",
		cause: error,
	});
}

/**
 * Apply what is missing, in one `BEGIN IMMEDIATE` transaction: the write
 * lock makes a concurrent `migrate` wait or fail with `SQLITE_BUSY` instead
 * of installing twice, and SQLite's schema changes are transactional, so a
 * failed migration leaves nothing behind. A fresh install renders the
 * template (the final schema) and records every migration. `createExtension`
 * does not apply: libSQL has vectors and FTS5 built in.
 */
export async function runLibsqlMigrations(
	db: LibsqlExecutor,
	input: StoreMigrateInput,
): Promise<MigrateResult> {
	throwIfAborted(input.signal);
	if (input.dryRun === true) {
		try {
			const found = await plan(db, input);
			return emptyResult([...found.pending]);
		} catch (error) {
			throw toMigrationError(error);
		}
	}
	let current: string | undefined;
	try {
		return await db.transaction("write", async (tx) => {
			const found = await plan(tx, input);
			const now = Date.now();
			if (found.fresh) {
				current = LIBSQL_INITIAL_MIGRATION_NAME;
				for (const sql of renderLibsqlSchema(
					found.dimensions ?? 0,
					found.textSearchConfig,
				)) {
					await tx.execute(statement(sql), input.signal);
				}
				await tx.execute(
					statement(
						`CREATE TABLE IF NOT EXISTS ${LIBSQL_TABLES.migrations} ("version" integer PRIMARY KEY NOT NULL, "name" text NOT NULL, "applied_at" integer NOT NULL)`,
					),
					input.signal,
				);
				for (const [version, name] of MIGRATION_NAMES.entries()) {
					await tx.execute(
						statement(
							`INSERT INTO ${LIBSQL_TABLES.migrations} (version, name, applied_at) VALUES (?1, ?2, ?3)`,
							[version, name, now],
						),
						input.signal,
					);
				}
				return emptyResult([...MIGRATION_NAMES]);
			}
			for (const name of found.pending) {
				current = name;
				const migration = LIBSQL_MIGRATIONS.find(
					(candidate) => candidate.name === name,
				);
				if (migration === undefined) {
					continue;
				}
				for (const sql of splitStatements(migration.sql)) {
					await tx.execute(statement(sql), input.signal);
				}
				await tx.execute(
					statement(
						`INSERT INTO ${LIBSQL_TABLES.migrations} (version, name, applied_at) VALUES (?1, ?2, ?3)`,
						[migration.version, migration.name, now],
					),
					input.signal,
				);
			}
			return emptyResult([...found.pending]);
		});
	} catch (error) {
		throw toMigrationError(error, current);
	}
}

/**
 * What is installed, for `mnemocyte check`. Facts only; reads without a
 * transaction.
 */
export async function inspectLibsqlInstallation(
	db: LibsqlExecutor,
	signal?: AbortSignal,
): Promise<InstallationReport> {
	throwIfAborted(signal);
	const versionRows = await db.execute(
		statement("SELECT sqlite_version() AS version"),
		signal,
	);
	const installation = await readInstallation(db, signal);
	const tracked =
		installation.migrations.state === "tracked" ||
		installation.migrations.state === "untracked";
	const pending = tracked
		? (installation.migrations as { pending: readonly string[] }).pending
		: [];
	const current = tracked && pending.length === 0;
	const tokenizer = current ? await readLibsqlTokenizer(db, signal) : undefined;
	const storedModels =
		current && installation.metaFound && installation.model === null
			? (
					await db.execute(
						statement(
							`SELECT DISTINCT embedding_model AS "model" FROM ${LIBSQL_TABLES.memories} LIMIT 2`,
						),
						signal,
					)
				).map((row) => String(row.model))
			: undefined;
	return {
		schema: null,
		pgvectorVersion: null,
		sqliteVersion: String(versionRows[0]?.version ?? ""),
		migrations: installation.migrations,
		column:
			installation.dimensions === null
				? null
				: {
						dimensions: installation.dimensions,
						vectorType: installation.vectorType ?? "F32_BLOB",
					},
		...(current
			? {
					meta: installation.metaFound
						? {
								dimensions: installation.dimensions ?? 0,
								model: installation.model,
								vectorType: installation.vectorType ?? "F32_BLOB",
							}
						: null,
				}
			: {}),
		...(storedModels === undefined ? {} : { storedModels }),
		...(tokenizer?.kind === "config"
			? { textSearchConfig: tokenizer.name }
			: tokenizer?.kind === "unrecognized"
				? { textSearchConfig: tokenizer.tokenize }
				: {}),
	};
}

/**
 * Rebuild the keyword index with another tokenizer, in one write batch:
 * drop the FTS5 table and its triggers, create them again, then `'rebuild'`
 * reads every memory's content. Memory rows are not rewritten, so the vector
 * column and its data stay as they are. Other clients keep their keyword
 * queries working: FTS5 tokenizes queries with the table's own tokenizer.
 */
export async function setLibsqlTextSearchConfig(
	db: LibsqlExecutor,
	input: StoreTextSearchConfigInput,
): Promise<TextSearchConfigResult> {
	throwIfAborted(input.signal);
	const requested = libsqlTextSearchConfig(input.textSearchConfig);
	let installation: LibsqlInstallation;
	let tokenizer: InstalledTokenizer;
	try {
		installation = await readInstallation(db, input.signal);
		tokenizer = await readLibsqlTokenizer(db, input.signal);
	} catch (error) {
		throw toMigrationError(error);
	}
	const { migrations } = installation;
	if (migrations.state === "invalid") {
		throw invalidSchemaError(migrations.reason);
	}
	if (
		migrations.state === "none" ||
		(migrations.state === "tracked" && migrations.pending.length > 0) ||
		tokenizer.kind === "missing"
	) {
		throw new MnemocyteError({
			message:
				"setTextSearchConfig needs every migration applied. Run mnemocyte migrate first.",
			code: "MIGRATION",
			reason: "SCHEMA_MISSING",
		});
	}
	const previous =
		tokenizer.kind === "config" ? tokenizer.name : tokenizer.tokenize;
	if (previous === requested) {
		return { previous, current: requested, changed: false };
	}
	if (input.dryRun === true) {
		return { previous, current: requested, changed: true };
	}
	const statements = renderLibsqlSchema(1, requested).filter((sql) =>
		/^CREATE (VIRTUAL TABLE|TRIGGER) "mnemocyte_memories_fts/.test(sql),
	);
	try {
		await db.batch(
			[
				statement('DROP TRIGGER IF EXISTS "mnemocyte_memories_fts_insert"'),
				statement('DROP TRIGGER IF EXISTS "mnemocyte_memories_fts_delete"'),
				statement('DROP TRIGGER IF EXISTS "mnemocyte_memories_fts_update"'),
				statement(`DROP TABLE IF EXISTS ${LIBSQL_TABLES.fts}`),
				...statements.map((sql) => statement(sql)),
				statement(
					`INSERT INTO ${LIBSQL_TABLES.fts} (${LIBSQL_TABLES.fts}) VALUES ('rebuild')`,
				),
			],
			"write",
			input.signal,
		);
	} catch (error) {
		throw new MnemocyteError({
			message:
				"Changing the keyword search tokenizer failed and was rolled back.",
			code: "MIGRATION",
			reason: "MIGRATION_FAILED",
			cause: error,
		});
	}
	return { previous, current: requested, changed: true };
}
