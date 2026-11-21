import { DEFAULT_TEXT_SEARCH_CONFIG } from "../db/text-search.js";
import { setTextSearchConfig } from "../migrate.js";
import type { TextSearchConfigResult } from "../types.js";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { type TextSearchPlanJson, writeJson } from "./json.js";
import { type CliTarget, resolveTarget } from "./target.js";

const REWRITE_WARNING =
	"This rewrites the memories table and rebuilds every index on it, the HNSW index included. Reads and writes of memories wait until it finishes, which can take minutes on a large installation.";

/** libSQL keeps keyword search in an FTS5 table of its own. */
const LIBSQL_REBUILD_WARNING =
	"This rebuilds the keyword index from every memory's content in one write transaction; other writes wait until it finishes.";

/** The warning for `target`'s backend. */
function rebuildWarning(target: CliTarget): string {
	return target.store.backend === "libsql"
		? LIBSQL_REBUILD_WARNING
		: REWRITE_WARNING;
}

/**
 * What a change to `name` means for app processes that still run 1.1, which
 * search with `english` whatever the installation uses: a restart does not
 * help them, only an update. Empty when `name` is `english`, which 1.1
 * matches, or `null` (the in-memory backend, which has no configuration).
 */
function olderClientWarning(name: string | null): string {
	return name === null || name === DEFAULT_TEXT_SEARCH_CONFIG
		? ""
		: ` Every app process must run Mnemocyte 1.2 or later: 1.1 searches with "${DEFAULT_TEXT_SEARCH_CONFIG}" whatever the installation uses, so its keyword matches are lost.`;
}

/**
 * What a change to `name` means for an installation whose migrations are not
 * recorded (`psql` or drizzle-kit). drizzle-kit keeps the column's
 * configuration in its schema file, and changing the column here leaves that
 * file behind, so the next `drizzle-kit generate` would rewrite the column
 * again. `before` is the note for the question, `after` the one for the
 * result.
 */
function untrackedNote(name: string, when: "before" | "after"): string {
	const generate = `mnemocyte generate --adapter drizzle --text-search-config ${name}`;
	return when === "before"
		? ` The migrations of this installation are not recorded. If drizzle-kit manages these tables, change the language there instead: run ${generate}, then drizzle-kit generate. Changing it here leaves drizzle-kit's schema file behind.`
		: ` The migrations of this installation are not recorded. If drizzle-kit manages these tables, its schema file still has the old configuration: run ${generate} to update it. The migration that drizzle-kit generate then writes for content_tsv repeats this change.`;
}

/** {@link olderClientWarning} on Postgres; libSQL has no 1.1 clients. */
function olderWarning(target: CliTarget, name: string | null): string {
	return target.store.backend === "libsql" ? "" : olderClientWarning(name);
}

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
	const report = await target.store.inspectInstallation();
	const untracked = report?.migrations.state === "untracked";
	const before =
		untracked && plan.current !== null
			? untrackedNote(plan.current, "before")
			: "";
	if (args.dryRun) {
		io.write(
			`Would change keyword search from "${plan.previous}" to "${plan.current}". ${rebuildWarning(target)}${olderWarning(target, plan.current)}${before}\n`,
		);
		return 0;
	}
	if (!args.yes) {
		const answer = await io.confirm(
			`Change keyword search from "${plan.previous}" to "${plan.current}"? ${rebuildWarning(target)}${olderWarning(target, plan.current)}${before} [y/N] `,
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
			? `Changed keyword search from "${result.previous}" to "${result.current}". Restart other app processes so their keyword search uses it.${olderWarning(target, result.current)}${untracked && result.current !== null ? untrackedNote(result.current, "after") : ""}\n`
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
