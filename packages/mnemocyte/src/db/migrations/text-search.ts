import { isMnemocyteError, MnemocyteError } from "../../errors.js";
import { throwIfAborted } from "../../resilience.js";
import type { SqlExecutor, SqlQueryOptions } from "../../sql/executor.js";
import type { TextSearchConfigResult } from "../../types.js";
import { DEFAULT_TABLES, type PostgresTables } from "../tables.js";
import {
	changeTextSearchStatements,
	readInstalledTextSearchConfig,
	resolveTextSearchConfig,
	unrecognizedTextSearchError,
} from "../text-search.js";
import { MIGRATIONS } from "./bundled.js";
import {
	assertContiguous,
	installedVersion,
	MIGRATION_LOCK_KEY,
	readAppliedVersions,
	readCatalogState,
} from "./runner.js";

export interface TextSearchChangeInput {
	/** Where the tables live. @defaultValue {@link DEFAULT_TABLES} */
	readonly tables?: PostgresTables;
	readonly textSearchConfig: string;
	readonly dryRun?: boolean;
	readonly signal?: AbortSignal;
}

const MIGRATE_FIRST =
	"Run mnemocyte migrate first; the text search configuration can change only on an up-to-date schema.";

/**
 * Throw unless every bundled migration is in the database, tracked or not.
 * The change rewrites the column `0003` creates, and a later migration may
 * depend on the table as the bundled template has it.
 */
async function assertCurrentSchema(
	tx: SqlExecutor,
	tables: PostgresTables,
	options: SqlQueryOptions,
): Promise<void> {
	const versions = await readAppliedVersions(tx, options, tables);
	let applied: number;
	if (versions !== null && versions.length > 0) {
		assertContiguous(versions);
		applied = versions.length;
	} else {
		applied = installedVersion(await readCatalogState(tx, options, tables)) + 1;
	}
	if (applied === 0) {
		throw new MnemocyteError({
			message: `Mnemocyte's tables are not installed in this database. ${MIGRATE_FIRST} A fresh install takes textSearchConfig directly.`,
			code: "MIGRATION",
			reason: "SCHEMA_MISSING",
		});
	}
	if (applied < MIGRATIONS.length) {
		throw new MnemocyteError({
			message: `${MIGRATIONS.length - applied} Mnemocyte migration${MIGRATIONS.length - applied === 1 ? " is" : "s are"} pending. ${MIGRATE_FIRST}`,
			code: "MIGRATION",
			reason: "SCHEMA_MISSING",
		});
	}
}

async function serverVersionNum(
	tx: SqlExecutor,
	options: SqlQueryOptions,
): Promise<number> {
	const rows = await tx.query<{ version: number | string }>(
		`SELECT current_setting('server_version_num')::int AS "version"`,
		[],
		options,
	);
	return Number(rows[0]?.version ?? 0);
}

async function changeStep(
	tx: SqlExecutor,
	input: TextSearchChangeInput,
): Promise<TextSearchConfigResult> {
	const tables = input.tables ?? DEFAULT_TABLES;
	const options: SqlQueryOptions =
		input.signal === undefined ? {} : { signal: input.signal };
	if (input.dryRun === true) {
		// The transaction's first statement, as in migrate's dry run.
		await tx.query("SET TRANSACTION READ ONLY", [], options);
	}
	// The migration lock: a concurrent migrate() waits, and so does a second
	// change, which then finds the configuration already set.
	await tx.query(
		`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`,
		[],
		options,
	);
	await assertCurrentSchema(tx, tables, options);
	const installed = await readInstalledTextSearchConfig(tx, options, tables);
	if (installed.kind === "missing") {
		throw new MnemocyteError({
			message:
				"mnemocyte_memories.content_tsv is missing, though every migration is recorded. Compare the schema with migrations/ and restore it.",
			code: "MIGRATION",
			reason: "SCHEMA_UNRECOGNIZED",
		});
	}
	if (installed.kind === "unrecognized") {
		throw unrecognizedTextSearchError(installed.expression);
	}
	const requested = await resolveTextSearchConfig(
		tx,
		input.textSearchConfig,
		installed.name,
		options,
	);
	if (requested.same) {
		return {
			previous: installed.name,
			current: installed.name,
			changed: false,
		};
	}
	if (input.dryRun !== true) {
		const statements = changeTextSearchStatements(
			requested.name,
			await serverVersionNum(tx, options),
			tables,
		);
		try {
			for (const statement of statements) {
				await tx.query(statement, [], options);
			}
		} catch (error) {
			if (isMnemocyteError(error)) {
				throw error;
			}
			throw new MnemocyteError({
				message: `Changing the text search configuration to "${requested.name}" failed and was rolled back.`,
				code: "MIGRATION",
				reason: "MIGRATION_FAILED",
				cause: error,
			});
		}
	}
	return { previous: installed.name, current: requested.name, changed: true };
}

/**
 * Give `content_tsv` another text search configuration, in one transaction
 * under the migration advisory lock: the column's expression changes, which
 * rewrites `mnemocyte_memories` and rebuilds every index on it. With
 * `dryRun`, one read-only transaction reports what would change.
 */
export async function setPostgresTextSearchConfig(
	db: SqlExecutor,
	input: TextSearchChangeInput,
): Promise<TextSearchConfigResult> {
	const transaction = db.transaction?.bind(db);
	if (transaction === undefined) {
		throw new MnemocyteError({
			message:
				"setTextSearchConfig needs interactive transactions (SqlExecutor.transaction), which stateless HTTP drivers such as Neon's neon() function do not have. Run it over a Pool on the same database (from @neondatabase/serverless or pg), or run mnemocyte text-search on DATABASE_URL without a memory file.",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
	throwIfAborted(input.signal);
	try {
		return await transaction((tx) => changeStep(tx, input));
	} catch (error) {
		throw isMnemocyteError(error)
			? error
			: new MnemocyteError({
					message: "Changing the text search configuration failed.",
					code: "DB",
					cause: error,
				});
	}
}
