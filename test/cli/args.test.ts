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
			json: false,
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
			json: false,
		});
		expect(parseCliArgs(["check", "-c", "memory.ts"])).toEqual({
			command: "check",
			config: "memory.ts",
			yes: false,
			dryRun: false,
			json: false,
		});
		expect(
			parseCliArgs(["sql", "--dimensions=3072", "--out", "schema.sql"]),
		).toEqual({
			command: "sql",
			dimensions: 3072,
			out: "schema.sql",
			yes: false,
			dryRun: false,
			json: false,
		});
		expect(parseCliArgs(["-y", "migrate"]).yes).toBe(true);
		expect(parseCliArgs(["init"])).toEqual({
			command: "init",
			yes: false,
			dryRun: false,
			json: false,
		});
		expect(parseCliArgs(["init", "--dry-run"]).dryRun).toBe(true);
		expect(
			parseCliArgs(["init", "--embedder", "openai-compatible"]).embedder,
		).toBe("openai-compatible");
		expect(parseCliArgs(["init", "--embedder=openai"]).embedder).toBe("openai");
	});

	test("--json goes with check and with migrate --dry-run", () => {
		expect(parseCliArgs(["check", "--json"])).toEqual({
			command: "check",
			yes: false,
			dryRun: false,
			json: true,
		});
		expect(parseCliArgs(["migrate", "--json", "--dry-run"])).toMatchObject({
			command: "migrate",
			dryRun: true,
			json: true,
		});
	});

	test("text-search takes a name; --text-search-config goes with migrate, check and sql", () => {
		expect(parseCliArgs(["text-search", "simple"])).toEqual({
			command: "text-search",
			textSearchConfig: "simple",
			yes: false,
			dryRun: false,
			json: false,
		});
		expect(
			parseCliArgs(["text-search", "german", "--dry-run", "--json", "-y"]),
		).toMatchObject({
			command: "text-search",
			textSearchConfig: "german",
			yes: true,
			dryRun: true,
			json: true,
		});
		for (const command of ["migrate", "check", "sql"]) {
			expect(
				parseCliArgs([command, "--text-search-config", "simple"])
					.textSearchConfig,
			).toBe("simple");
		}
	});

	test.each([
		[["text-search"], "Name the text search configuration"],
		[["text-search", "simple", "german"], 'Unexpected argument "german"'],
		[
			["text-search", "simple", "--json"],
			"--json on text-search needs --dry-run",
		],
		[
			["text-search", "simple", "--dimensions", "8"],
			"--dimensions does not apply",
		],
		[
			["text-search", "simple", "--text-search-config", "simple"],
			"--text-search-config applies to migrate, check and sql, not to text-search.",
		],
		[
			["init", "--text-search-config", "simple"],
			"--text-search-config applies to migrate, check and sql, not to init.",
		],
		[["migrate", "--text-search-config", ""], "must be a non-empty string"],
		[["migrate", "simple"], 'Unexpected argument "simple"'],
	])("rejects text search arguments %j", (argv, message) => {
		const error = usageError(argv);
		expect(error.exitCode).toBe(2);
		expect(error.message).toContain(message);
	});

	test("--schema goes with migrate, check, sql and text-search", () => {
		for (const argv of [
			["migrate", "--schema", "memory"],
			["check", "--schema", "memory"],
			["sql", "--dimensions", "3", "--schema", "memory"],
			["text-search", "simple", "--schema", "memory"],
		]) {
			expect(parseCliArgs(argv).schema).toBe("memory");
		}
		expect(parseCliArgs(["migrate"])).not.toHaveProperty("schema");
	});

	test.each([
		[
			["init", "--schema", "memory"],
			"--schema applies to migrate, check, sql and text-search, not to init.",
		],
		[["migrate", "--schema", "Memory"], "--schema must be lower case letters"],
		[["migrate", "--schema", "pg_memory"], "must not start with pg_"],
		[["migrate", "--schema"], "argument missing"],
	])("rejects schema arguments %j", (argv, message) => {
		const error = usageError(argv);
		expect(error.exitCode).toBe(2);
		expect(error.message).toContain(message);
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
		[
			["check", "--yes"],
			"--yes applies to migrate and text-search, not to check.",
		],
		[
			["sql", "--dry-run"],
			"--dry-run applies to migrate, init and text-search, not to sql.",
		],
		[
			["init", "--yes"],
			"--yes applies to migrate and text-search, not to init.",
		],
		[["init", "--config", "m.ts"], "--config does not apply to init."],
		[["init", "--env-file", ".env.x"], "--env-file does not apply to init."],
		[["init", "--dimensions", "8"], "--dimensions does not apply to init."],
		[["init", "extra"], 'Unexpected argument "extra"'],
		[["migrate", "--out", "x.sql"], "--out applies to sql, not to migrate."],
		[["migrate", "--config="], "--config needs a path."],
		[["migrate", "--config"], "--config"],
		[
			["sql", "--json"],
			"--json applies to check, migrate and text-search, not to sql.",
		],
		[
			["init", "--json"],
			"--json applies to check, migrate and text-search, not to init.",
		],
		[
			["migrate", "--embedder", "openai"],
			"--embedder applies to init, not to migrate.",
		],
		[
			["init", "--embedder", "ollama"],
			'Unknown embedder "ollama". Embedders: openai, openai-compatible.',
		],
		[["init", "--embedder="], 'Unknown embedder "".'],
		[["init", "--embedder"], "--embedder"],
		[["migrate", "--json"], "--json on migrate needs --dry-run."],
		[["migrate", "--json", "--yes"], "--json on migrate needs --dry-run."],
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
