import type { InstallationReport } from "../db/migrations/inspect.js";
import { assertPgvectorVersion } from "../db/pgvector.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { type CliTarget, resolveTarget } from "./target.js";

const INSTALLATION_GUIDE_URL =
	"https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md#one-embedding-model-per-installation";

/** What the app is configured with, to compare with the installation. */
export interface ExpectedInstallation {
	readonly dimensions?: number;
	readonly model?: string;
}

/** `problems` fail the check; `notes` are reported and pass. */
export interface CheckVerdict {
	readonly problems: string[];
	readonly notes: string[];
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
	const problems: string[] = [];
	const notes: string[] = [];
	const { migrations, column, meta } = report;

	if (report.pgvectorVersion === null) {
		problems.push(
			"pgvector is not enabled in this database. Run mnemocyte migrate, or have an admin run CREATE EXTENSION vector.",
		);
	} else {
		try {
			assertPgvectorVersion(report.pgvectorVersion);
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}

	switch (migrations.state) {
		case "none":
			problems.push(
				"Mnemocyte's tables are not installed. Run mnemocyte migrate.",
			);
			break;
		case "invalid":
			problems.push(migrations.reason);
			break;
		default:
			if (migrations.pending.length > 0) {
				problems.push(
					`${migrations.pending.length === 1 ? "1 migration is" : `${migrations.pending.length} migrations are`} pending (${migrations.pending.join(", ")}). Run mnemocyte migrate.`,
				);
			}
			if (migrations.state === "untracked") {
				notes.push(
					"The schema was installed without migrate (psql or drizzle-kit). mnemocyte migrate records its migrations without running them again.",
				);
			}
	}

	if (
		column !== null &&
		expected.dimensions !== undefined &&
		column.dimensions !== expected.dimensions
	) {
		problems.push(
			`The installation stores ${column.dimensions}-dimension embeddings, but the embedder has ${expected.dimensions} dimensions. An installation keeps one embedding size.`,
		);
	}

	if (meta === null) {
		problems.push(
			`mnemocyte_meta has no "installation" row, so the embedder cannot be checked against this database. Insert it again as shown in ${INSTALLATION_GUIDE_URL}`,
		);
	} else if (meta !== undefined) {
		if (
			column !== null &&
			(meta.dimensions !== column.dimensions ||
				meta.vectorType !== column.vectorType)
		) {
			problems.push(
				`mnemocyte_meta records ${meta.vectorType}(${meta.dimensions}), but the embedding column is ${column.vectorType}(${column.dimensions}). Correct the installation row to match the column.`,
			);
		}
		const stored = report.storedModels ?? [];
		if (meta.model === null && stored.length > 1) {
			problems.push(
				`No embedding model is recorded and the stored memories use several. Repair them as shown in ${INSTALLATION_GUIDE_URL}`,
			);
		} else {
			// With no model recorded, the client records the one the stored
			// memories use, or its own embedder's on an empty installation.
			const model = meta.model ?? stored[0] ?? null;
			if (model === null) {
				notes.push(
					"No embedding model is recorded yet; the first add or search records the embedder's.",
				);
			} else if (expected.model !== undefined && model !== expected.model) {
				problems.push(
					`The installation's embedding model is "${model}", but the embedder's is "${expected.model}". An installation keeps one embedding model.`,
				);
			}
		}
	}

	return { problems, notes };
}

/** The report as aligned `name  value` lines. */
export function describeInstallation(report: InstallationReport): string[] {
	const { migrations, column, meta } = report;
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
	const model =
		meta === undefined || meta === null
			? "-"
			: (meta.model ?? report.storedModels?.[0] ?? "not recorded yet");
	return [
		`pgvector    ${report.pgvectorVersion ?? "not enabled"}`,
		`migrations  ${installed}`,
		`dimensions  ${column === null ? "-" : `${column.dimensions} (${column.vectorType})`}`,
		`model       ${model}`,
	];
}

/**
 * `mnemocyte check` against a resolved target: report what is installed and
 * whether the app can use it. Reads only.
 *
 * @returns Exit code 0 when everything matches, 1 on a problem.
 * @throws {CliError} With exit code 2 when the database cannot be read.
 */
export async function checkTarget(
	target: CliTarget,
	args: CliArgs,
	io: CliIo,
): Promise<number> {
	io.write(`Using ${target.label}\n`);
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
		io.write(
			"This client uses the in-memory backend; there is nothing to check.\n",
		);
		return 0;
	}

	const embedder = target.kind === "memory" ? target.embedder : undefined;
	const dimensions = args.dimensions ?? embedder?.dimensions;
	const verdict = evaluateInstallation(report, {
		...(dimensions === undefined ? {} : { dimensions }),
		...(embedder === undefined ? {} : { model: embedder.model }),
	});
	if (
		embedder !== undefined &&
		args.dimensions !== undefined &&
		args.dimensions !== embedder.dimensions
	) {
		verdict.problems.push(
			`--dimensions is ${args.dimensions}, but the embedder in ${target.label} has ${embedder.dimensions} dimensions.`,
		);
	}

	const lines = [
		...describeInstallation(report),
		"",
		...verdict.problems.map((problem) => `problem: ${problem}`),
		...verdict.notes.map((note) => `note: ${note}`),
	];
	const count = verdict.problems.length;
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
