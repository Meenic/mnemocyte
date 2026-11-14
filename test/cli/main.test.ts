import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MnemocyteError } from "mnemocyte";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { USAGE } from "../../src/cli/args.js";
import { CliError } from "../../src/cli/io.js";
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
});

describe("describeError", () => {
	test("prints the message and each cause once", () => {
		const driver = Object.assign(new Error(""), { code: "ECONNREFUSED" });
		expect(
			describeError(
				new MnemocyteError("Postgres migration failed.", "DB", driver),
			),
		).toBe("mnemocyte: Postgres migration failed.\n  cause: ECONNREFUSED\n");

		const nested = new CliError(
			"Could not read the database, so nothing was checked.",
			2,
			new MnemocyteError(
				"Could not inspect the Postgres installation.",
				"DB",
				new Error('password authentication\n failed for user "app"'),
			),
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
