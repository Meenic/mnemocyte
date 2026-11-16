import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseEnv } from "node:util";
import type { CliArgs } from "./args.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";
import { findMemoryFile } from "./memory-file.js";

/** The memory files `init` writes, one per driver setup. */
export type InitDriver =
	| "drizzle-postgres"
	| "drizzle-pg"
	| "drizzle-pglite"
	| "postgres"
	| "pg"
	| "pglite"
	| "in-memory";

/** The driver packages `init` looks for in `package.json`. */
export const DRIVER_PACKAGES: readonly string[] = [
	"drizzle-orm",
	"postgres",
	"pg",
	"@electric-sql/pglite",
];

const PGVECTOR_PACKAGE = "@electric-sql/pglite-pgvector";

/** The file `init` writes, relative to the project. */
export const INIT_FILE = "memory.ts";

/** Used when `package.json` has no `name`, as in the getting-started guide. */
export const DEFAULT_NAMESPACE = "my-agent";

const LABELS: Readonly<Record<InitDriver, string>> = {
	"drizzle-postgres": "Drizzle on postgres.js",
	"drizzle-pg": "Drizzle on node-postgres",
	"drizzle-pglite": "Drizzle on PGlite",
	postgres: "postgres.js",
	pg: "node-postgres",
	pglite: "PGlite",
	"in-memory": "in-memory, no database",
};

/** What `init` picked from the project's packages. */
export interface DriverChoice {
	readonly driver: InitDriver;
	/** How the output names the setup, such as "Drizzle on postgres.js". */
	readonly label: string;
	/** The driver packages in `package.json`, in {@link DRIVER_PACKAGES} order. */
	readonly found: readonly string[];
	/** Packages the written file imports that `package.json` does not list. */
	readonly missing: readonly string[];
}

/**
 * Pick the memory file for a project's packages. Drizzle wins and wraps
 * the driver next to it (postgres.js, then `pg`, then PGlite; postgres.js
 * when it has none); without Drizzle the order is postgres.js, `pg`,
 * PGlite; without any driver the file uses the in-memory backend.
 */
export function chooseDriver(packages: ReadonlySet<string>): DriverChoice {
	const found = DRIVER_PACKAGES.filter((name) => packages.has(name));
	const has = (name: string) => packages.has(name);
	let driver: InitDriver;
	if (has("drizzle-orm")) {
		driver = has("postgres")
			? "drizzle-postgres"
			: has("pg")
				? "drizzle-pg"
				: has("@electric-sql/pglite")
					? "drizzle-pglite"
					: "drizzle-postgres";
	} else if (has("postgres")) {
		driver = "postgres";
	} else if (has("pg")) {
		driver = "pg";
	} else if (has("@electric-sql/pglite")) {
		driver = "pglite";
	} else {
		driver = "in-memory";
	}
	const missing: string[] = [];
	if (driver === "drizzle-postgres" && !has("postgres")) {
		missing.push("postgres");
	}
	if (
		(driver === "pglite" || driver === "drizzle-pglite") &&
		!has(PGVECTOR_PACKAGE)
	) {
		missing.push(PGVECTOR_PACKAGE);
	}
	return { driver, label: LABELS[driver], found, missing };
}

/** Whether the setup needs `DATABASE_URL` (a server, not PGlite or memory). */
export function usesDatabaseUrl(driver: InitDriver): boolean {
	return (
		driver === "drizzle-postgres" ||
		driver === "drizzle-pg" ||
		driver === "postgres" ||
		driver === "pg"
	);
}

/** The embedders `init --embedder` writes, the default first. */
export const INIT_EMBEDDERS = ["openai", "openai-compatible"] as const;

export type InitEmbedder = (typeof INIT_EMBEDDERS)[number];

interface EmbedderTemplate {
	readonly import: string;
	/** The `embedder:` property, unindented, as the guide shows it. */
	readonly property: string;
	/** The `.env` variable `init` adds, or none for a local server. */
	readonly envVariable?: string;
	/** The "Next" line while `envVariable` is empty. */
	readonly keyHint?: string;
	/** A line printed once the file is chosen, or none. */
	readonly note?: string;
	/** A "Next" line after the file is written, or none. */
	readonly next?: string;
}

const OPENAI_IMPORT = 'import { openaiEmbedder } from "mnemocyte/embedders";';

// The OpenAI file is a getting-started `memory.ts` block; the
// OpenAI-compatible one swaps in the guide's Ollama block. A unit test
// holds both to the guide.
const EMBEDDERS: Readonly<Record<InitEmbedder, EmbedderTemplate>> = {
	openai: {
		import: OPENAI_IMPORT,
		property: 'embedder: openaiEmbedder({ model: "text-embedding-3-small" }),',
		envVariable: "OPENAI_API_KEY",
		keyHint: "Put your OpenAI API key after OPENAI_API_KEY= in .env",
	},
	"openai-compatible": {
		import: 'import { openaiCompatibleEmbedder } from "mnemocyte/embedders";',
		property: `embedder: openaiCompatibleEmbedder({
  baseURL: "http://localhost:11434/v1",
  model: "nomic-embed-text",
  dimensions: 768,
  // nomic-embed-text expects these prefixes on queries and documents
  purposes: {
    query: { prefix: "search_query: " },
    document: { prefix: "search_document: " },
  },
}),`,
		note: "Embedder: nomic-embed-text (768 dimensions) on a local Ollama at http://localhost:11434/v1.",
		next: "Pull the model: ollama pull nomic-embed-text (for another server, change baseURL, model and dimensions in memory.ts first)",
	},
};

interface Template {
	readonly imports: readonly string[];
	/** The lines that create the database client, or none. */
	readonly setup?: string;
	/** The `store` expression, or none for the in-memory backend. */
	readonly store?: string;
}

const MNEMOCYTE_IMPORTS = [
	'import { createMemory } from "mnemocyte";',
	OPENAI_IMPORT,
];

const POSTGRES_SETUP =
	"export const sql = postgres(process.env.DATABASE_URL!);";
const PG_SETUP =
	"export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });";
const PGLITE_SETUP = (name: string) =>
	`export const ${name} = await PGlite.create({
  dataDir: "./memory-data",
  extensions: { vector },
});`;
const PGLITE_IMPORTS = [
	'import { PGlite } from "@electric-sql/pglite";',
	'import { vector } from "@electric-sql/pglite-pgvector";',
];

// The getting-started guide shows each of these files; a unit test checks
// that every template is one of its code blocks.
const TEMPLATES: Readonly<Record<InitDriver, Template>> = {
	"drizzle-postgres": {
		imports: [
			'import { drizzle } from "drizzle-orm/postgres-js";',
			...MNEMOCYTE_IMPORTS,
			'import postgres from "postgres";',
		],
		setup: `${POSTGRES_SETUP}\nexport const db = drizzle({ client: sql });`,
		store: "db",
	},
	"drizzle-pg": {
		imports: [
			'import { drizzle } from "drizzle-orm/node-postgres";',
			...MNEMOCYTE_IMPORTS,
			'import pg from "pg";',
		],
		setup: `${PG_SETUP}\nexport const db = drizzle({ client: pool });`,
		store: "db",
	},
	"drizzle-pglite": {
		imports: [
			...PGLITE_IMPORTS,
			'import { drizzle } from "drizzle-orm/pglite";',
			...MNEMOCYTE_IMPORTS,
		],
		setup: `${PGLITE_SETUP("client")}\nexport const db = drizzle({ client });`,
		store: "db",
	},
	postgres: {
		imports: [...MNEMOCYTE_IMPORTS, 'import postgres from "postgres";'],
		setup: POSTGRES_SETUP,
		store: "sql",
	},
	pg: {
		imports: [...MNEMOCYTE_IMPORTS, 'import pg from "pg";'],
		setup: PG_SETUP,
		store: "pool",
	},
	pglite: {
		imports: [...PGLITE_IMPORTS, ...MNEMOCYTE_IMPORTS],
		setup: PGLITE_SETUP("db"),
		store: "db",
	},
	"in-memory": { imports: MNEMOCYTE_IMPORTS },
};

/** The `memory.ts` `init` writes for a driver, namespace and embedder. */
export function renderMemoryFile(input: {
	driver: InitDriver;
	namespace: string;
	/** Defaults to `openai`. */
	embedder?: InitEmbedder;
}): string {
	const { imports, setup, store } = TEMPLATES[input.driver];
	const embedder = EMBEDDERS[input.embedder ?? "openai"];
	const lines = [
		imports
			.map((line) => (line === OPENAI_IMPORT ? embedder.import : line))
			.join("\n"),
		"",
		...(setup === undefined ? [] : [setup, ""]),
		"export const memory = createMemory({",
		`  namespace: ${JSON.stringify(input.namespace)},`,
		...(store === undefined ? [] : [`  store: ${store},`]),
		...embedder.property.split("\n").map((line) => `  ${line}`),
		"});",
	];
	return `${lines.join("\n")}\n`;
}

/** What `init` does to `.env`. */
export type EnvChange =
	| { readonly action: "none" }
	| { readonly action: "create"; readonly text: string }
	| { readonly action: "append"; readonly text: string };

/**
 * Plan adding `variable=` to `.env` for its current content, or `null` when
 * there is no file: nothing when the variable is defined (even empty), else
 * one line in the file's own line ending, after a line break when the last
 * line has none.
 */
export function planEnvChange(
	content: string | null,
	variable: string,
): EnvChange {
	if (content === null) {
		return { action: "create", text: `${variable}=\n` };
	}
	if (parseEnv(content)[variable] !== undefined) {
		return { action: "none" };
	}
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const separator = content === "" || content.endsWith("\n") ? "" : eol;
	return { action: "append", text: `${separator}${variable}=${eol}` };
}

/** Whether a `.gitignore` has a line that ignores `.env` in the root. */
export function ignoresEnvFile(gitignore: string): boolean {
	return gitignore
		.split(/\r?\n/)
		.some((line) => /^\/?(\.env\*?|\*\.env|\*)$/.test(line.trim()));
}

type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

const PACKAGE_MANAGERS: readonly PackageManager[] = [
	"pnpm",
	"yarn",
	"bun",
	"npm",
];

const LOCKFILES: readonly [string, PackageManager][] = [
	["pnpm-lock.yaml", "pnpm"],
	["yarn.lock", "yarn"],
	["bun.lock", "bun"],
	["bun.lockb", "bun"],
];

/**
 * The package manager a `package.json` names: `devEngines.packageManager`
 * (which `pnpm init` writes) or the `packageManager` field (Corepack).
 */
function declaredPackageManager(
	pkg: PackageJson | undefined,
): PackageManager | undefined {
	if (pkg === undefined) {
		return undefined;
	}
	const { devEngines } = pkg;
	let name: unknown;
	if (typeof devEngines === "object" && devEngines !== null) {
		const entry =
			"packageManager" in devEngines ? devEngines.packageManager : undefined;
		const first = Array.isArray(entry) ? entry[0] : entry;
		if (typeof first === "object" && first !== null && "name" in first) {
			name = first.name;
		}
	}
	if (name === undefined && typeof pkg.packageManager === "string") {
		name = pkg.packageManager.split("@")[0];
	}
	return PACKAGE_MANAGERS.find((manager) => manager === name);
}

/**
 * The project's package manager: the one `package.json` names, else the
 * one whose lockfile exists, else npm.
 */
async function detectPackageManager(
	cwd: string,
	pkg?: PackageJson,
): Promise<PackageManager> {
	const declared = declaredPackageManager(pkg);
	if (declared !== undefined) {
		return declared;
	}
	for (const [lockfile, manager] of LOCKFILES) {
		if ((await readText(join(cwd, lockfile))) !== null) {
			return manager;
		}
	}
	return "npm";
}

/** The install command for the project's package manager, by lockfile. */
export async function installCommand(
	cwd: string,
	packages: readonly string[],
): Promise<string> {
	const manager = await detectPackageManager(cwd);
	const verb = manager === "npm" ? "install" : "add";
	return `${manager} ${verb} ${packages.join(" ")}`;
}

/** What runs a package's bin, by package manager. */
const RUNNERS: Readonly<Record<PackageManager, string>> = {
	pnpm: "pnpm exec",
	yarn: "yarn",
	bun: "bunx",
	npm: "npx",
};

/**
 * The command that runs the project's installed `mnemocyte`: `npx` fails
 * in a project whose `devEngines` names another package manager.
 */
export async function runnerCommand(
	cwd: string,
	pkg?: PackageJson,
): Promise<string> {
	return `${RUNNERS[await detectPackageManager(cwd, pkg)]} mnemocyte`;
}

/**
 * What runs an installed bin in the project at `cwd` (`pnpm exec`, `npx`
 * …), from its `package.json` when that parses, else its lockfile.
 */
export async function projectRunner(cwd: string): Promise<string> {
	let pkg: PackageJson | undefined;
	try {
		pkg = await readPackageJson(cwd);
	} catch {
		pkg = undefined;
	}
	return RUNNERS[await detectPackageManager(cwd, pkg)];
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (isCode(error, "ENOENT") || isCode(error, "EISDIR")) {
			return null;
		}
		throw error;
	}
}

function isCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

export interface PackageJson {
	readonly name?: unknown;
	readonly type?: unknown;
	readonly dependencies?: unknown;
	readonly devDependencies?: unknown;
	readonly devEngines?: unknown;
	readonly packageManager?: unknown;
}

async function readPackageJson(cwd: string): Promise<PackageJson> {
	const text = await readText(join(cwd, "package.json"));
	if (text === null) {
		throw new CliError(
			"No package.json in this folder. Run mnemocyte init in your project's root folder.",
			EXIT_USAGE,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new CliError("package.json is not valid JSON.", EXIT_USAGE, error);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CliError("package.json is not a JSON object.", EXIT_USAGE);
	}
	return parsed;
}

function packageNames(pkg: PackageJson): Set<string> {
	const names = new Set<string>();
	for (const field of [pkg.dependencies, pkg.devDependencies]) {
		if (typeof field === "object" && field !== null) {
			for (const name of Object.keys(field)) {
				names.add(name);
			}
		}
	}
	return names;
}

/**
 * `mnemocyte init`: write a `memory.ts` for the driver in `package.json`
 * and the embedder `--embedder` names, and add the embedder's key variable
 * (`OPENAI_API_KEY=`; none for `openai-compatible`) to `.env` when it is
 * not defined there. It
 * never overwrites a file: an existing memory file anywhere the CLI looks
 * is left as is, and `memory.ts` is created with `O_EXCL` (`flag: "wx"`),
 * so a file that appears in the meantime is not replaced either. Every
 * change is printed; `--dry-run` prints them and writes nothing.
 *
 * @returns The exit code.
 * @throws {CliError} With exit code 2 when there is no readable
 * `package.json`.
 */
export async function initCommand(args: CliArgs, io: CliIo): Promise<number> {
	const { cwd } = io;
	const dryRun = args.dryRun;
	const embedder = EMBEDDERS[args.embedder ?? "openai"];
	const pkg = await readPackageJson(cwd);
	const out: string[] = [];
	const next: string[] = [];

	// The memory file. One that already exists anywhere the CLI looks is
	// kept: a new ./memory.ts would hide src/memory.ts from the CLI.
	const existing = findMemoryFile(cwd);
	let choice: DriverChoice | undefined;
	if (existing !== null) {
		out.push(`${displayPath(cwd, existing)} exists, left as is.`);
	} else {
		choice = chooseDriver(packageNames(pkg));
		const namespace =
			typeof pkg.name === "string" && pkg.name !== ""
				? pkg.name
				: DEFAULT_NAMESPACE;
		const content = renderMemoryFile({
			driver: choice.driver,
			namespace,
			...(args.embedder === undefined ? {} : { embedder: args.embedder }),
		});
		if (choice.driver === "in-memory") {
			out.push(
				`No database driver in package.json (${DRIVER_PACKAGES.join(", ")}): using the in-memory backend, whose memories are gone when the process exits. To use Postgres later, install a driver, delete ${INIT_FILE} and run mnemocyte init again.`,
			);
		} else {
			out.push(
				`Found ${choice.found.join(", ")} in package.json: using ${choice.label}.`,
			);
		}
		if (embedder.note !== undefined) {
			out.push(embedder.note);
		}
		if (dryRun) {
			out.push(`Would write ${INIT_FILE}:`, "", content);
		} else if (await createFile(join(cwd, INIT_FILE), content)) {
			out.push(`Wrote ${INIT_FILE}`);
		} else {
			out.push(`${INIT_FILE} exists, left as is.`);
			choice = undefined;
		}
	}

	// .env, for an embedder that reads a key from it. A local server needs
	// none, so .env is not touched.
	const envPath = join(cwd, ".env");
	const envContent = await readText(envPath);
	const env = envContent === null ? {} : parseEnv(envContent);
	const variable = embedder.envVariable;
	const change: EnvChange =
		variable === undefined
			? { action: "none" }
			: planEnvChange(envContent, variable);
	if (variable !== undefined && change.action === "none") {
		out.push(`.env already defines ${variable}, left as is.`);
	} else if (variable !== undefined && change.action !== "none") {
		const verb = change.action === "create" ? "create .env with" : "add";
		if (dryRun) {
			out.push(
				`Would ${verb} ${variable}=${change.action === "append" ? " to .env" : ""}`,
			);
		} else {
			if (change.action === "create") {
				await writeFile(envPath, change.text, { flag: "wx" });
				out.push(`Created .env with ${variable}=`);
			} else {
				await appendFile(envPath, change.text);
				out.push(`Added ${variable}= to .env`);
			}
		}
		const gitignore = await readText(join(cwd, ".gitignore"));
		if (gitignore === null || !ignoresEnvFile(gitignore)) {
			out.push(
				"note: .gitignore does not list .env; add it before you put a key in the file.",
			);
		}
	}

	if (choice !== undefined && pkg.type !== "module") {
		out.push(
			`note: package.json has no "type": "module". Node still loads ${INIT_FILE} as an ES module but warns on every run; set it with: npm pkg set type=module`,
		);
	}

	// What is left for the user.
	if (choice !== undefined && choice.missing.length > 0) {
		next.push(`Install: ${await installCommand(cwd, choice.missing)}`);
	}
	if (
		variable !== undefined &&
		embedder.keyHint !== undefined &&
		!env[variable]
	) {
		next.push(embedder.keyHint);
	}
	if (choice !== undefined && usesDatabaseUrl(choice.driver)) {
		if (env.DATABASE_URL === undefined) {
			next.push("Add DATABASE_URL=postgres://… to .env");
		}
	}
	if (choice !== undefined && embedder.next !== undefined) {
		next.push(embedder.next);
	}
	if (choice !== undefined && choice.driver !== "in-memory") {
		next.push(`Create the schema: ${await runnerCommand(cwd, pkg)} migrate`);
	}

	io.write(`${out.join("\n")}\n`);
	if (next.length > 0) {
		io.write(
			`\nNext${dryRun ? ", after a real run" : ""}:\n${next.map((line) => `  ${line}`).join("\n")}\n`,
		);
	}
	return 0;
}

/** Create a file that does not exist; false when it does. */
async function createFile(path: string, content: string): Promise<boolean> {
	try {
		await writeFile(path, content, { flag: "wx" });
		return true;
	} catch (error) {
		if (isCode(error, "EEXIST")) {
			return false;
		}
		throw error;
	}
}

function displayPath(cwd: string, file: string): string {
	return relative(cwd, file).replaceAll("\\", "/") || file;
}
