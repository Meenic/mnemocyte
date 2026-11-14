import { execFile } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI = resolve("dist/cli.mjs");
const ALL_MIGRATIONS =
	"0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2";

interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run the built bin the way `npx mnemocyte` does: a Node process of its own
 * in the project folder, with stdin that is not a terminal. `DATABASE_URL`
 * is removed so a developer's shell cannot reach a database from here.
 */
function runCli(
	cwd: string,
	args: readonly string[],
	env: Record<string, string> = {},
): Promise<CliRun> {
	const { DATABASE_URL: _removed, ...inherited } = process.env;
	return new Promise((done) => {
		execFile(
			process.execPath,
			[CLI, ...args],
			{ cwd, env: { ...inherited, ...env }, windowsHide: true },
			(error, stdout, stderr) => {
				const code =
					error === null ? 0 : typeof error.code === "number" ? error.code : -1;
				done({ code, stdout, stderr });
			},
		);
	});
}

async function writeFiles(
	root: string,
	files: Record<string, string>,
): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
}

/**
 * Link a package into the project's node_modules. A junction needs no
 * symlink rights on Windows, and Node resolves the package's own
 * dependencies from its real path.
 */
async function linkPackage(
	project: string,
	name: string,
	target: string,
): Promise<void> {
	const link = join(project, "node_modules", name);
	await mkdir(dirname(link), { recursive: true });
	await symlink(await realpath(target), link, "junction");
}

// Each test starts several Node processes, which is slow when the other
// package tests pack the tarball at the same time.
describe("mnemocyte bin", { timeout: 60_000 }, () => {
	let root: string;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "mnemocyte-cli-"));
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	async function project(
		name: string,
		files: Record<string, string>,
	): Promise<string> {
		const directory = join(root, name);
		await writeFiles(directory, {
			"package.json": JSON.stringify({ name, type: "module", private: true }),
			...files,
		});
		await linkPackage(directory, "mnemocyte", resolve("."));
		return directory;
	}

	test("is declared as the package's bin and starts with a shebang", async () => {
		const manifest = JSON.parse(
			await readFile(resolve("package.json"), "utf8"),
		);
		expect(manifest.bin).toEqual({ mnemocyte: "./dist/cli.mjs" });
		expect(manifest.exports["./cli"]).toBeUndefined();
		expect(await readFile(CLI, "utf8")).toMatch(/^#!\/usr\/bin\/env node\n/);
	});

	test("has no static import of a database driver and no top-level await", async () => {
		const source = await readFile(CLI, "utf8");
		expect(source).not.toMatch(
			/^import\s+(?:[^"']+\s+from\s+)?["'](?:drizzle-orm(?:\/[^"']*)?|postgres|pg|@electric-sql\/pglite(?:\/[^"']*)?)["'];?\s*$/m,
		);
		expect(source).not.toMatch(/\bimport\(["']postgres["']\)/);
		expect(source).not.toMatch(/^await\s/m);
	});

	test("prints help and the version", async () => {
		const empty = await project("help", {});
		const help = await runCli(empty, ["--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toContain("Usage: mnemocyte <command> [options]");
		expect(help.stderr).toBe("");

		const manifest = JSON.parse(
			await readFile(resolve("package.json"), "utf8"),
		);
		const version = await runCli(empty, ["--version"]);
		expect(version).toEqual({
			code: 0,
			stdout: `${manifest.version}\n`,
			stderr: "",
		});
	});

	test("exits 2 with the usage for a bad command line", async () => {
		const empty = await project("usage", {});
		for (const args of [
			[],
			["frobnicate"],
			["migrate", "--bogus"],
			["migrate", "--out", "x.sql"],
			["sql", "--dimensions", "4001"],
		]) {
			const run = await runCli(empty, args);
			expect(run.code, args.join(" ")).toBe(2);
			expect(run.stdout).toBe("");
			expect(run.stderr).toMatch(/^mnemocyte: /);
			expect(run.stderr).toContain("Usage: mnemocyte");
		}
	});

	test("sql prints the fresh-install schema without a database or a memory file", async () => {
		const empty = await project("sql", {});
		const run = await runCli(empty, ["sql", "--dimensions", "1536"]);
		expect(run.stderr).toBe("");
		expect(run.code).toBe(0);
		expect(run.stdout).toBe(
			(
				await readFile(resolve("migrations/fresh-install.sql"), "utf8")
			).replaceAll("\r\n", "\n"),
		);

		const halfvec = await runCli(empty, ["sql", "--dimensions", "3072"]);
		expect(halfvec.stdout).toContain('"embedding" halfvec(3072)');

		const written = await runCli(empty, [
			"sql",
			"--dimensions",
			"768",
			"--out",
			"schema.768.sql",
		]);
		expect(written.code).toBe(0);
		expect(written.stdout).toBe("");
		expect(await readFile(join(empty, "schema.768.sql"), "utf8")).toContain(
			'"embedding" vector(768)',
		);

		const noSize = await runCli(empty, ["sql"]);
		expect(noSize.code).toBe(2);
		expect(noSize.stderr).toContain("--dimensions <n>");
	});

	test("without a memory file or DATABASE_URL, migrate and check exit 2", async () => {
		const empty = await project("no-target", {});
		for (const command of ["migrate", "check"]) {
			const run = await runCli(empty, [command]);
			expect(run.code).toBe(2);
			expect(run.stderr).toContain("No memory file found");
			expect(run.stderr).toContain("DATABASE_URL is not set");
		}
		const missing = await runCli(empty, ["check", "--config", "nope.ts"]);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("nope.ts is not a file");
	});

	test("a missing --env-file fails before anything runs", async () => {
		const empty = await project("env-file", {});
		const run = await runCli(empty, ["check", "--env-file", "nope.env"]);
		// Node reads --env-file from a script's own arguments too and stops
		// with its own message (exit 9); where it does not, the CLI exits 2.
		expect(run.code).not.toBe(0);
		expect(run.stdout).toBe("");
		expect(run.stderr).toContain("nope.env");
	});

	test("a memory file on the in-memory backend has nothing to migrate or check", async () => {
		const directory = await project("in-memory", {
			"lib/memory.ts": `
				import { createMemory, type Embedder } from "mnemocyte";

				const embedder: Embedder = {
					model: "in-memory",
					dimensions: 2,
					async embed(texts) {
						return texts.map(() => [1, 0]);
					},
				};
				export const memory = createMemory({ embedder });
			`,
		});
		const migrated = await runCli(directory, ["migrate"]);
		expect(migrated.stderr).toBe("");
		expect(migrated.code).toBe(0);
		expect(migrated.stdout).toContain("Using lib/memory.ts");
		expect(migrated.stdout).toContain("in-memory backend");
		const checked = await runCli(directory, ["check"]);
		expect(checked.code).toBe(0);
		expect(checked.stdout).toContain("nothing to check");
		// The embedder's size is enough for sql.
		const sql = await runCli(directory, ["sql"]);
		expect(sql.code).toBe(0);
		expect(sql.stdout).toContain('"embedding" vector(2)');
	});

	test("explains a memory file that does not load", async () => {
		const directory = await project("broken", {
			"memory.ts": `
				enum Kind { Fact }
				export const memory = Kind.Fact;
			`,
			"no-export.ts": "export const client: number = 1;\n",
			"missing-import.ts": `
				import { nothing } from "./not-there";
				export const memory = nothing;
			`,
			"throws.mjs": 'throw new Error("DATABASE_URL is required");\n',
		});
		const unsupported = await runCli(directory, ["migrate"]);
		expect(unsupported.code).toBe(2);
		expect(unsupported.stderr).toContain(
			"memory.ts uses TypeScript syntax Node cannot run",
		);
		expect(unsupported.stderr).toContain("--config <built .js>");

		const noExport = await runCli(directory, ["check", "-c", "no-export.ts"]);
		expect(noExport.code).toBe(2);
		expect(noExport.stderr).toContain(
			"no-export.ts does not export a memory client",
		);

		const missing = await runCli(directory, [
			"check",
			"--config",
			"missing-import.ts",
		]);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("imports a module that was not found");

		const throws = await runCli(directory, ["check", "--config", "throws.mjs"]);
		expect(throws.code).toBe(2);
		expect(throws.stderr).toContain(
			"Loading throws.mjs failed: DATABASE_URL is required",
		);
	});

	test("migrates and checks a PGlite database through a TypeScript memory file", async () => {
		// The imports a TypeScript app writes and type stripping alone does
		// not resolve: ".js" for a ".ts" file, no extension, a folder's index,
		// and a tsconfig "paths" alias (in a tsconfig with comments, a
		// trailing comma and an "extends").
		const directory = await project("pglite", {
			".env": "CLI_TEST_DIMENSIONS=8\nCLI_TEST_MODEL=from-env-file\n",
			"tsconfig.base.json": `{
				// Shared options.
				"compilerOptions": { "paths": { "@/*": ["./src/*"], }, },
			}`,
			"tsconfig.json": '{ "extends": "./tsconfig.base", /* nothing else */ }',
			"src/embedder.ts": `
				import type { Embedder } from "mnemocyte";

				const dimensions: number = Number(process.env.CLI_TEST_DIMENSIONS ?? 16);

				export const embedder: Embedder = {
					model: process.env.CLI_TEST_MODEL ?? "no-env",
					dimensions,
					async embed(texts) {
						return texts.map(() => Array.from({ length: dimensions }, () => 0.5));
					},
				};
			`,
			"src/settings/index.ts": 'export const namespace: string = "cli-test";\n',
			"src/lib/db.ts": `
				import { PGlite } from "@electric-sql/pglite";
				import { vector } from "@electric-sql/pglite-pgvector";

				export const db: PGlite = await PGlite.create({
					dataDir: "./memory-data",
					extensions: { vector },
				});
			`,
			"src/lib/memory.ts": `
				import { createMemory } from "mnemocyte";
				import { embedder } from "@/embedder";
				import { namespace } from "../settings";
				import { db } from "./db.js";

				export const memory = createMemory({ namespace, store: db, embedder });
			`,
		});
		await linkPackage(
			directory,
			"@electric-sql/pglite",
			resolve("node_modules/@electric-sql/pglite"),
		);
		await linkPackage(
			directory,
			"@electric-sql/pglite-pgvector",
			resolve("node_modules/@electric-sql/pglite-pgvector"),
		);

		const before = await runCli(directory, ["check"]);
		expect(before.stderr).toBe("");
		expect(before.code).toBe(1);
		expect(before.stdout).toContain("Using src/lib/memory.ts");
		expect(before.stdout).toContain("pgvector    not enabled");
		expect(before.stdout).toContain("migrations  not installed");
		expect(before.stdout).toContain("2 problems found");

		const plan = await runCli(directory, ["migrate", "--dry-run"]);
		expect(plan.code).toBe(0);
		expect(plan.stdout).toContain("Would enable pgvector");
		expect(plan.stdout).toContain(`Would apply: ${ALL_MIGRATIONS}`);

		// stdin is a pipe here, so there is no one to ask.
		const unanswered = await runCli(directory, ["migrate"]);
		expect(unanswered.code).toBe(1);
		expect(unanswered.stderr).toContain("Pass --yes to enable it");
		expect(unanswered.stderr).toContain(
			"CREATE EXTENSION IF NOT EXISTS vector;",
		);
		expect((await runCli(directory, ["check"])).stdout).toContain(
			"migrations  not installed",
		);

		const migrated = await runCli(directory, ["migrate", "--yes"]);
		expect(migrated.stderr).toBe("");
		expect(migrated.code).toBe(0);
		expect(migrated.stdout).toContain("Enabled pgvector.");
		expect(migrated.stdout).toContain(`Applied: ${ALL_MIGRATIONS}`);

		const again = await runCli(directory, ["migrate"]);
		expect(again.code).toBe(0);
		expect(again.stdout).toContain("The schema is up to date.");

		// .env set the embedder's size to 8; no warning reaches stderr.
		const checked = await runCli(directory, ["check"]);
		expect(checked.stderr).toBe("");
		expect(checked.code).toBe(0);
		expect(checked.stdout).toMatch(/pgvector {4}0\.\d+\.\d+/);
		expect(checked.stdout).toContain("migrations  4 of 4 applied");
		expect(checked.stdout).toContain("dimensions  8 (vector)");
		expect(checked.stdout).toContain("model       not recorded yet");
		expect(checked.stdout.trimEnd().endsWith("ok")).toBe(true);

		// A variable that is already set wins over the file.
		const mismatch = await runCli(
			directory,
			["check", "-c", "src/lib/memory.ts"],
			{
				CLI_TEST_DIMENSIONS: "12",
			},
		);
		expect(mismatch.code).toBe(1);
		expect(mismatch.stdout).toContain(
			"problem: The installation stores 8-dimension embeddings, but the embedder has 12 dimensions.",
		);
		expect(mismatch.stdout).toContain("1 problem found");

		const sql = await runCli(directory, ["sql"]);
		expect(sql.code).toBe(0);
		expect(sql.stdout).toBe(
			(await runCli(directory, ["sql", "--dimensions", "8"])).stdout,
		);
	}, 180_000);
});
