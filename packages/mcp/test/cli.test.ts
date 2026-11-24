import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCliArgs, USAGE } from "../src/cli/args.js";
import { type CliIo, prepare } from "../src/cli/main.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));

function recordingIo(cwd: string): CliIo & { out: string; err: string } {
	const io = {
		cwd,
		out: "",
		err: "",
		write(text: string) {
			io.out += text;
		},
		error(text: string) {
			io.err += text;
		},
	};
	return io;
}

describe("parseCliArgs", () => {
	it("reads the scope, files and tool flags", () => {
		expect(
			parseCliArgs([
				"--entity-id",
				"u1",
				"--namespace",
				"app",
				"--agent-id",
				"a",
				"--session-id",
				"s",
				"--project",
				"../app",
				"--config",
				"lib/memory.ts",
				"--env-file",
				".env.local",
				"--allow-forget",
			]),
		).toEqual({
			command: "serve",
			scope: { namespace: "app", entityId: "u1", agentId: "a", sessionId: "s" },
			project: "../app",
			config: "lib/memory.ts",
			envFile: ".env.local",
			allowForget: true,
			readOnly: false,
		});
	});

	it.each([
		[[], "--entity-id is required"],
		[["--entity-id", " "], "--entity-id cannot be empty."],
		[["--entity-id", "u1", "--namespace", ""], "--namespace cannot be empty."],
		[["--entity-id", "u1", "extra"], "Unexpected argument extra."],
		[["--entity-id", "u1", "--scope", "x"], "Unknown option '--scope'"],
		[
			["--entity-id", "u1", "--read-only", "--allow-forget"],
			"--read-only and --allow-forget cannot be combined.",
		],
	])("rejects %j", (argv, message) => {
		expect(() => parseCliArgs(argv)).toThrow(message);
	});

	it("answers help and version before checking the scope", () => {
		expect(parseCliArgs(["--help"])).toEqual({ command: "help" });
		expect(parseCliArgs(["-v"])).toEqual({ command: "version" });
	});
});

describe("prepare", () => {
	it("prints help to stdout", async () => {
		const io = recordingIo(fixtures);
		expect(await prepare(["--help"], io, "0.1.0")).toEqual({
			kind: "exit",
			code: 0,
		});
		expect(io.out).toBe(USAGE);
	});

	it("exits 2 with the usage for bad flags, on stderr only", async () => {
		const io = recordingIo(fixtures);
		expect(await prepare([], io, "0.1.0")).toEqual({ kind: "exit", code: 2 });
		expect(io.out).toBe("");
		expect(io.err).toContain("--entity-id is required");
		expect(io.err).toContain(USAGE);
	});

	it("finds the memory file and binds it to the flags' scope", async () => {
		const io = recordingIo(`${fixtures}app`);
		const prepared = await prepare(
			["--entity-id", "u1", "--session-id", "s1"],
			io,
			"0.1.0",
		);
		expect(prepared.kind).toBe("serve");
		expect(io.out).toBe("");
		expect(io.err).toBe(
			"mnemocyte-mcp 0.1.0: src/memory.ts, scope namespace=app entityId=u1 sessionId=s1, tools searchMemories, saveMemory, env none\n",
		);
	});

	it("looks in the --project folder", async () => {
		const io = recordingIo(fixtures);
		const prepared = await prepare(
			["--entity-id", "u1", "--project", "app"],
			io,
			"0.1.0",
		);
		expect(prepared.kind).toBe("serve");
		expect(io.err).toContain("mnemocyte-mcp 0.1.0: src/memory.ts, scope");

		const missing = recordingIo(fixtures);
		await prepare(["--entity-id", "u1", "--project", "nope"], missing, "x");
		expect(missing.err).toBe(
			"mnemocyte-mcp: --project: nope is not a folder.\n",
		);
	});

	it("exits 2 when no memory file is found", async () => {
		const io = recordingIo(fixtures);
		expect(await prepare(["--entity-id", "u1"], io, "0.1.0")).toEqual({
			kind: "exit",
			code: 2,
		});
		expect(io.err).toContain("No memory file found");
	});

	it("exits 2 when --config names no file", async () => {
		const io = recordingIo(fixtures);
		await prepare(["--entity-id", "u1", "--config", "missing.ts"], io, "x");
		expect(io.err).toBe("mnemocyte-mcp: --config: missing.ts is not a file.\n");
	});

	it("refuses a bound client", async () => {
		const io = recordingIo(`${fixtures}bound`);
		expect(await prepare(["--entity-id", "u1"], io, "x")).toEqual({
			kind: "exit",
			code: 2,
		});
		expect(io.err).toContain("exports a bound client from memory.for(...)");
	});

	it("refuses a file without a client", async () => {
		const io = recordingIo(`${fixtures}none`);
		await prepare(["--entity-id", "u1"], io, "x");
		expect(io.err).toContain("does not export a memory client");
	});

	it("asks for a namespace when neither the flags nor the file set one", async () => {
		const io = recordingIo(`${fixtures}no-namespace`);
		expect(await prepare(["--entity-id", "u1"], io, "x")).toEqual({
			kind: "exit",
			code: 2,
		});
		expect(io.err).toContain("Pass --namespace");

		const withFlag = recordingIo(`${fixtures}no-namespace`);
		const prepared = await prepare(
			["--entity-id", "u1", "--namespace", "app", "--read-only"],
			withFlag,
			"x",
		);
		expect(prepared.kind).toBe("serve");
		expect(withFlag.err).toContain("tools searchMemories, env none\n");
	});

	describe("env files", () => {
		afterEach(() => {
			vi.unstubAllEnvs();
		});

		it("reads .env.local, then .env, from --project and names them", async () => {
			// Vitest sets NODE_ENV to test, which would skip .env.local.
			vi.stubEnv("NODE_ENV", "development");
			vi.stubEnv("MCP_TEST_NAMESPACE", undefined);
			const project = await mkdtemp(join(tmpdir(), "mnemocyte-mcp-env-"));
			try {
				await writeFile(
					join(project, ".env.local"),
					"MCP_TEST_NAMESPACE=from-local\n",
				);
				await writeFile(join(project, ".env"), "MCP_TEST_NAMESPACE=from-env\n");
				const io = recordingIo(fixtures);
				const prepared = await prepare(
					[
						"--entity-id",
						"u1",
						"--project",
						project,
						"--config",
						join(fixtures, "env", "memory.ts"),
					],
					io,
					"0.1.0",
				);
				expect(prepared.kind).toBe("serve");
				expect(io.err).toContain("scope namespace=from-local entityId=u1");
				expect(io.err).toContain(", env .env.local, .env\n");
			} finally {
				await rm(project, { recursive: true, force: true });
			}
		});

		it("names the --env-file it read", async () => {
			const project = await mkdtemp(join(tmpdir(), "mnemocyte-mcp-env-"));
			try {
				await writeFile(join(project, "app.env"), "");
				const io = recordingIo(`${fixtures}app`);
				await prepare(
					["--entity-id", "u1", "--env-file", join(project, "app.env")],
					io,
					"0.1.0",
				);
				expect(io.err).toContain(`, env ${join(project, "app.env")}\n`);
			} finally {
				await rm(project, { recursive: true, force: true });
			}
		});
	});

	it("exits 2 when --env-file cannot be read", async () => {
		const io = recordingIo(`${fixtures}app`);
		await prepare(["--entity-id", "u1", "--env-file", "nope.env"], io, "x");
		expect(io.err).toBe(
			"mnemocyte-mcp: --env-file: could not read nope.env.\n",
		);
	});
});
