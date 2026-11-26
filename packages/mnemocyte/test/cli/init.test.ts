import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	chooseDriver,
	type InitDriver,
	ignoresEnvFile,
	installCommand,
	planEnvChange,
	renderMemoryFile,
	runnerCommand,
	SERVER_ONLY_IMPORT,
} from "../../src/cli/init.js";
import { CLIENT_PLACES, clientImport } from "../../src/cli/init-app.js";
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

/** The line init prints when drizzle-orm is listed but no client is found. */
const NO_CLIENT = `No Drizzle client to import in ${CLIENT_PLACES}, so memory.ts creates one. To use yours, run mnemocyte init --db <file>.`;

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
			await readFile(resolve("../../docs/guide/getting-started.md"), "utf8")
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

	test("each openai-compatible template is the OpenAI one with the guide's Ollama embedder", async () => {
		const guide = (
			await readFile(resolve("../../docs/guide/getting-started.md"), "utf8")
		).replaceAll("\r\n", "\n");
		const ollama = [...guide.matchAll(/```ts\n([\s\S]*?)```/g)]
			.map((match) => match[1] ?? "")
			.filter((block) =>
				block.includes("embedder: openaiCompatibleEmbedder({"),
			);
		expect(ollama).toHaveLength(1);
		const [importLine = "", property = ""] = (ollama[0] ?? "").split("\n\n");
		expect(importLine).toBe(
			'import { openaiCompatibleEmbedder } from "mnemocyte/embedders";',
		);
		const indented = property
			.trimEnd()
			.split("\n")
			.map((line) => `  ${line}`)
			.join("\n");
		for (const driver of DRIVERS) {
			const openai = renderMemoryFile({ driver, namespace: "my-agent" });
			const expected = openai
				.replace(
					'import { openaiEmbedder } from "mnemocyte/embedders";',
					importLine,
				)
				.replace(
					'  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),',
					indented,
				);
			expect(expected).not.toBe(openai);
			expect(
				renderMemoryFile({
					driver,
					namespace: "my-agent",
					embedder: "openai-compatible",
				}),
			).toBe(expected);
		}
	});

	test("each openrouter template is the OpenAI one with the same model through OpenRouter", () => {
		for (const driver of DRIVERS) {
			const openai = renderMemoryFile({ driver, namespace: "my-agent" });
			const expected = openai
				.replace(
					'import { openaiEmbedder } from "mnemocyte/embedders";',
					'import { openrouterEmbedder } from "mnemocyte/embedders";',
				)
				.replace(
					'  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),',
					'  embedder: openrouterEmbedder({ model: "openai/text-embedding-3-small" }),',
				);
			expect(expected).not.toBe(openai);
			expect(
				renderMemoryFile({
					driver,
					namespace: "my-agent",
					embedder: "openrouter",
				}),
			).toBe(expected);
		}
	});

	test("openai is the default embedder", () => {
		expect(
			renderMemoryFile({
				driver: "postgres",
				namespace: "my-agent",
				embedder: "openai",
			}),
		).toBe(renderMemoryFile({ driver: "postgres", namespace: "my-agent" }));
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
		expect(planEnvChange(content, "OPENAI_API_KEY")).toEqual(change);
	});

	test("adds the variable it is given", () => {
		expect(planEnvChange("OPENAI_API_KEY=sk\n", "OTHER_KEY")).toEqual({
			action: "append",
			text: "OTHER_KEY=\n",
		});
	});
});

test.each([
	[".env\n", ".env", true],
	["node_modules\r\n/.env\r\n", ".env", true],
	["  .env*  \n", ".env", true],
	["*.env\n", ".env", true],
	["*\n", ".env", true],
	[".env.local\n", ".env", false],
	[".env.*\n", ".env", false],
	["# .env\n", ".env", false],
	["!.env\n", ".env", false],
	["config/.env\n", ".env", false],
	["", ".env", false],
	[".env.local\n", ".env.local", true],
	["/.env.local\n", ".env.local", true],
	[".env*\n", ".env.local", true],
	[".env.*\n", ".env.local", true],
	[".env*.local\n", ".env.local", true],
	["*.local\n", ".env.local", true],
	[".env.loca?\n", ".env.local", true],
	[".env\n", ".env.local", false],
	[".env.development.local\n", ".env.local", false],
] as const)("ignoresEnvFile(%j, %j) is %s", (gitignore, name, ignored) => {
	expect(ignoresEnvFile(gitignore, name)).toBe(ignored);
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
				NO_CLIENT,
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

	test("with .env.local, writes the key there, as in a Next.js app", async () => {
		await packageJson({
			name: "web",
			type: "module",
			dependencies: { "drizzle-orm": "1", postgres: "3" },
		});
		await writeFile(join(cwd, ".env.local"), "DATABASE_URL=x\n");
		await writeFile(join(cwd, ".env"), "OTHER=1\n");
		await writeFile(join(cwd, ".gitignore"), ".env*\n");
		await writeFile(join(cwd, "pnpm-lock.yaml"), "");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await read(".env.local")).toBe("DATABASE_URL=x\nOPENAI_API_KEY=\n");
		expect(await read(".env")).toBe("OTHER=1\n");
		expect(io.stdout()).toBe(
			[
				"Found drizzle-orm, postgres in package.json: using Drizzle on postgres.js.",
				NO_CLIENT,
				"Wrote memory.ts",
				"Added OPENAI_API_KEY= to .env.local",
				"",
				"Next:",
				"  Put your OpenAI API key after OPENAI_API_KEY= in .env.local",
				"  Create the schema: pnpm exec mnemocyte migrate",
				"",
			].join("\n"),
		);
	});

	test("a key in .env counts with .env.local present, so it is not hidden", async () => {
		await packageJson({ type: "module", dependencies: { postgres: "3" } });
		await writeFile(join(cwd, ".env.local"), "OTHER=1\n");
		await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=sk-test\n");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await read(".env.local")).toBe("OTHER=1\n");
		const out = io.stdout();
		expect(out).toContain(".env already defines OPENAI_API_KEY, left as is.\n");
		expect(out).not.toContain("Put your OpenAI API key");
		expect(out).toContain("  Add DATABASE_URL=postgres://… to .env.local\n");
	});

	test("an empty key in .env.local wins over .env and gets the hint", async () => {
		await packageJson({ type: "module" });
		await writeFile(join(cwd, ".env.local"), "OPENAI_API_KEY=\n");
		await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=sk-test\n");
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		const out = io.stdout();
		expect(out).toContain(
			".env.local already defines OPENAI_API_KEY, left as is.\n",
		);
		expect(out).toContain(
			"  Put your OpenAI API key after OPENAI_API_KEY= in .env.local\n",
		);
	});

	test("notes a .gitignore that lists .env but not .env.local", async () => {
		await packageJson({ type: "module" });
		await writeFile(join(cwd, ".env.local"), "");
		await writeFile(join(cwd, ".gitignore"), ".env\n");
		const io = createTestIo(cwd);
		expect(await main(["init", "--dry-run"], io, "1.2.3")).toBe(0);

		expect(await read(".env.local")).toBe("");
		const out = io.stdout();
		expect(out).toContain("Would add OPENAI_API_KEY= to .env.local\n");
		expect(out).toContain(
			"note: .gitignore does not list .env.local; add it before you put a key in the file.\n",
		);
	});

	test("--embedder openai-compatible writes the Ollama file and leaves .env alone", async () => {
		await packageJson({
			name: "local-bot",
			type: "module",
			dependencies: { postgres: "3" },
		});
		await writeFile(join(cwd, "pnpm-lock.yaml"), "");
		const io = createTestIo(cwd);
		expect(
			await main(["init", "--embedder", "openai-compatible"], io, "1.2.3"),
		).toBe(0);

		expect(await read("memory.ts")).toBe(
			renderMemoryFile({
				driver: "postgres",
				namespace: "local-bot",
				embedder: "openai-compatible",
			}),
		);
		expect(await exists(".env")).toBe(false);
		expect(io.stdout()).toBe(
			[
				"Found postgres in package.json: using postgres.js.",
				"Embedder: nomic-embed-text (768 dimensions) on a local Ollama at http://localhost:11434/v1.",
				"Wrote memory.ts",
				"",
				"Next:",
				"  Add DATABASE_URL=postgres://… to .env",
				"  Pull the model: ollama pull nomic-embed-text (for another server, change baseURL, model and dimensions in memory.ts first)",
				"  Create the schema: pnpm exec mnemocyte migrate",
				"",
			].join("\n"),
		);
		expect(io.stderr()).toBe("");
	});

	test("--embedder openai-compatible keeps an existing .env and memory file", async () => {
		await packageJson({ type: "module" });
		await writeFile(join(cwd, "memory.ts"), "// mine\n");
		await writeFile(join(cwd, ".env"), "OTHER=1\n");
		const io = createTestIo(cwd);
		expect(
			await main(["init", "--embedder=openai-compatible"], io, "1.2.3"),
		).toBe(0);
		expect(await read("memory.ts")).toBe("// mine\n");
		expect(await read(".env")).toBe("OTHER=1\n");
		expect(io.stdout()).toBe("memory.ts exists, left as is.\n");
	});

	test("--embedder openai-compatible --dry-run prints the file and writes nothing", async () => {
		await packageJson({ name: "demo", type: "module" });
		const io = createTestIo(cwd);
		expect(
			await main(
				["init", "--dry-run", "--embedder", "openai-compatible"],
				io,
				"1.2.3",
			),
		).toBe(0);
		expect(await exists("memory.ts")).toBe(false);
		expect(await exists(".env")).toBe(false);
		const out = io.stdout();
		expect(out).toContain(
			`Would write memory.ts:\n\n${renderMemoryFile({ driver: "in-memory", namespace: "demo", embedder: "openai-compatible" })}`,
		);
		expect(out).not.toContain(".env");
		expect(out).toContain(
			"Next, after a real run:\n  Pull the model: ollama pull nomic-embed-text",
		);
	});

	test("--embedder openrouter writes the OpenRouter file and OPENROUTER_API_KEY=", async () => {
		await packageJson({
			name: "router-bot",
			type: "module",
			dependencies: { postgres: "3" },
		});
		await writeFile(join(cwd, ".gitignore"), ".env*\n");
		await writeFile(join(cwd, "pnpm-lock.yaml"), "");
		const io = createTestIo(cwd);
		expect(await main(["init", "--embedder", "openrouter"], io, "1.2.3")).toBe(
			0,
		);

		expect(await read("memory.ts")).toBe(
			renderMemoryFile({
				driver: "postgres",
				namespace: "router-bot",
				embedder: "openrouter",
			}),
		);
		expect(await read(".env")).toBe("OPENROUTER_API_KEY=\n");
		expect(io.stdout()).toBe(
			[
				"Found postgres in package.json: using postgres.js.",
				"Wrote memory.ts",
				"Created .env with OPENROUTER_API_KEY=",
				"",
				"Next:",
				"  Put your OpenRouter API key after OPENROUTER_API_KEY= in .env",
				"  Add DATABASE_URL=postgres://… to .env",
				"  Create the schema: pnpm exec mnemocyte migrate",
				"",
			].join("\n"),
		);
		expect(io.stderr()).toBe("");
	});

	test("--embedder openrouter keeps a defined OPENROUTER_API_KEY and adds no OPENAI_API_KEY", async () => {
		await packageJson({ type: "module" });
		await writeFile(join(cwd, ".env"), "OPENROUTER_API_KEY=sk-or-test\n");
		const io = createTestIo(cwd);
		expect(await main(["init", "--embedder=openrouter"], io, "1.2.3")).toBe(0);

		expect(await read(".env")).toBe("OPENROUTER_API_KEY=sk-or-test\n");
		const out = io.stdout();
		expect(out).toContain(
			".env already defines OPENROUTER_API_KEY, left as is.\n",
		);
		expect(out).not.toContain("OPENAI_API_KEY");
		expect(out).not.toContain("Put your");
	});

	test("--embedder openrouter --dry-run prints the file and writes nothing", async () => {
		await packageJson({ name: "demo", type: "module" });
		const io = createTestIo(cwd);
		expect(
			await main(
				["init", "--dry-run", "--embedder", "openrouter"],
				io,
				"1.2.3",
			),
		).toBe(0);
		expect(await exists("memory.ts")).toBe(false);
		expect(await exists(".env")).toBe(false);
		const out = io.stdout();
		expect(out).toContain(
			`Would write memory.ts:\n\n${renderMemoryFile({ driver: "in-memory", namespace: "demo", embedder: "openrouter" })}`,
		);
		expect(out).toContain("Would create .env with OPENROUTER_API_KEY=\n");
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

	async function files(entries: Record<string, string>): Promise<void> {
		for (const [name, content] of Object.entries(entries)) {
			await mkdir(dirname(join(cwd, name)), { recursive: true });
			await writeFile(join(cwd, name), content);
		}
	}

	const NEON_DB =
		'import { drizzle } from "drizzle-orm/neon-http";\n\nexport const db = drizzle(process.env.DATABASE_URL!);\n';

	test("a Next.js app on Neon gets src/lib/memory.ts that imports its db", async () => {
		await packageJson({
			name: "web",
			dependencies: {
				next: "16",
				"drizzle-orm": "0",
				"@neondatabase/serverless": "1",
			},
		});
		await files({
			"src/app/page.tsx": "",
			"src/db/drizzle.ts": NEON_DB,
			"src/db/schema.ts": "",
			".env.local": "DATABASE_URL=postgres://x\n",
			".gitignore": ".env*\n",
			"next.config.ts": "",
		});
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await read("src/lib/memory.ts")).toBe(
			[
				'import "server-only";',
				'import { createMemory } from "mnemocyte";',
				'import { openaiEmbedder } from "mnemocyte/embedders";',
				'import { db } from "../db/drizzle";',
				"",
				"export const memory = createMemory({",
				'  namespace: "web",',
				"  store: db,",
				'  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),',
				"});",
				"",
			].join("\n"),
		);
		expect(await exists("memory.ts")).toBe(false);
		expect(io.stdout()).toBe(
			[
				'Found next in package.json: a Next.js app, so the file goes in src/lib/ with import "server-only".',
				"Found the app's Drizzle client: db in src/db/drizzle.ts (Drizzle on Neon's HTTP driver).",
				"Wrote src/lib/memory.ts, which imports it.",
				"Added OPENAI_API_KEY= to .env.local",
				'note: package.json has no "type": "module". Node still loads src/lib/memory.ts as an ES module but warns on every run; set it with: npm pkg set type=module.',
				"",
				"Next:",
				"  Put your OpenAI API key after OPENAI_API_KEY= in .env.local",
				"  Create the schema: npx mnemocyte migrate",
				"",
			].join("\n"),
		);
		expect(io.stderr()).toBe("");

		// The CLI guide shows this run: its output, and the file with the
		// guide's namespace.
		const guide = (
			await readFile(resolve("../../docs/guide/cli.md"), "utf8")
		).replaceAll("\r\n", "\n");
		const section = guide.slice(guide.indexOf("### Your Drizzle client"));
		const shownOutput = /```txt\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
		expect(shownOutput).not.toBe("");
		expect(io.stdout().startsWith(shownOutput)).toBe(true);
		expect(/```ts\n([\s\S]*?)```/.exec(section)?.[1]).toBe(
			renderMemoryFile({
				client: clientImport("db", "../db/drizzle"),
				namespace: "my-app",
				serverOnly: true,
			}),
		);

		const again = createTestIo(cwd);
		expect(await main(["init"], again, "1.2.3")).toBe(0);
		expect(again.stdout()).toContain("src/lib/memory.ts exists, left as is.\n");
	});

	test("every template takes the server-only line first", () => {
		for (const driver of DRIVERS) {
			expect(
				renderMemoryFile({ driver, namespace: "web", serverOnly: true }),
			).toBe(
				`${SERVER_ONLY_IMPORT}\n${renderMemoryFile({ driver, namespace: "web" })}`,
			);
		}
	});

	test("a Next.js app without a client gets the template in lib/, and a note about next.config.js", async () => {
		await packageJson({
			name: "web",
			dependencies: { next: "16", "drizzle-orm": "0", postgres: "3" },
		});
		await files({
			"app/page.tsx": "",
			"src/util.ts": "",
			"next.config.js": "",
		});
		const io = createTestIo(cwd);
		expect(await main(["init", "--dry-run"], io, "1.2.3")).toBe(0);

		const out = io.stdout();
		expect(out).toContain(
			'so the file goes in lib/ with import "server-only".\n',
		);
		expect(out).toContain(
			"No Drizzle client to import in src/db/, db/, src/lib/db/, lib/db/, src/server/db/, server/db/, src/{db,drizzle}.*, src/lib/{db,drizzle}.*, lib/{db,drizzle}.*, src/server/{db,drizzle}.*, server/{db,drizzle}.*, db.*, so lib/memory.ts creates one. To use yours, run mnemocyte init --db <file>.\n",
		);
		expect(out).toContain(
			`Would write lib/memory.ts:\n\n${renderMemoryFile({ driver: "drizzle-postgres", namespace: "web", serverOnly: true })}`,
		);
		expect(out).toContain(
			"set it with: npm pkg set type=module. First rename next.config.js to next.config.mjs (or .ts) if it uses module.exports, and any other .js config that does to .cjs.\n",
		);
		expect(out).toContain("  Add DATABASE_URL=postgres://… to .env\n");
		expect(await exists("lib")).toBe(false);
	});

	test("an app outside Next.js keeps memory.ts in the root and names the variables its client reads", async () => {
		await packageJson({
			name: "api",
			type: "module",
			dependencies: { "drizzle-orm": "0", pg: "8" },
		});
		await files({
			"tsconfig.json":
				'{ "compilerOptions": { "module": "NodeNext", "moduleResolution": "NodeNext" } }',
			"src/server/db/index.ts":
				'import { drizzle } from "drizzle-orm/node-postgres";\nexport const db = drizzle(process.env.PG_URL!, { logger: process.env.NODE_ENV === "development" });\n',
		});
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);

		expect(await read("memory.ts")).toContain(
			'import { db } from "./src/server/db/index.js";\n',
		);
		expect(await read("memory.ts")).not.toContain("server-only");
		const out = io.stdout();
		expect(out).toContain(
			"Found the app's Drizzle client: db in src/server/db/index.ts (Drizzle on node-postgres).\n",
		);
		expect(out).not.toContain("type");
		expect(out).toContain(
			"  Add PG_URL=… to .env (src/server/db/index.ts reads it)\n",
		);
		expect(out).not.toContain("DATABASE_URL");
		expect(out).not.toContain("NODE_ENV");
	});

	test("a PGlite client without pgvector gets a note", async () => {
		await packageJson({ type: "module", dependencies: { "drizzle-orm": "0" } });
		await files({
			"src/db.ts":
				'import { drizzle } from "drizzle-orm/pglite";\nexport default drizzle("./data");\n',
		});
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(0);
		expect(await read("memory.ts")).toContain(
			'import db from "./src/db.js";\n',
		);
		expect(io.stdout()).toContain(
			"Found the app's Drizzle client: the default export of src/db.ts (Drizzle on PGlite).\nnote: src/db.ts does not import @electric-sql/pglite-pgvector. migrate needs pgvector: create the client with extensions: { vector } (see the getting-started guide).\n",
		);
	});

	test("skips a client over a driver Mnemocyte does not take", async () => {
		await packageJson({ dependencies: { "drizzle-orm": "0", postgres: "3" } });
		await files({
			"src/db/index.ts":
				'import { drizzle } from "drizzle-orm/mysql2";\nexport const db = drizzle(process.env.DATABASE_URL!);\n',
			"src/lib/db.ts":
				'import { drizzle } from "drizzle-orm/postgres-js";\nconst db = drizzle(process.env.DATABASE_URL!);\n',
		});
		const io = createTestIo(cwd);
		expect(await main(["init", "--dry-run"], io, "1.2.3")).toBe(0);
		expect(io.stdout()).toMatch(
			/^Skipped db in src\/db\/index\.ts: drizzle-orm\/mysql2 is not a driver Mnemocyte supports\.\nsrc\/lib\/db\.ts creates a Drizzle client but does not export it\.\nFound drizzle-orm, postgres in package\.json: using Drizzle on postgres\.js\.\nNo Drizzle client to import in /,
		);
	});

	test("several clients exit 2 and write nothing; --db picks one", async () => {
		await packageJson({ dependencies: { "drizzle-orm": "0" } });
		await files({
			"src/db/drizzle.ts": NEON_DB,
			"src/lib/db.ts":
				'import { drizzle } from "drizzle-orm/postgres-js";\nexport const db = drizzle(process.env.DATABASE_URL!);\n',
		});
		const io = createTestIo(cwd);
		expect(await main(["init"], io, "1.2.3")).toBe(2);
		expect(io.stdout()).toBe("");
		expect(io.stderr()).toBe(
			"mnemocyte: Found 2 Drizzle clients: db in src/db/drizzle.ts, db in src/lib/db.ts. Name the file of the one memories should use: mnemocyte init --db <file>.\n",
		);
		expect(await exists("memory.ts")).toBe(false);
		expect(await exists(".env")).toBe(false);

		const picked = createTestIo(cwd);
		expect(await main(["init", "--db", "src/lib/db.ts"], picked, "1.2.3")).toBe(
			0,
		);
		expect(picked.stdout()).toContain(
			"Found the app's Drizzle client: db in src/lib/db.ts (Drizzle on postgres.js).\n",
		);
		expect(await read("memory.ts")).toContain(
			'import { db } from "./src/lib/db";\n',
		);
	});

	test.each([
		[
			{},
			"nope.ts",
			"--db nope.ts is not a file. Name the file that exports the client.",
		],
		[
			{ "src/db/index.ts": "" },
			"src/db",
			"--db src/db is not a file. Name the file that exports the client.",
		],
		[
			{ "src/client.ts": "export const db = 1;\n" },
			"src/client.ts",
			"src/client.ts exports no drizzle(...) client that init can find. Export it, as in export const db = drizzle(...), or write the memory file by hand.",
		],
		[
			{
				"src/client.ts":
					'import { drizzle } from "drizzle-orm/postgres-js";\nexport const primary = drizzle("a");\nexport const replica = drizzle("b");\n',
			},
			"src/client.ts",
			"src/client.ts exports several Drizzle clients (primary, replica) and none is named db. Write the memory file by hand.",
		],
		[
			{
				"src/client.ts":
					'import { drizzle } from "drizzle-orm/better-sqlite3";\nexport const db = drizzle("a");\n',
			},
			"./src/client.ts",
			"src/client.ts uses drizzle-orm/better-sqlite3, which Mnemocyte does not support. Supported: drizzle-orm/postgres-js, drizzle-orm/node-postgres, drizzle-orm/pglite, drizzle-orm/neon-http, drizzle-orm/neon-serverless, drizzle-orm/libsql.",
		],
	])("--db exits 2 for %j", async (entries, path, message) => {
		await packageJson({});
		await files(entries);
		const io = createTestIo(cwd);
		expect(await main(["init", "--db", path], io, "1.2.3")).toBe(2);
		expect(io.stderr()).toBe(`mnemocyte: ${message}\n`);
		expect(await exists("memory.ts")).toBe(false);
	});

	test("--db takes the one named db among several, from any file", async () => {
		await packageJson({ type: "module" });
		await files({
			"src/index.ts":
				'import { drizzle } from "drizzle-orm/libsql";\nexport const db = drizzle("file:a.db");\nexport const logs = drizzle("file:b.db");\n',
		});
		const io = createTestIo(cwd);
		expect(await main(["init", "--db", "src/index.ts"], io, "1.2.3")).toBe(0);
		expect(io.stdout()).toContain(
			"Found the app's Drizzle client: db in src/index.ts (Drizzle on libSQL).\n",
		);
		expect(await read("memory.ts")).toContain(
			'import { db } from "./src/index.js";\n',
		);
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
