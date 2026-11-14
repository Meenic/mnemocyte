import { describe, expect, test } from "vitest";
import { parseCliArgs } from "../../src/cli/args.js";
import { CliError } from "../../src/cli/io.js";

function usageError(argv: string[]): CliError {
	try {
		parseCliArgs(argv);
	} catch (error) {
		expect(error).toBeInstanceOf(CliError);
		return error as CliError;
	}
	throw new Error(`Expected ${argv.join(" ")} to be rejected.`);
}

describe("parseCliArgs", () => {
	test("reads each command with its flags", () => {
		expect(parseCliArgs(["migrate"])).toEqual({
			command: "migrate",
			yes: false,
			dryRun: false,
		});
		expect(
			parseCliArgs([
				"migrate",
				"--config",
				"src/memory.ts",
				"--yes",
				"--dry-run",
				"--dimensions",
				"768",
				"--env-file",
				".env.local",
			]),
		).toEqual({
			command: "migrate",
			config: "src/memory.ts",
			envFile: ".env.local",
			dimensions: 768,
			yes: true,
			dryRun: true,
		});
		expect(parseCliArgs(["check", "-c", "memory.ts"])).toEqual({
			command: "check",
			config: "memory.ts",
			yes: false,
			dryRun: false,
		});
		expect(
			parseCliArgs(["sql", "--dimensions=3072", "--out", "schema.sql"]),
		).toEqual({
			command: "sql",
			dimensions: 3072,
			out: "schema.sql",
			yes: false,
			dryRun: false,
		});
		expect(parseCliArgs(["-y", "migrate"]).yes).toBe(true);
	});

	test("help and version win over a command", () => {
		for (const argv of [["--help"], ["-h"], ["help"], ["migrate", "--help"]]) {
			expect(parseCliArgs(argv).command).toBe("help");
		}
		for (const argv of [["--version"], ["-v"], ["check", "-v"]]) {
			expect(parseCliArgs(argv).command).toBe("version");
		}
	});

	test.each([
		[[], "Name a command"],
		[["deploy"], 'Unknown command "deploy"'],
		[["migrate", "extra"], 'Unexpected argument "extra"'],
		[["migrate", "--force"], "Unknown option '--force'."],
		[["check", "--yes"], "--yes applies to migrate, not to check."],
		[["sql", "--dry-run"], "--dry-run applies to migrate, not to sql."],
		[["migrate", "--out", "x.sql"], "--out applies to sql, not to migrate."],
		[["migrate", "--config="], "--config needs a path."],
		[["migrate", "--config"], "--config"],
	])("rejects %j with exit code 2", (argv, message) => {
		const error = usageError(argv);
		expect(error.exitCode).toBe(2);
		expect(error.message).toContain(message);
		expect(error.message).not.toContain("To specify a positional");
	});

	test.each(["0", "4001", "-1", "1.5", "1e3", "0x10", " 12", "abc", ""])(
		"rejects --dimensions %j",
		(value) => {
			const error = usageError(["sql", `--dimensions=${value}`]);
			expect(error.exitCode).toBe(2);
			expect(error.message).toContain(
				"--dimensions must be an integer from 1 to 4000",
			);
		},
	);

	test("accepts the dimension bounds", () => {
		expect(parseCliArgs(["sql", "--dimensions", "1"]).dimensions).toBe(1);
		expect(parseCliArgs(["sql", "--dimensions", "4000"]).dimensions).toBe(4000);
	});
});
