import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { beforeAll, describe, expect, it } from "vitest";

// The built bin over real stdio, as an MCP client starts it: Node loads the
// TypeScript memory file itself (type stripping and the resolve hook), and
// the file's console.log must not reach the protocol stream. Run after
// `pnpm build`.

const bin = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const app = fileURLToPath(new URL("./fixtures/app/", import.meta.url));

beforeAll(() => {
	if (!existsSync(bin)) {
		throw new Error("dist/cli.mjs is missing: run pnpm build first.");
	}
});

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
			expect(forgotten.structuredContent).toEqual({ forgotten: true });
		} finally {
			await client.close();
		}
		expect(log()).toContain("memory file loaded");
		expect(log()).toContain(
			"scope namespace=app entityId=u1, tools searchMemories, saveMemory, forgetMemory",
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
