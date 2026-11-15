import { isMnemocyteError } from "../errors.js";
import type { MnemocyteBackend } from "../types.js";
import { type CliIo, errorCauses } from "./io.js";

/*
 * What `--json` prints. The field names, their types and the codes are part
 * of the CLI's semver promise; `message` text is not (decision 47).
 */

/** Why `check` fails. A minor release may add codes. */
export type CheckProblemCode =
	| "PGVECTOR_MISSING"
	| "PGVECTOR_OUTDATED"
	| "NOT_INSTALLED"
	| "SCHEMA_INVALID"
	| "MIGRATIONS_PENDING"
	| "DIMENSIONS_MISMATCH"
	| "DIMENSIONS_FLAG_MISMATCH"
	| "INSTALLATION_ROW_MISSING"
	| "INSTALLATION_ROW_MISMATCH"
	| "MODEL_AMBIGUOUS"
	| "MODEL_MISMATCH";

/** What `check` reports and passes. A minor release may add codes. */
export type CheckNoteCode = "SCHEMA_UNTRACKED" | "MODEL_NOT_RECORDED";

/** One problem or note: a code to branch on and a message for people. */
export interface CheckFinding<Code extends string> {
	readonly code: Code;
	readonly message: string;
}

/** What `check --json` found in the database. */
export interface InstallationJson {
	/** `null` when pgvector is not enabled. */
	readonly pgvectorVersion: string | null;
	/** Both lists are empty when the state is `none` or `invalid`. */
	readonly migrations: {
		readonly state: "none" | "tracked" | "untracked" | "invalid";
		readonly applied: readonly string[];
		readonly pending: readonly string[];
	};
	/** `null` without a memories table. */
	readonly dimensions: number | null;
	/** `vector` or `halfvec`; `null` without a memories table. */
	readonly vectorType: string | null;
	/** `null` when none is recorded or the installation row was not read. */
	readonly model: string | null;
}

interface JsonBase {
	/** The memory file, relative to the working directory, or `DATABASE_URL`. */
	readonly target: string;
	readonly backend: MnemocyteBackend;
}

/** `mnemocyte check --json`. */
export interface CheckJson extends JsonBase {
	readonly command: "check";
	/** True when there is no problem; the exit code is 0 exactly then. */
	readonly ok: boolean;
	/** `null` on the in-memory backend, which has nothing to check. */
	readonly installation: InstallationJson | null;
	readonly problems: readonly CheckFinding<CheckProblemCode>[];
	readonly notes: readonly CheckFinding<CheckNoteCode>[];
}

/** `mnemocyte migrate --dry-run --json`: `migrate()`'s dry-run result. */
export interface MigratePlanJson extends JsonBase {
	readonly command: "migrate";
	readonly ok: true;
	readonly dryRun: true;
	/** Migrations a real run would apply. */
	readonly applied: readonly string[];
	/** Migrations a real run would record as already applied. */
	readonly adopted: readonly string[];
	/** True when a real run would ask to run `CREATE EXTENSION vector`. */
	readonly extensionCreated: boolean;
	/** True when a real run would change nothing. */
	readonly upToDate: boolean;
}

/** Any `--json` command that failed after its command line was read. */
export interface ErrorJson {
	readonly command: "check" | "migrate";
	readonly ok: false;
	readonly error: {
		readonly message: string;
		/** `code` and `reason` of the first `MnemocyteError` in the chain. */
		readonly code?: string;
		readonly reason?: string;
		/** The `cause` messages, outermost first. */
		readonly causes: readonly string[];
	};
}

/**
 * Print one result as a single line. It is the last thing on standard
 * output, so a reader can take the last line even when the app's memory
 * file printed something while it loaded.
 */
export function writeJson(
	io: CliIo,
	value: CheckJson | MigratePlanJson | ErrorJson,
): void {
	io.write(`${JSON.stringify(value)}\n`);
}

/** How many `cause` links are searched for a `MnemocyteError`. */
const MAX_CODE_DEPTH = 4;

/** The {@link ErrorJson} for an error a `--json` command failed with. */
export function errorJson(
	command: ErrorJson["command"],
	error: unknown,
): ErrorJson {
	let coded: unknown = error;
	for (
		let depth = 0;
		depth < MAX_CODE_DEPTH && coded != null && !isMnemocyteError(coded);
		depth += 1
	) {
		coded = coded instanceof Error ? coded.cause : undefined;
	}
	return {
		command,
		ok: false,
		error: {
			message: error instanceof Error ? error.message : String(error),
			...(isMnemocyteError(coded)
				? {
						code: coded.code,
						...(coded.reason === undefined ? {} : { reason: coded.reason }),
					}
				: {}),
			causes: errorCauses(error),
		},
	};
}
