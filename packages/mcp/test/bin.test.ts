import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The built bin over real stdio, as an MCP client starts it: Node loads the
// TypeScript memory file itself (type stripping and the resolve hook), and
// the file's console.log must not reach the protocol stream. Run after
// `pnpm build`.

const bin = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const app = fileURLToPath(new URL("./fixtures/app/", import.meta.url));
const guarded = fileURLToPath(
	new URL("./fixtures/server-only/", import.meta.url),
);
const serverOnly = join(guarded, "node_modules", "server-only");

beforeAll(() => {
	if (!existsSync(bin)) {
		throw new Error("dist/cli.mjs is missing: run pnpm build first.");
	}
});

afterAll(async () => {
	await rm(join(guarded, "node_modules"), { recursive: true, force: true });
});

/**
 * React's `server-only` 0.0.1, the only version published: under any
 * condition but `react-server`, its entry throws.
 */
async function installServerOnly(): Promise<void> {
	await mkdir(serverOnly, { recursive: true });
	await writeFile(
		join(serverOnly, "package.json"),
		JSON.stringify({
			name: "server-only",
			version: "0.0.1",
			main: "index.js",
			exports: {
				".": { "react-server": "./empty.js", default: "./index.js" },
			},
		}),
	);
	await writeFile(
		join(serverOnly, "index.js"),
		'throw new Error("This module cannot be imported from a Client Component module. It should only be used from a Server Component.");',
	);
	await writeFile(join(serverOnly, "empty.js"), "");
}

async function start(args: string[]) {
	const stderr = new PassThrough();
	let log = "";
	stderr.on("data", (chunk: Buffer) => {
		log += chunk.toString("utf8");
	});
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [bin, ...args],
		cwd: app,
		stderr: "pipe",
	});
	// The transport's stderr stream exists before it starts the process.
	transport.stderr?.pipe(stderr);
	const client = new Client({ name: "bin-test", version: "0.0.0" });
	await client.connect(transport);
	return { client, transport, log: () => log };
}

describe("mnemocyte-mcp over stdio", () => {
	it("serves the tools for the scope in its flags", async () => {
		const { client, log } = await start([
			"--entity-id",
			"u1",
			"--allow-forget",
		]);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((tool) => tool.name)).toEqual([
				"searchMemories",
				"saveMemory",
				"forgetMemory",
			]);

			const saved = await client.callTool({
				name: "saveMemory",
				arguments: { content: "Drinks oat milk." },
			});
			const { id } = saved.structuredContent as { id: string };

			const found = await client.callTool({
				name: "searchMemories",
				arguments: { query: "oat milk" },
			});
			expect(found.structuredContent).toMatchObject({
				memories: [{ id, content: "Drinks oat milk." }],
			});

			const rejected = await client.callTool({
				name: "searchMemories",
				arguments: { query: "milk", entityId: "u2" },
			});
			expect(rejected.isError).toBe(true);

			const forgotten = await client.callTool({
				name: "forgetMemory",
				arguments: { id },
			});
			expect(forgotten.structuredContent).toEqual({
				forgotten: true,
				content: "Drinks oat milk.",
			});
		} finally {
			await client.close();
		}
		expect(log()).toContain("memory file loaded");
		expect(log()).toContain(
			"scope namespace=app entityId=u1, tools searchMemories, saveMemory, forgetMemory",
		);
	});

	it("loads a memory file that imports server-only, installed or not", async () => {
		const run = () =>
			spawnSync(process.execPath, [bin, "--entity-id", "u1"], {
				cwd: guarded,
				encoding: "utf8",
				input: "",
				timeout: 20_000,
			});
		// A copy left by an interrupted run would make this the installed case.
		await rm(join(guarded, "node_modules"), { recursive: true, force: true });
		const missing = run();
		expect(missing.stderr).toContain("scope namespace=guarded entityId=u1");
		expect(missing.status).toBe(0);

		await installServerOnly();
		const installed = run();
		expect(installed.stderr).toContain("scope namespace=guarded entityId=u1");
		expect(installed.status).toBe(0);
		// The stand-in throws when Node loads it, so the mapping is what helps.
		const direct = spawnSync(
			process.execPath,
			["--input-type=module", "--eval", 'import "server-only";'],
			{ cwd: guarded, encoding: "utf8" },
		);
		expect(direct.status).not.toBe(0);
		expect(direct.stderr).toContain(
			"cannot be imported from a Client Component",
		);
	});

	it("exits 2 with the usage on bad flags, writing nothing to stdout", () => {
		const result = spawnSync(process.execPath, [bin], {
			cwd: app,
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--entity-id is required");
	});

	it("exits when the client closes stdin", () => {
		const result = spawnSync(process.execPath, [bin, "--entity-id", "u1"], {
			cwd: app,
			encoding: "utf8",
			input: "",
			timeout: 20_000,
		});
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});
});
