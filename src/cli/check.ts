import type { InstallationReport } from "../db/migrations/inspect.js";
import { assertPgvectorVersion } from "../db/pgvector.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import {
	type CheckFinding,
	type CheckJson,
	type CheckNoteCode,
	type CheckProblemCode,
	type InstallationJson,
	writeJson,
} from "./json.js";
import { type CliTarget, resolveTarget } from "./target.js";

const INSTALLATION_GUIDE_URL =
	"https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md#one-embedding-model-per-installation";

/** What the app is configured with, to compare with the installation. */
export interface ExpectedInstallation {
	readonly dimensions?: number;
	/**
	 * Where `dimensions` came from, for the message: the `--dimensions` flag
	 * or the memory file's embedder. @defaultValue `"embedder"`
	 */
	readonly dimensionsFrom?: "flag" | "embedder";
	readonly model?: string;
	/** `--text-search-config`. */
	readonly textSearchConfig?: string;
}

/**
 * A configuration name as Postgres would resolve it for comparison: an
 * unquoted name folds to lower case, and `pg_catalog.`, where the built-in
 * configurations live and which is always on `search_path`, is dropped.
 * `check` reads only, so it compares names rather than asking the server.
 */
export function normalizeTextSearchConfig(name: string): string {
	const folded = name.includes('"') ? name : name.toLowerCase();
	return folded.startsWith("pg_catalog.")
		? folded.slice("pg_catalog.".length)
		: folded;
}

/** `problems` fail the check; `notes` are reported and pass. */
export interface CheckVerdict {
	readonly problems: CheckFinding<CheckProblemCode>[];
	readonly notes: CheckFinding<CheckNoteCode>[];
}

/**
 * Judge an installation report. A problem is anything that makes the app
 * throw: a missing or old pgvector, missing tables, pending migrations, a
 * schema `migrate()` refuses, or an installation whose dimensions or
 * embedding model differ from the app's.
 */
export function evaluateInstallation(
	report: InstallationReport,
	expected: ExpectedInstallation,
): CheckVerdict {
	const problems: CheckFinding<CheckProblemCode>[] = [];
	const notes: CheckFinding<CheckNoteCode>[] = [];
	const problem = (code: CheckProblemCode, message: string): void => {
		problems.push({ code, message });
	};
	const note = (code: CheckNoteCode, message: string): void => {
		notes.push({ code, message });
	};
	const { migrations, column, meta } = report;

	if (report.pgvectorVersion === null) {
		problem(
			"PGVECTOR_MISSING",
			"pgvector is not enabled in this database. Run mnemocyte migrate, or have an admin run CREATE EXTENSION vector.",
		);
	} else {
		try {
			assertPgvectorVersion(report.pgvectorVersion);
		} catch (error) {
			problem(
				"PGVECTOR_OUTDATED",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	switch (migrations.state) {
		case "none":
			problem(
				"NOT_INSTALLED",
				"Mnemocyte's tables are not installed. Run mnemocyte migrate.",
			);
			break;
		case "invalid":
			problem("SCHEMA_INVALID", migrations.reason);
			break;
		default:
			if (migrations.pending.length > 0) {
				problem(
					"MIGRATIONS_PENDING",
					`${migrations.pending.length === 1 ? "1 migration is" : `${migrations.pending.length} migrations are`} pending (${migrations.pending.join(", ")}). Run mnemocyte migrate.`,
				);
			}
			if (migrations.state === "untracked") {
				note(
					"SCHEMA_UNTRACKED",
					"The schema was installed without migrate (psql or drizzle-kit). mnemocyte migrate records its migrations without running them again.",
				);
			}
	}

	if (
		column !== null &&
		expected.dimensions !== undefined &&
		column.dimensions !== expected.dimensions
	) {
		problem(
			"DIMENSIONS_MISMATCH",
			`The installation stores ${column.dimensions}-dimension embeddings, but ${expected.dimensionsFrom === "flag" ? `--dimensions is ${expected.dimensions}` : `the embedder has ${expected.dimensions} dimensions`}. An installation keeps one embedding size.`,
		);
	}

	if (meta === null) {
		problem(
			"INSTALLATION_ROW_MISSING",
			`mnemocyte_meta has no "installation" row, so the embedder cannot be checked against this database. Insert it again as shown in ${INSTALLATION_GUIDE_URL}`,
		);
	} else if (meta !== undefined) {
		if (
			column !== null &&
			(meta.dimensions !== column.dimensions ||
				meta.vectorType !== column.vectorType)
		) {
			problem(
				"INSTALLATION_ROW_MISMATCH",
				`mnemocyte_meta records ${meta.vectorType}(${meta.dimensions}), but the embedding column is ${column.vectorType}(${column.dimensions}). Correct the installation row to match the column.`,
			);
		}
		const stored = report.storedModels ?? [];
		if (meta.model === null && stored.length > 1) {
			problem(
				"MODEL_AMBIGUOUS",
				`No embedding model is recorded and the stored memories use several. Repair them as shown in ${INSTALLATION_GUIDE_URL}`,
			);
		} else {
			// With no model recorded, the client records the one the stored
			// memories use, or its own embedder's on an empty installation.
			const model = installedModel(report) ?? null;
			if (model === null) {
				note(
					"MODEL_NOT_RECORDED",
					"No embedding model is recorded yet; the first add or search records the embedder's.",
				);
			} else if (expected.model !== undefined && model !== expected.model) {
				problem(
					"MODEL_MISMATCH",
					`The installation's embedding model is "${model}", but the embedder's is "${expected.model}". An installation keeps one embedding model.`,
				);
			}
		}
	}

	if (
		report.textSearchConfig !== undefined &&
		expected.textSearchConfig !== undefined &&
		normalizeTextSearchConfig(report.textSearchConfig) !==
			normalizeTextSearchConfig(expected.textSearchConfig)
	) {
		problem(
			"TEXT_SEARCH_CONFIG_MISMATCH",
			`Keyword search uses the "${report.textSearchConfig}" text search configuration, but --text-search-config is "${expected.textSearchConfig}". mnemocyte text-search ${expected.textSearchConfig} changes it and rewrites the memories table.`,
		);
	}

	return { problems, notes };
}

/**
 * The embedding model the client compares with: the recorded one, else the
 * first one the stored memories use. `undefined` when the installation row
 * was not read or is missing, `null` when no model is recorded yet.
 */
function installedModel(report: InstallationReport): string | null | undefined {
	const { meta } = report;
	if (meta === undefined || meta === null) {
		return undefined;
	}
	return meta.model ?? report.storedModels?.[0] ?? null;
}

/**
 * The report as `check --json` prints it. `migrations` always has both
 * lists, empty when nothing is installed or the schema is one `migrate()`
 * refuses, so a reader never has to test for them.
 */
export function installationJson(report: InstallationReport): InstallationJson {
	const { migrations, column } = report;
	return {
		pgvectorVersion: report.pgvectorVersion,
		migrations:
			migrations.state === "none" || migrations.state === "invalid"
				? { state: migrations.state, applied: [], pending: [] }
				: {
						state: migrations.state,
						applied: [...migrations.applied],
						pending: [...migrations.pending],
					},
		dimensions: column?.dimensions ?? null,
		vectorType: column?.vectorType ?? null,
		model: installedModel(report) ?? null,
		textSearchConfig: report.textSearchConfig ?? null,
	};
}

/** The report as aligned `name  value` lines. */
export function describeInstallation(report: InstallationReport): string[] {
	const { migrations, column } = report;
	let installed: string;
	switch (migrations.state) {
		case "none":
			installed = "not installed";
			break;
		case "invalid":
			installed = "invalid";
			break;
		default: {
			const total = migrations.applied.length + migrations.pending.length;
			installed = `${migrations.applied.length} of ${total} applied`;
			if (migrations.pending.length > 0) {
				installed += `, pending: ${migrations.pending.join(", ")}`;
			}
			if (migrations.state === "untracked") {
				installed += " (not recorded)";
			}
		}
	}
	const recorded = installedModel(report);
	const model = recorded === undefined ? "-" : (recorded ?? "not recorded yet");
	return [
		`pgvector    ${report.pgvectorVersion ?? "not enabled"}`,
		`migrations  ${installed}`,
		`dimensions  ${column === null ? "-" : `${column.dimensions} (${column.vectorType})`}`,
		`model       ${model}`,
		`text search ${report.textSearchConfig ?? "-"}`,
	];
}

/**
 * `mnemocyte check` against a resolved target: report what is installed and
 * whether the app can use it. Reads only. With `--json` it prints one
 * {@link CheckJson} line instead of the text.
 *
 * @returns Exit code 0 when everything matches, 1 on a problem.
 * @throws {CliError} With exit code 2 when the database cannot be read.
 */
export async function checkTarget(
	target: CliTarget,
	args: CliArgs,
	io: CliIo,
): Promise<number> {
	if (!args.json) {
		io.write(`Using ${target.label}\n`);
	}
	let report: InstallationReport | null;
	try {
		report = await target.store.inspectInstallation();
	} catch (error) {
		throw new CliError(
			"Could not read the database, so nothing was checked.",
			EXIT_USAGE,
			error,
		);
	}
	if (report === null) {
		if (args.json) {
			writeJson(io, {
				command: "check",
				ok: true,
				target: target.label,
				backend: target.store.backend,
				installation: null,
				problems: [],
				notes: [],
			} satisfies CheckJson);
		} else {
			io.write(
				"This client uses the in-memory backend; there is nothing to check.\n",
			);
		}
		return 0;
	}

	const embedder = target.kind === "memory" ? target.embedder : undefined;
	const dimensions = args.dimensions ?? embedder?.dimensions;
	const verdict = evaluateInstallation(report, {
		...(dimensions === undefined ? {} : { dimensions }),
		dimensionsFrom: args.dimensions === undefined ? "embedder" : "flag",
		...(embedder === undefined ? {} : { model: embedder.model }),
		...(args.textSearchConfig === undefined
			? {}
			: { textSearchConfig: args.textSearchConfig }),
	});
	if (
		embedder !== undefined &&
		args.dimensions !== undefined &&
		args.dimensions !== embedder.dimensions
	) {
		verdict.problems.push({
			code: "DIMENSIONS_FLAG_MISMATCH",
			message: `--dimensions is ${args.dimensions}, but the embedder in ${target.label} has ${embedder.dimensions} dimensions.`,
		});
	}

	const count = verdict.problems.length;
	if (args.json) {
		writeJson(io, {
			command: "check",
			ok: count === 0,
			target: target.label,
			backend: target.store.backend,
			installation: installationJson(report),
			problems: verdict.problems,
			notes: verdict.notes,
		} satisfies CheckJson);
		return count === 0 ? 0 : 1;
	}

	const lines = [
		...describeInstallation(report),
		"",
		...verdict.problems.map((problem) => `problem: ${problem.message}`),
		...verdict.notes.map((note) => `note: ${note.message}`),
	];
	lines.push(
		count === 0
			? "ok"
			: `${count === 1 ? "1 problem" : `${count} problems`} found`,
	);
	io.write(`${lines.join("\n")}\n`);
	return count === 0 ? 0 : 1;
}

/** `mnemocyte check`: resolve the target, run, close what was opened. */
export async function checkCommand(args: CliArgs, io: CliIo): Promise<number> {
	const target = await resolveTarget(args, io);
	try {
		return await checkTarget(target, args, io);
	} finally {
		await target.close();
	}
}
