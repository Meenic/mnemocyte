import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
	findMemoryFile,
	findTsconfig,
	loadModuleOptions,
} from "@mnemocyte/loader";
import type { CliArgs } from "./args.js";
import {
	type AppClient,
	CLIENT_PLACES,
	type ClientImport,
	clientImport,
	displayPath,
	findDrizzleClients,
	importSpecifier,
	nextMemoryFolder,
	readClientFile,
	SUPPORTED_DRIVER_NAMES,
} from "./init-app.js";
import { CliError, type CliIo, EXIT_USAGE } from "./io.js";

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
	/** The env file variable `init` adds, or none for a local server. */
	readonly envVariable?: string;
	/**
	 * What the "Next" line calls the key while `envVariable` is empty, as in
	 * "Put your *OpenAI API key* after OPENAI_API_KEY= in .env".
	 */
	readonly keyName?: string;
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
		keyName: "OpenAI API key",
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

/** The line a Next.js app's memory file starts with. */
export const SERVER_ONLY_IMPORT = 'import "server-only";';

/**
 * Where the memory file gets its database: a driver template, which creates
 * the client, or the app's own client, which it imports.
 */
export type MemoryFileSource =
	| { readonly driver: InitDriver }
	| { readonly client: ClientImport };

/** The `memory.ts` `init` writes for a source, namespace and embedder. */
export function renderMemoryFile(
	input: MemoryFileSource & {
		readonly namespace: string;
		/** Defaults to `openai`. */
		readonly embedder?: InitEmbedder;
		/** Start with `import "server-only"`, for a Next.js app. */
		readonly serverOnly?: boolean;
	},
): string {
	const { imports, setup, store }: Template =
		"client" in input
			? {
					imports: [...MNEMOCYTE_IMPORTS, input.client.line],
					store: input.client.local,
				}
			: TEMPLATES[input.driver];
	const embedder = EMBEDDERS[input.embedder ?? "openai"];
	const lines = [
		[
			...(input.serverOnly === true ? [SERVER_ONLY_IMPORT] : []),
			...imports.map((line) =>
				line === OPENAI_IMPORT ? embedder.import : line,
			),
		].join("\n"),
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

/** What `init` does to its env file. */
export type EnvChange =
	| { readonly action: "none" }
	| { readonly action: "create"; readonly text: string }
	| { readonly action: "append"; readonly text: string };

/**
 * Plan adding `variable=` to an env file for its current content, or `null`
 * when there is no file: nothing when the variable is defined (even empty),
 * else one line in the file's own line ending, after a line break when the
 * last line has none.
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

/**
 * A `.gitignore` line as a regular expression for a file in the root, or
 * null for a comment, a negation, a folder-only line or one that names a
 * path below the root. `*` and `?` match within a name, as in Git; the
 * rest is literal.
 */
function gitignorePattern(line: string): RegExp | null {
	const trimmed = line.trim();
	const pattern = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
	if (
		pattern === "" ||
		pattern.startsWith("#") ||
		pattern.startsWith("!") ||
		pattern.includes("/")
	) {
		return null;
	}
	const source = [...pattern]
		.map((char) =>
			char === "*"
				? "[^/]*"
				: char === "?"
					? "[^/]"
					: char.replace(/[\\^$.|+()[\]{}]/g, "\\$&"),
		)
		.join("");
	return new RegExp(`^${source}$`);
}

/**
 * Whether a `.gitignore` has a line that ignores `name` (`.env` or
 * `.env.local`) in the root: `.env`, `.env*`, `*.env` or `*` for `.env`;
 * `.env.local`, `.env*`, `.env*.local` or `*.local` for `.env.local`.
 */
export function ignoresEnvFile(gitignore: string, name: string): boolean {
	return gitignore
		.split(/\r?\n/)
		.some((line) => gitignorePattern(line)?.test(name) === true);
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
 * (`OPENAI_API_KEY=`; none for `openai-compatible`) to `.env.local` when the
 * project has one, else to `.env`, when neither file defines it. It
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
	const packages = packageNames(pkg);
	const out: string[] = [];
	const next: string[] = [];

	// The memory file. One that already exists anywhere the CLI looks is
	// kept: a new ./memory.ts would hide src/memory.ts from the CLI.
	const existing = findMemoryFile(cwd);
	// What the written file uses: a driver template or the app's client.
	let choice: DriverChoice | undefined;
	let client: AppClient | undefined;
	let written: string | undefined;
	const nextApp = packages.has("next");
	if (existing !== null) {
		out.push(`${displayPath(cwd, existing)} exists, left as is.`);
	} else {
		// A Next.js app keeps it in its lib folder, guarded for the server.
		const folder = nextApp ? await nextMemoryFolder(cwd) : "";
		const file = join(cwd, folder, INIT_FILE);
		const shown = displayPath(cwd, file);
		if (nextApp) {
			out.push(
				`Found next in package.json: a Next.js app, so the file goes in ${folder}/ with import "server-only".`,
			);
		}
		client =
			args.db === undefined
				? await findAppClient(cwd, out)
				: await clientFromFlag(cwd, args.db);
		const namespace =
			typeof pkg.name === "string" && pkg.name !== ""
				? pkg.name
				: DEFAULT_NAMESPACE;
		const options = {
			namespace,
			serverOnly: nextApp,
			...(args.embedder === undefined ? {} : { embedder: args.embedder }),
		};
		let content: string;
		if (client !== undefined) {
			const clientFile = displayPath(cwd, client.file);
			out.push(
				`Found the app's Drizzle client: ${describeClient(cwd, client)} (${client.label}).`,
			);
			if (client.driver === "pglite" && !client.pgvector) {
				out.push(
					`note: ${clientFile} does not import @electric-sql/pglite-pgvector. migrate needs pgvector: create the client with extensions: { vector } (see the getting-started guide).`,
				);
			}
			const extensions = await usesImportExtensions(cwd, pkg, nextApp);
			content = renderMemoryFile({
				client: clientImport(
					client.name,
					importSpecifier({
						fromDirectory: dirname(file),
						to: client.file,
						extensions,
					}),
				),
				...options,
			});
		} else {
			choice = chooseDriver(packages);
			if (choice.driver === "in-memory") {
				out.push(
					`No database driver in package.json (${DRIVER_PACKAGES.join(", ")}): using the in-memory backend, whose memories are gone when the process exits. To use Postgres later, install a driver, delete ${shown} and run mnemocyte init again.`,
				);
			} else {
				out.push(
					`Found ${choice.found.join(", ")} in package.json: using ${choice.label}.`,
				);
			}
			if (choice.found.includes("drizzle-orm")) {
				out.push(
					`No Drizzle client to import in ${CLIENT_PLACES}, so ${shown} creates one. To use yours, run mnemocyte init --db <file>.`,
				);
			}
			content = renderMemoryFile({ driver: choice.driver, ...options });
		}
		if (embedder.note !== undefined) {
			out.push(embedder.note);
		}
		if (dryRun) {
			out.push(`Would write ${shown}:`, "", content);
			written = shown;
		} else {
			await mkdir(dirname(file), { recursive: true });
			if (await createFile(file, content)) {
				out.push(
					`Wrote ${shown}${client === undefined ? "" : ", which imports it."}`,
				);
				written = shown;
			} else {
				out.push(`${shown} exists, left as is.`);
				choice = undefined;
				client = undefined;
			}
		}
	}

	// The env file, for an embedder that reads a key from it. A local server
	// needs none, so no file is touched. With `.env.local`, as in a Next.js
	// app, the key goes there. A variable either file defines counts: the
	// CLI reads `.env.local` first and keeps the first value, so an empty
	// line there would hide a key in `.env`.
	const localContent = await readText(join(cwd, ".env.local"));
	const baseContent = await readText(join(cwd, ".env"));
	const localEnv = localContent === null ? {} : parseEnv(localContent);
	const baseEnv = baseContent === null ? {} : parseEnv(baseContent);
	const env = { ...baseEnv, ...localEnv };
	const target = localContent === null ? ".env" : ".env.local";
	const targetContent = target === ".env.local" ? localContent : baseContent;
	const variable = embedder.envVariable;
	const definedIn =
		variable === undefined
			? undefined
			: localEnv[variable] !== undefined
				? ".env.local"
				: baseEnv[variable] !== undefined
					? ".env"
					: undefined;
	const change: EnvChange =
		variable === undefined || definedIn !== undefined
			? { action: "none" }
			: planEnvChange(targetContent, variable);
	if (variable !== undefined && definedIn !== undefined) {
		out.push(`${definedIn} already defines ${variable}, left as is.`);
	} else if (variable !== undefined && change.action !== "none") {
		const targetPath = join(cwd, target);
		const verb = change.action === "create" ? `create ${target} with` : "add";
		if (dryRun) {
			out.push(
				`Would ${verb} ${variable}=${change.action === "append" ? ` to ${target}` : ""}`,
			);
		} else {
			if (change.action === "create") {
				await writeFile(targetPath, change.text, { flag: "wx" });
				out.push(`Created ${target} with ${variable}=`);
			} else {
				await appendFile(targetPath, change.text);
				out.push(`Added ${variable}= to ${target}`);
			}
		}
		const gitignore = await readText(join(cwd, ".gitignore"));
		if (gitignore === null || !ignoresEnvFile(gitignore, target)) {
			out.push(
				`note: .gitignore does not list ${target}; add it before you put a key in the file.`,
			);
		}
	}

	if (written !== undefined && pkg.type !== "module") {
		// A CommonJS next.config.js stops loading under "type": "module", and
		// Next.js does not take next.config.cjs.
		const nextConfig =
			nextApp && (await isFile(join(cwd, "next.config.js")))
				? " First rename next.config.js to next.config.mjs (or .ts) if it uses module.exports, and any other .js config that does to .cjs."
				: "";
		out.push(
			`note: package.json has no "type": "module". Node still loads ${written} as an ES module but warns on every run; set it with: npm pkg set type=module.${nextConfig}`,
		);
	}

	// What is left for the user.
	if (choice !== undefined && choice.missing.length > 0) {
		next.push(`Install: ${await installCommand(cwd, choice.missing)}`);
	}
	if (
		variable !== undefined &&
		embedder.keyName !== undefined &&
		!env[variable]
	) {
		next.push(
			`Put your ${embedder.keyName} after ${variable}= in ${definedIn ?? target}`,
		);
	}
	if (choice !== undefined && usesDatabaseUrl(choice.driver)) {
		if (env.DATABASE_URL === undefined) {
			next.push(`Add DATABASE_URL=postgres://… to ${target}`);
		}
	}
	// The variables the client's file reads, when neither env file has them.
	for (const name of client?.variables ?? []) {
		if (env[name] === undefined && name !== "NODE_ENV") {
			next.push(
				`Add ${name}=… to ${target} (${displayPath(cwd, client?.file ?? "")} reads it)`,
			);
		}
	}
	if (
		(choice !== undefined || client !== undefined) &&
		embedder.next !== undefined
	) {
		next.push(embedder.next);
	}
	if (
		client !== undefined ||
		(choice !== undefined && choice.driver !== "in-memory")
	) {
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

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

function describeClient(cwd: string, client: AppClient): string {
	const where = displayPath(cwd, client.file);
	return client.name === "default"
		? `the default export of ${where}`
		: `${client.name} in ${where}`;
}

/**
 * The app's one Drizzle client in the places `init` reads, or undefined.
 * Clients over drivers Mnemocyte does not take are skipped with a line; a
 * file that creates a client without exporting it gets a line too.
 *
 * @throws {CliError} With exit code 2 when there are several, so `--db`
 * picks one rather than `init` guessing which database memories go to.
 */
async function findAppClient(
	cwd: string,
	out: string[],
): Promise<AppClient | undefined> {
	const search = await findDrizzleClients(cwd);
	const usable = search.clients.filter((client) => client.label !== undefined);
	for (const client of search.clients) {
		if (client.label === undefined) {
			out.push(
				`Skipped ${describeClient(cwd, client)}: drizzle-orm/${client.driver} is not a driver Mnemocyte supports.`,
			);
		}
	}
	if (usable.length > 1) {
		throw new CliError(
			`Found ${usable.length} Drizzle clients: ${usable.map((client) => describeClient(cwd, client)).join(", ")}. Name the file of the one memories should use: mnemocyte init --db <file>.`,
			EXIT_USAGE,
		);
	}
	if (usable[0] !== undefined) {
		return usable[0];
	}
	for (const file of search.unexported) {
		out.push(
			`${displayPath(cwd, file)} creates a Drizzle client but does not export it.`,
		);
	}
	return undefined;
}

/**
 * The client in the file `--db` names: its only `drizzle(...)` export, else
 * the one named `db`.
 *
 * @throws {CliError} With exit code 2 when the file cannot be read, exports
 * no client, exports several and none is `db`, or uses a driver Mnemocyte
 * does not take.
 */
async function clientFromFlag(cwd: string, path: string): Promise<AppClient> {
	const file = resolve(cwd, path);
	const result = await readClientFile(file);
	const shown = displayPath(cwd, file);
	if (result === null) {
		throw new CliError(
			`--db ${path} is not a file. Name the file that exports the client.`,
			EXIT_USAGE,
		);
	}
	if (result.clients.length === 0) {
		throw new CliError(
			`${shown} exports no drizzle(...) client that init can find. Export it, as in export const db = drizzle(...), or write the memory file by hand.`,
			EXIT_USAGE,
		);
	}
	const client =
		result.clients.length === 1
			? result.clients[0]
			: result.clients.find((entry) => entry.name === "db");
	if (client === undefined) {
		throw new CliError(
			`${shown} exports several Drizzle clients (${result.clients.map((entry) => entry.name).join(", ")}) and none is named db. Write the memory file by hand.`,
			EXIT_USAGE,
		);
	}
	if (client.label === undefined) {
		throw new CliError(
			`${shown} uses drizzle-orm/${client.driver}, which Mnemocyte does not support. Supported: ${SUPPORTED_DRIVER_NAMES.map((name) => `drizzle-orm/${name}`).join(", ")}.`,
			EXIT_USAGE,
		);
	}
	return client;
}

/** The TypeScript `module` values whose ES modules need import extensions. */
const NODE_MODULES: ReadonlySet<string> = new Set([
	"node16",
	"node18",
	"node20",
	"nodenext",
]);

/**
 * Whether the memory file's import of the client needs an extension: in an
 * ES module package whose tsconfig sets `module` or `moduleResolution` to a
 * Node mode, or, without a tsconfig, outside Next.js, where Node itself
 * runs the import. Next.js's tsconfig uses `bundler` resolution.
 */
async function usesImportExtensions(
	cwd: string,
	pkg: PackageJson,
	nextApp: boolean,
): Promise<boolean> {
	if (pkg.type !== "module") {
		return false;
	}
	const tsconfig = findTsconfig(cwd);
	if (tsconfig === null) {
		return !nextApp;
	}
	const { module, moduleResolution } = loadModuleOptions(tsconfig);
	return [module, moduleResolution].some(
		(value) => value !== undefined && NODE_MODULES.has(value),
	);
}
