import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MnemocyteError } from "mnemocyte";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { USAGE } from "../../src/cli/args.js";
import { CliError } from "../../src/cli/io.js";
import { errorJson } from "../../src/cli/json.js";
import { describeError, main } from "../../src/cli/main.js";
import { renderInitialSchema } from "../../src/db/migrations/runner.js";
import { createTestIo } from "./io.js";

let cwd: string;

beforeAll(async () => {
	// An empty folder: no memory file and no .env for a command to pick up.
	cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-main-"));
});

afterAll(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("main", () => {
	test("prints the usage and the version", async () => {
		const help = createTestIo(cwd);
		expect(await main(["--help"], help, "1.2.3")).toBe(0);
		expect(help.stdout()).toBe(USAGE);
		expect(help.stderr()).toBe("");

		const version = createTestIo(cwd);
		expect(await main(["-v"], version, "1.2.3")).toBe(0);
		expect(version.stdout()).toBe("1.2.3\n");
	});

	test("a bad command line exits 2 with the reason and the usage on stderr", async () => {
		const io = createTestIo(cwd);
		expect(await main(["migrate", "--force"], io, "1.2.3")).toBe(2);
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toBe(
			`mnemocyte: Unknown option '--force'.\n\n${USAGE}`,
		);
	});

	test("sql --dimensions prints exactly the rendered schema", async () => {
		const io = createTestIo(cwd);
		expect(await main(["sql", "--dimensions", "1536"], io, "1.2.3")).toBe(0);
		expect(io.stdout()).toBe(renderInitialSchema(1536));
		expect(io.stdout()).toBe(
			(
				await readFile(resolve("migrations/fresh-install.sql"), "utf8")
			).replaceAll("\r\n", "\n"),
		);
		expect(io.stderr()).toBe("");
	});

	test("sql --schema creates the schema and installs into it", async () => {
		const io = createTestIo(cwd);
		expect(
			await main(
				["sql", "--dimensions", "1536", "--schema", "memory"],
				io,
				"1",
			),
		).toBe(0);
		const output = io.stdout();
		expect(output).toContain('CREATE SCHEMA IF NOT EXISTS "memory";');
		expect(output).toContain('SET search_path TO "memory", public;');
		expect(
			output.endsWith(renderInitialSchema(1536, "english", "memory")),
		).toBe(true);
		expect(output).toContain('REFERENCES "memory"."mnemocyte_memories"');
	});

	test("sql --out writes the file and keeps stdout empty", async () => {
		const io = createTestIo(cwd);
		expect(
			await main(
				["sql", "--dimensions", "2500", "--out", "schema.sql"],
				io,
				"1",
			),
		).toBe(0);
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toBe("Wrote schema.sql (2500 dimensions)\n");
		expect(await readFile(join(cwd, "schema.sql"), "utf8")).toBe(
			renderInitialSchema(2500),
		);
	});

	test("sql without a size or a memory file exits 2", async () => {
		const io = createTestIo(cwd);
		expect(await main(["sql"], io, "1")).toBe(2);
		expect(io.stderr()).toContain("pass --dimensions <n>");
	});

	test("with --json, a command that cannot run prints its error as JSON too", async () => {
		vi.stubEnv("DATABASE_URL", "");
		try {
			for (const argv of [
				["check", "--json"],
				["migrate", "--dry-run", "--json"],
			]) {
				const io = createTestIo(cwd);
				expect(await main(argv, io, "1")).toBe(2);
				const lines = io.stdout().split("\n");
				expect(lines).toHaveLength(2);
				expect(lines[1]).toBe("");
				expect(JSON.parse(lines[0] ?? "")).toEqual({
					command: argv[0],
					ok: false,
					error: {
						message: expect.stringContaining("No memory file found"),
						causes: [],
					},
				});
				// The text stays on standard error, as without --json.
				expect(io.stderr()).toContain("mnemocyte: No memory file found");
			}
		} finally {
			vi.unstubAllEnvs();
		}
	});

	test("a bad command line prints no JSON", async () => {
		const io = createTestIo(cwd);
		expect(await main(["migrate", "--json"], io, "1")).toBe(2);
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toContain("--json on migrate needs --dry-run.");
	});
});

describe("errorJson", () => {
	test("takes code and reason from the first MnemocyteError in the chain", () => {
		const error = new CliError(
			"Could not read the database, so nothing was checked.",
			2,
			new MnemocyteError({
				message: "Could not inspect the Postgres installation.",
				code: "DB",
				cause: Object.assign(new Error(""), { code: "ECONNREFUSED" }),
			}),
		);
		expect(errorJson("check", error)).toEqual({
			command: "check",
			ok: false,
			error: {
				message: "Could not read the database, so nothing was checked.",
				code: "DB",
				causes: [
					"Could not inspect the Postgres installation.",
					"ECONNREFUSED",
				],
			},
		});
		expect(
			errorJson(
				"migrate",
				new MnemocyteError({
					message: "pgvector is not installed in this database.",
					code: "MIGRATION",
					reason: "PGVECTOR_UNAVAILABLE",
				}),
			).error,
		).toEqual({
			message: "pgvector is not installed in this database.",
			code: "MIGRATION",
			reason: "PGVECTOR_UNAVAILABLE",
			causes: [],
		});
		expect(errorJson("check", "plain").error).toEqual({
			message: "plain",
			causes: [],
		});
	});
});

describe("describeError", () => {
	test("prints the message and each cause once", () => {
		const driver = Object.assign(new Error(""), { code: "ECONNREFUSED" });
		expect(
			describeError(
				new MnemocyteError({
					message: "Postgres migration failed.",
					code: "DB",
					cause: driver,
				}),
			),
		).toBe("mnemocyte: Postgres migration failed.\n  cause: ECONNREFUSED\n");

		const nested = new CliError(
			"Could not read the database, so nothing was checked.",
			2,
			new MnemocyteError({
				message: "Could not inspect the Postgres installation.",
				code: "DB",
				cause: new Error('password authentication\n failed for user "app"'),
			}),
		);
		expect(describeError(nested)).toBe(
			[
				"mnemocyte: Could not read the database, so nothing was checked.",
				"  cause: Could not inspect the Postgres installation.",
				'  cause: password authentication failed for user "app"',
				"",
			].join("\n"),
		);

		// A message that already quotes its cause does not repeat it.
		expect(
			describeError(
				new CliError("Loading memory.ts failed: boom", 2, new Error("boom")),
			),
		).toBe("mnemocyte: Loading memory.ts failed: boom\n");
		expect(describeError("plain")).toBe("mnemocyte: plain\n");
	});
});
