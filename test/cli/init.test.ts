import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	chooseDriver,
	type InitDriver,
	ignoresEnvFile,
	installCommand,
	planEnvChange,
	renderMemoryFile,
	runnerCommand,
} from "../../src/cli/init.js";
import { main } from "../../src/cli/main.js";
import { createTestIo } from "./io.js";

const DRIVERS: readonly InitDriver[] = [
	"drizzle-postgres",
	"drizzle-pg",
	"drizzle-pglite",
	"postgres",
	"pg",
	"pglite",
	"in-memory",
];

describe("chooseDriver", () => {
	test.each([
		[
			["drizzle-orm", "postgres", "pg", "@electric-sql/pglite"],
			"drizzle-postgres",
			[],
		],
		[["drizzle-orm", "pg", "@electric-sql/pglite"], "drizzle-pg", []],
		[
			["drizzle-orm", "@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
			"drizzle-pglite",
			[],
		],
		[
			["drizzle-orm", "@electric-sql/pglite"],
			"drizzle-pglite",
			["@electric-sql/pglite-pgvector"],
		],
		[["drizzle-orm"], "drizzle-postgres", ["postgres"]],
		[["postgres", "pg", "@electric-sql/pglite"], "postgres", []],
		[["pg", "@electric-sql/pglite"], "pg", []],
		[["@electric-sql/pglite"], "pglite", ["@electric-sql/pglite-pgvector"]],
		[["@electric-sql/pglite", "@electric-sql/pglite-pgvector"], "pglite", []],
		[[], "in-memory", []],
		[["express", "zod"], "in-memory", []],
	] as const)("%j → %s", (packages, driver, missing) => {
		const choice = chooseDriver(new Set(packages));
		expect(choice.driver).toBe(driver);
		expect(choice.missing).toEqual(missing);
	});

	test("lists the driver packages it saw, in a fixed order", () => {
		expect(
			chooseDriver(new Set(["pg", "zod", "postgres", "drizzle-orm"])).found,
		).toEqual(["drizzle-orm", "postgres", "pg"]);
	});
});

describe("renderMemoryFile", () => {
	test("each template is a memory.ts from the getting-started guide, and each of those is a template", async () => {
		const guide = (
			await readFile(resolve("docs/guide/getting-started.md"), "utf8")
		).replaceAll("\r\n", "\n");
		const blocks = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
			.map((match) => match[1] ?? "")
			.filter(
				(block) =>
					block.startsWith("import ") && block.includes("export const memory"),
			);
		const templates = DRIVERS.map((driver) =>
			renderMemoryFile({ driver, namespace: "my-agent" }),
		);
		expect(new Set(templates).size).toBe(DRIVERS.length);
		expect([...blocks].sort()).toEqual([...templates].sort());
	});

	test("quotes the namespace as a string literal", () => {
		expect(
			renderMemoryFile({ driver: "pg", namespace: "@acme/agent" }),
		).toContain('  namespace: "@acme/agent",\n');
	});
});

describe("planEnvChange", () => {
	test.each([
		[null, { action: "create", text: "OPENAI_API_KEY=\n" }],
		["", { action: "append", text: "OPENAI_API_KEY=\n" }],
		["DATABASE_URL=x\n", { action: "append", text: "OPENAI_API_KEY=\n" }],
		["DATABASE_URL=x", { action: "append", text: "\nOPENAI_API_KEY=\n" }],
		["A=1\r\nB=2", { action: "append", text: "\r\nOPENAI_API_KEY=\r\n" }],
		["# OPENAI_API_KEY=sk\n", { action: "append", text: "OPENAI_API_KEY=\n" }],
		["OPENAI_API_KEY=\n", { action: "none" }],
		["OPENAI_API_KEY=sk-1", { action: "none" }],
		["export OPENAI_API_KEY='sk-1'\n", { action: "none" }],
	] as const)("%j", (content, change) => {
		expect(planEnvChange(content)).toEqual(change);
	});
});

test.each([
	[".env\n", true],
	["node_modules\r\n/.env\r\n", true],
	["  .env*  \n", true],
	["*.env\n", true],
	[".env.local\n", false],
	["# .env\n", false],
	["", false],
] as const)("ignoresEnvFile(%j) is %s", (gitignore, ignored) => {
	expect(ignoresEnvFile(gitignore)).toBe(ignored);
});

describe("mnemocyte init", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-init-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	async function packageJson(fields: Record<string, unknown>): Promise<void> {
		await writeFile(join(cwd, "package.json"), JSON.stringify(fields));
	}

	async function read(name: string): Promise<string> {
		return readFile(join(cwd, name), "utf8");
	}

	async function exists(name: string): Promise<boolean> {
		return readFile(join(cwd, name)).then(
			() => true,
			() => false,
		);
	}

	test("writes the Drizzle file, creates .env and prints every change", async () => {
		await packageJson({
			name: "support-bot",
			type: "module",
			dependencies: { "drizzle-orm": "1", pg: "8", mnemocyte: "0" },
		});
		await writeFile(join(cwd, "pnpm-lock.yaml"), "");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await read("memory.ts")).toBe(
			renderMemoryFile({ driver: "drizzle-pg", namespace: "support-bot" }),
		);
		expect(await read(".env")).toBe("OPENAI_API_KEY=\n");
		expect(io.stdout()).toBe(
			[
				"Found drizzle-orm, pg in package.json: using Drizzle on node-postgres.",
				"Wrote memory.ts",
				"Created .env with OPENAI_API_KEY=",
				"note: .gitignore does not list .env; add it before you put a key in the file.",
				"",
				"Next:",
				"  Put your OpenAI API key after OPENAI_API_KEY= in .env",
				"  Add DATABASE_URL=postgres://… to .env",
				"  Create the schema: pnpm exec mnemocyte migrate",
				"",
			].join("\n"),
		);
		expect(io.stderr()).toBe("");
	});

	test("appends to an existing .env in its own line ending and names missing packages", async () => {
		await packageJson({ devDependencies: { "@electric-sql/pglite": "0" } });
		await writeFile(join(cwd, ".env"), "DATABASE_URL=x\r\nOTHER=1");
		await writeFile(join(cwd, ".gitignore"), ".env\n");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await read("memory.ts")).toBe(
			renderMemoryFile({ driver: "pglite", namespace: "my-agent" }),
		);
		expect(await read(".env")).toBe(
			"DATABASE_URL=x\r\nOTHER=1\r\nOPENAI_API_KEY=\r\n",
		);
		const out = io.stdout();
		expect(out).toContain("Added OPENAI_API_KEY= to .env\n");
		expect(out).not.toContain(".gitignore");
		expect(out).toContain('note: package.json has no "type": "module".');
		expect(out).toContain(
			"  Install: npm install @electric-sql/pglite-pgvector\n",
		);
		expect(out).not.toContain("DATABASE_URL");
	});

	test("without a driver writes the in-memory file", async () => {
		await packageJson({ name: "demo", type: "module" });
		await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=sk-test\n");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await read("memory.ts")).toBe(
			renderMemoryFile({ driver: "in-memory", namespace: "demo" }),
		);
		expect(await read(".env")).toBe("OPENAI_API_KEY=sk-test\n");
		expect(io.stdout()).toContain(
			"No database driver in package.json (drizzle-orm, postgres, pg, @electric-sql/pglite): using the in-memory backend",
		);
		expect(io.stdout()).toContain(
			".env already defines OPENAI_API_KEY, left as is.\n",
		);
		expect(io.stdout()).not.toContain("Next");
	});

	test("never replaces a memory file the CLI would find, nor .env", async () => {
		await packageJson({ dependencies: { postgres: "3" } });
		await mkdir(join(cwd, "src"));
		await writeFile(join(cwd, "src/memory.ts"), "// mine\n");
		await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=\n");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await exists("memory.ts")).toBe(false);
		expect(await read("src/memory.ts")).toBe("// mine\n");
		expect(await read(".env")).toBe("OPENAI_API_KEY=\n");
		expect(io.stdout()).toBe(
			[
				"src/memory.ts exists, left as is.",
				".env already defines OPENAI_API_KEY, left as is.",
				"",
				"Next:",
				"  Put your OpenAI API key after OPENAI_API_KEY= in .env",
				"",
			].join("\n"),
		);
	});

	test("a second run changes nothing", async () => {
		await packageJson({ type: "module", dependencies: { postgres: "3" } });
		expect(await main(["init"], createTestIo(cwd), "1.2.3")).toBe(0);
		const memoryFile = await read("memory.ts");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);
		expect(await read("memory.ts")).toBe(memoryFile);
		expect(await read(".env")).toBe("OPENAI_API_KEY=\n");
		expect(io.stdout()).toContain("memory.ts exists, left as is.\n");
	});

	test("--dry-run prints the file and the .env change and writes nothing", async () => {
		await packageJson({ name: "bot", dependencies: { postgres: "3" } });
		await writeFile(join(cwd, ".env"), "DATABASE_URL=x\n");
		const io = createTestIo(cwd);
		expect(await main(["init", "--dry-run"], io, "1.2.3")).toBe(0);

		expect(await exists("memory.ts")).toBe(false);
		expect(await read(".env")).toBe("DATABASE_URL=x\n");
		const out = io.stdout();
		expect(out).toContain(
			`Would write memory.ts:\n\n${renderMemoryFile({ driver: "postgres", namespace: "bot" })}`,
		);
		expect(out).toContain("Would add OPENAI_API_KEY= to .env\n");
		expect(out).toContain("Next, after a real run:\n");
	});

	test("--dry-run without .env says it would create one", async () => {
		await packageJson({});
		const io = createTestIo(cwd);
		expect(await main(["init", "--dry-run"], io, "1.2.3")).toBe(0);
		expect(await exists(".env")).toBe(false);
		expect(io.stdout()).toContain("Would create .env with OPENAI_API_KEY=\n");
	});

	test("exits 2 without a readable package.json", async () => {
		const missing = createTestIo(cwd);
		expect(await main(["init"], missing, "1.2.3")).toBe(2);
		expect(missing.stderr()).toBe(
			"mnemocyte: No package.json in this folder. Run mnemocyte init in your project's root folder.\n",
		);

		await writeFile(join(cwd, "package.json"), "{ nope");
		const broken = createTestIo(cwd);
		expect(await main(["init"], broken, "1.2.3")).toBe(2);
		expect(broken.stderr()).toContain(
			"mnemocyte: package.json is not valid JSON.\n",
		);
		expect(await exists("memory.ts")).toBe(false);
		expect(await exists(".env")).toBe(false);
	});
});

test("installCommand follows the lockfile", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-install-"));
	try {
		expect(await installCommand(cwd, ["postgres"])).toBe(
			"npm install postgres",
		);
		await writeFile(join(cwd, "yarn.lock"), "");
		expect(await installCommand(cwd, ["a", "b"])).toBe("yarn add a b");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

describe("runnerCommand", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-runner-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	test("falls back to npx without a declaration or lockfile", async () => {
		expect(await runnerCommand(cwd)).toBe("npx mnemocyte");
		expect(await runnerCommand(cwd, {})).toBe("npx mnemocyte");
	});

	test("follows the lockfile", async () => {
		await writeFile(join(cwd, "yarn.lock"), "");
		expect(await runnerCommand(cwd)).toBe("yarn mnemocyte");
	});

	test("bun lockfile uses bunx", async () => {
		await writeFile(join(cwd, "bun.lock"), "");
		expect(await runnerCommand(cwd)).toBe("bunx mnemocyte");
	});

	test("devEngines.packageManager wins over the lockfile, object or array", async () => {
		await writeFile(join(cwd, "package-lock.json"), "");
		await writeFile(join(cwd, "yarn.lock"), "");
		expect(
			await runnerCommand(cwd, {
				devEngines: { packageManager: { name: "pnpm", version: "10" } },
			}),
		).toBe("pnpm exec mnemocyte");
		expect(
			await runnerCommand(cwd, {
				devEngines: { packageManager: [{ name: "pnpm" }, { name: "npm" }] },
			}),
		).toBe("pnpm exec mnemocyte");
	});

	test("reads the packageManager field and ignores unknown names", async () => {
		expect(await runnerCommand(cwd, { packageManager: "pnpm@10.4.0" })).toBe(
			"pnpm exec mnemocyte",
		);
		expect(await runnerCommand(cwd, { packageManager: "deno@2" })).toBe(
			"npx mnemocyte",
		);
	});
});

test("init names pnpm from devEngines in a project without a lockfile", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-init-pm-"));
	try {
		await writeFile(
			join(cwd, "package.json"),
			JSON.stringify({
				type: "module",
				devEngines: { packageManager: { name: "pnpm", version: "10" } },
				dependencies: { postgres: "3", "@electric-sql/pglite": "0" },
			}),
		);
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);
		expect(io.stdout()).toContain(
			"  Create the schema: pnpm exec mnemocyte migrate\n",
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
