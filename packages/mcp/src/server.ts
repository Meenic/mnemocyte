import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import type { BoundMemoryClient } from "mnemocyte";
import {
	forgetTool,
	type MemoryToolDefinition,
	type MemoryToolName,
	saveTool,
	searchTool,
} from "./tools.js";

/** Options for {@link createMemoryMcpServer}. */
export interface MemoryMcpServerOptions {
	/**
	 * A client bound to one scope, from `memory.for(scope)`. Every tool reads
	 * and writes that scope only; no tool input can name another.
	 */
	readonly memory: BoundMemoryClient;
	/**
	 * List `forgetMemory`, which deletes a memory for good.
	 * @defaultValue `false`
	 */
	readonly allowForget?: boolean;
	/**
	 * List `searchMemories` only. Cannot be combined with `allowForget`.
	 * @defaultValue `false`
	 */
	readonly readOnly?: boolean;
}

const OPTION_KEYS: readonly string[] = ["memory", "allowForget", "readOnly"];

/** The package name and version, read from `package.json` once. */
export const SERVER_INFO: { readonly name: string; readonly version: string } =
	readServerInfo();

function readServerInfo(): { name: string; version: string } {
	// `../package.json` is the package root from both src/ and dist/. An app
	// that bundles this module moves it, so a missing file is not an error.
	let manifest: unknown;
	try {
		manifest = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
	} catch {
		manifest = undefined;
	}
	const version =
		typeof manifest === "object" &&
		manifest !== null &&
		"version" in manifest &&
		typeof manifest.version === "string"
			? manifest.version
			: "unknown";
	return { name: "mnemocyte-mcp", version };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundClient(value: unknown): value is BoundMemoryClient {
	return (
		isRecord(value) &&
		isRecord(value.scope) &&
		typeof value.search === "function" &&
		typeof value.add === "function" &&
		typeof value.delete === "function"
	);
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
	return value === undefined || typeof value === "boolean";
}

/** The tools a server with these options lists, in order. */
export function toolNames(options: {
	readonly allowForget?: boolean | undefined;
	readonly readOnly?: boolean | undefined;
}): MemoryToolName[] {
	if (options.readOnly === true) {
		return ["searchMemories"];
	}
	return options.allowForget === true
		? ["searchMemories", "saveMemory", "forgetMemory"]
		: ["searchMemories", "saveMemory"];
}

function register<Input>(
	server: McpServer,
	tool: MemoryToolDefinition<Input>,
): void {
	server.registerTool(
		tool.name,
		{
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			outputSchema: tool.outputSchema,
			annotations: tool.annotations,
		},
		(input, context) => tool.run(input, context.mcpReq.signal),
	);
}

/**
 * An MCP server with Mnemocyte's memory tools over one bound client:
 * `searchMemories` and `saveMemory`, plus `forgetMemory` with
 * `allowForget`. The scope comes from `memory.for(scope)` on your side; no
 * tool takes a scope field, so a client or a prompt injection cannot reach
 * another scope's memories.
 *
 * Connect it to a transport yourself, or use the `mnemocyte-mcp` bin for
 * stdio. Create one per connection: an `McpServer` serves one transport.
 *
 * @throws {TypeError} When `memory` is not a bound client, an option is
 * unknown or not a boolean, or `readOnly` and `allowForget` are both set.
 *
 * @example
 * ```ts
 * import { createMemoryMcpServer } from "@mnemocyte/mcp";
 * import { memory } from "./memory.ts";
 *
 * const server = createMemoryMcpServer({
 *   memory: memory.for({ entityId: user.id }),
 * });
 * ```
 */
export function createMemoryMcpServer(
	options: MemoryMcpServerOptions,
): McpServer {
	if (!isRecord(options)) {
		throw new TypeError("createMemoryMcpServer requires an options object.");
	}
	for (const key of Object.keys(options)) {
		if (!OPTION_KEYS.includes(key)) {
			throw new TypeError(`createMemoryMcpServer: unknown option ${key}.`);
		}
	}
	const { memory, allowForget, readOnly } = options;
	if (!isBoundClient(memory)) {
		throw new TypeError(
			"createMemoryMcpServer requires a bound client: pass memory.for(scope), not the client itself.",
		);
	}
	if (!isOptionalBoolean(allowForget) || !isOptionalBoolean(readOnly)) {
		throw new TypeError(
			"createMemoryMcpServer: allowForget and readOnly must be booleans.",
		);
	}
	if (allowForget === true && readOnly === true) {
		throw new TypeError(
			"createMemoryMcpServer: readOnly and allowForget cannot both be set.",
		);
	}

	const server = new McpServer(SERVER_INFO, {
		capabilities: { tools: {} },
	});
	for (const name of toolNames({ allowForget, readOnly })) {
		switch (name) {
			case "searchMemories":
				register(server, searchTool(memory));
				break;
			case "saveMemory":
				register(server, saveTool(memory));
				break;
			case "forgetMemory":
				register(server, forgetTool(memory));
				break;
		}
	}
	return server;
}
