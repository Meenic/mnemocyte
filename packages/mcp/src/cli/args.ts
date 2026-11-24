import { parseArgs } from "node:util";

/** What the bin was asked to do. */
export type CliArgs =
	| { readonly command: "help" }
	| { readonly command: "version" }
	| {
			readonly command: "serve";
			readonly scope: ServeScope;
			readonly project: string | undefined;
			readonly config: string | undefined;
			readonly envFile: string | undefined;
			readonly allowForget: boolean;
			readonly readOnly: boolean;
	  };

/** The scope from the flags. `namespace` may come from the memory file. */
export interface ServeScope {
	readonly namespace?: string;
	readonly entityId: string;
	readonly agentId?: string;
	readonly sessionId?: string;
}

/** A usage error: bad flags. The bin prints it with the usage and exits 2. */
export class UsageError extends Error {
	override readonly name = "UsageError";
}

export const USAGE: string = `Usage: mnemocyte-mcp --entity-id <id> [options]

Serves Mnemocyte memory over MCP on stdio, for one scope fixed here.

Scope:
  --entity-id <id>      The user or entity whose memories the tools use. Required.
  --namespace <name>    Defaults to the memory file's createMemory({ namespace }).
  --agent-id <id>       Narrow the scope to one agent.
  --session-id <id>     Narrow the scope to one session.

Memory file:
  --project <dir>       The app's folder. --config, --env-file and the lookup
                        are relative to it. Default: the working directory.
  --config <file>       The app's memory file. Default: the first of memory.ts,
                        memory.mts, memory.js, memory.mjs in ., lib, src, src/lib.
  --env-file <file>     Load this file into the environment first. Default:
                        .env.local, then .env, in the app's folder, each when
                        it exists (no .env.local when NODE_ENV is test).

Tools:
  --allow-forget        Also list forgetMemory, which deletes for good.
  --read-only           List searchMemories only.

  -h, --help            Show this help.
  -v, --version         Show the version.
`;

const SCOPE_FLAGS = [
	["namespace", "namespace"],
	["entity-id", "entityId"],
	["agent-id", "agentId"],
	["session-id", "sessionId"],
] as const;

function nonEmpty(flag: string, value: string | undefined): string | undefined {
	if (value !== undefined && value.trim() === "") {
		throw new UsageError(`--${flag} cannot be empty.`);
	}
	return value;
}

/**
 * Parse the bin's arguments.
 *
 * @throws {UsageError} For an unknown flag, a positional argument, a missing
 * or empty `--entity-id`, an empty value, or `--read-only` with
 * `--allow-forget`.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		throw new UsageError(
			error instanceof Error ? error.message : String(error),
		);
	}
	const { values, positionals } = parsed;
	if (values.help === true) {
		return { command: "help" };
	}
	if (values.version === true) {
		return { command: "version" };
	}
	if (positionals.length > 0) {
		throw new UsageError(`Unexpected argument ${positionals[0]}.`);
	}

	const scope: Record<string, string> = {};
	for (const [flag, field] of SCOPE_FLAGS) {
		const value = nonEmpty(flag, values[flag]);
		if (value !== undefined) {
			scope[field] = value;
		}
	}
	const entityId = scope.entityId;
	if (entityId === undefined) {
		throw new UsageError(
			"--entity-id is required: the server serves one entity's memories.",
		);
	}
	const allowForget = values["allow-forget"] === true;
	const readOnly = values["read-only"] === true;
	if (allowForget && readOnly) {
		throw new UsageError("--read-only and --allow-forget cannot be combined.");
	}
	return {
		command: "serve",
		scope: { ...scope, entityId },
		project: nonEmpty("project", values.project),
		config: nonEmpty("config", values.config),
		envFile: nonEmpty("env-file", values["env-file"]),
		allowForget,
		readOnly,
	};
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			namespace: { type: "string" },
			"entity-id": { type: "string" },
			"agent-id": { type: "string" },
			"session-id": { type: "string" },
			project: { type: "string" },
			config: { type: "string" },
			"env-file": { type: "string" },
			"allow-forget": { type: "boolean" },
			"read-only": { type: "boolean" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}
