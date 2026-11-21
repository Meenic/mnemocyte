import { isMnemocyteError } from "../errors.js";
import { migrate } from "../migrate.js";
import type { MigrateResult } from "../types.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { type MigratePlanJson, writeJson } from "./json.js";
import { type CliTarget, resolveTarget } from "./target.js";

const CREATE_EXTENSION_HELP = `have a database admin run:

  CREATE EXTENSION IF NOT EXISTS vector;

then run mnemocyte migrate again.
`;

interface RunOptions {
	readonly createExtension: boolean;
	readonly dryRun: boolean;
}

function runMigrate(
	target: CliTarget,
	args: CliArgs,
	options: RunOptions,
): Promise<MigrateResult> {
	const shared = {
		...options,
		...(args.dimensions === undefined ? {} : { dimensions: args.dimensions }),
		...(args.textSearchConfig === undefined
			? {}
			: { textSearchConfig: args.textSearchConfig }),
	};
	return target.kind === "memory"
		? migrate({ memory: target.memory, ...shared })
		: migrate({ store: target.storeConfig, ...shared });
}

function describe(
	result: MigrateResult,
	dryRun: boolean,
	schema: string | undefined,
): string {
	const lines: string[] = [];
	if (result.schemaCreated) {
		lines.push(
			`${dryRun ? "Would create" : "Created"} the schema ${schema ?? ""}.`,
		);
	}
	if (result.extensionCreated) {
		lines.push(
			dryRun
				? "Would enable pgvector (CREATE EXTENSION vector), after asking."
				: "Enabled pgvector.",
		);
	}
	if (result.adopted.length > 0) {
		lines.push(
			`${dryRun ? "Would record" : "Recorded"} as already applied: ${result.adopted.join(", ")}`,
		);
	}
	if (result.applied.length > 0) {
		lines.push(
			`${dryRun ? "Would apply" : "Applied"}: ${result.applied.join(", ")}`,
		);
	}
	if (lines.length === 0) {
		lines.push("The schema is up to date.");
	}
	return `${lines.join("\n")}\n`;
}

/**
 * What a real run would do: `migrate()` as a dry run with
 * `createExtension`, whose `extensionCreated` says whether pgvector is
 * missing.
 *
 * @throws {CliError} With exit code 2 when a fresh `DATABASE_URL` install
 * has no `--dimensions`.
 */
async function planMigrate(
	target: CliTarget,
	args: CliArgs,
): Promise<MigrateResult> {
	try {
		return await runMigrate(target, args, {
			createExtension: true,
			dryRun: true,
		});
	} catch (error) {
		if (
			target.kind === "database-url" &&
			args.dimensions === undefined &&
			isMnemocyteError(error) &&
			error.code === "VALIDATION"
		) {
			throw new CliError(
				"This database has no Mnemocyte tables yet. Pass --dimensions <n>, your embedder's vector size, to create them.",
				EXIT_USAGE,
				error,
			);
		}
		throw error;
	}
}

/** `migrate --dry-run --json`: the plan as one {@link MigratePlanJson} line. */
async function printPlanJson(
	target: CliTarget,
	args: CliArgs,
	io: CliIo,
): Promise<number> {
	const plan: MigrateResult =
		target.store.backend === "in-memory"
			? {
					applied: [],
					adopted: [],
					extensionCreated: false,
					schemaCreated: false,
				}
			: await planMigrate(target, args);
	writeJson(io, {
		command: "migrate",
		ok: true,
		dryRun: true,
		target: target.label,
		backend: target.store.backend,
		applied: plan.applied,
		adopted: plan.adopted,
		extensionCreated: plan.extensionCreated,
		schemaCreated: plan.schemaCreated,
		upToDate:
			plan.applied.length === 0 &&
			plan.adopted.length === 0 &&
			!plan.extensionCreated &&
			!plan.schemaCreated,
	} satisfies MigratePlanJson);
	return 0;
}

/**
 * `mnemocyte migrate` against a resolved target: apply what is missing.
 *
 * It first runs `migrate()` as a dry run with `createExtension`, whose
 * `extensionCreated` says whether pgvector is missing. Enabling it needs a
 * privileged role and changes the database beyond Mnemocyte's tables, so
 * the command asks first; `--yes` answers for CI. On "no", or without a
 * terminal to ask on, it prints the statement for an admin and exits 1.
 * `--json`, which comes with `--dry-run`, prints the plan as one
 * {@link MigratePlanJson} line instead of the text.
 *
 * @returns The exit code.
 */
export async function migrateTarget(
	target: CliTarget,
	args: CliArgs,
	io: CliIo,
): Promise<number> {
	if (args.json) {
		return printPlanJson(target, args, io);
	}
	io.write(`Using ${target.label}\n`);
	if (target.store.backend === "in-memory") {
		io.write(
			"This client uses the in-memory backend; there is no schema to migrate.\n",
		);
		return 0;
	}
	if (target.store.custom?.migrates === false) {
		io.write(
			`This client uses the custom store "${target.store.custom.name}", which manages its own schema; there is nothing to migrate.\n`,
		);
		return 0;
	}

	const plan = await planMigrate(target, args);
	if (args.dryRun) {
		io.write(describe(plan, true, target.store.schemaName));
		return 0;
	}

	if (plan.extensionCreated && !args.yes) {
		const answer = await io.confirm(
			"pgvector is not enabled in this database. Run CREATE EXTENSION vector now? [y/N] ",
		);
		if (answer !== true) {
			io.error(
				`${
					answer === undefined
						? "pgvector is not enabled in this database, and there is no terminal to ask on. Pass --yes to enable it, or"
						: "pgvector was not enabled. To enable it,"
				} ${CREATE_EXTENSION_HELP}`,
			);
			return 1;
		}
	}
	const result = await runMigrate(target, args, {
		createExtension: plan.extensionCreated,
		dryRun: false,
	});
	io.write(describe(result, false, target.store.schemaName));
	return 0;
}

/** `mnemocyte migrate`: resolve the target, run, close what was opened. */
export async function migrateCommand(
	args: CliArgs,
	io: CliIo,
): Promise<number> {
	const target = await resolveTarget(args, io);
	try {
		return await migrateTarget(target, args, io);
	} finally {
		await target.close();
	}
}
