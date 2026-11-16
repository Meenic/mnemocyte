import { setTextSearchConfig } from "../migrate.js";
import type { TextSearchConfigResult } from "../types.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { type TextSearchPlanJson, writeJson } from "./json.js";
import { type CliTarget, resolveTarget } from "./target.js";

const REWRITE_WARNING =
	"This rewrites the memories table and rebuilds every index on it, the HNSW index included. Reads and writes of memories wait until it finishes, which can take minutes on a large installation.";

function run(
	target: CliTarget,
	textSearchConfig: string,
	dryRun: boolean,
): Promise<TextSearchConfigResult> {
	return target.kind === "memory"
		? setTextSearchConfig({ memory: target.memory, textSearchConfig, dryRun })
		: setTextSearchConfig({
				store: target.storeConfig,
				textSearchConfig,
				dryRun,
			});
}

/**
 * `mnemocyte text-search <name>` against a resolved target: change the text
 * search configuration of keyword search.
 *
 * It first runs `setTextSearchConfig()` as a dry run, which checks the name
 * and the schema. The change rewrites the memories table under a lock that
 * blocks the app, so the command asks first; `--yes` answers for CI, and
 * without a terminal to ask on it exits 1 with nothing changed. `--json`,
 * which comes with `--dry-run`, prints the plan as one
 * {@link TextSearchPlanJson} line.
 *
 * @returns The exit code.
 */
export async function textSearchTarget(
	target: CliTarget,
	args: CliArgs,
	io: CliIo,
): Promise<number> {
	const name = args.textSearchConfig;
	if (name === undefined) {
		throw new CliError(
			"Name the text search configuration: mnemocyte text-search <name>.",
			EXIT_USAGE,
		);
	}
	const plan = await run(target, name, true);
	if (args.json) {
		writeJson(io, {
			command: "text-search",
			ok: true,
			dryRun: true,
			target: target.label,
			backend: target.store.backend,
			previous: plan.previous,
			current: plan.current,
			changed: plan.changed,
		} satisfies TextSearchPlanJson);
		return 0;
	}
	io.write(`Using ${target.label}\n`);
	if (target.store.backend === "in-memory") {
		io.write(
			"This client uses the in-memory backend, whose keyword search matches substrings; there is no text search configuration to change.\n",
		);
		return 0;
	}
	if (!plan.changed) {
		io.write(
			`Keyword search already uses the "${plan.current}" text search configuration.\n`,
		);
		return 0;
	}
	if (args.dryRun) {
		io.write(
			`Would change keyword search from "${plan.previous}" to "${plan.current}". ${REWRITE_WARNING}\n`,
		);
		return 0;
	}
	if (!args.yes) {
		const answer = await io.confirm(
			`Change keyword search from "${plan.previous}" to "${plan.current}"? ${REWRITE_WARNING} [y/N] `,
		);
		if (answer !== true) {
			io.error(
				answer === undefined
					? "Nothing changed: there is no terminal to ask on. Pass --yes to rewrite the memories table.\n"
					: "Nothing changed.\n",
			);
			return 1;
		}
	}
	const result = await run(target, name, false);
	io.write(
		result.changed
			? `Changed keyword search from "${result.previous}" to "${result.current}". Restart other app processes so their keyword search uses it.\n`
			: `Keyword search already uses the "${result.current}" text search configuration.\n`,
	);
	return 0;
}

/** `mnemocyte text-search`: resolve the target, run, close what was opened. */
export async function textSearchCommand(
	args: CliArgs,
	io: CliIo,
): Promise<number> {
	const target = await resolveTarget(args, io);
	try {
		return await textSearchTarget(target, args, io);
	} finally {
		await target.close();
	}
}
