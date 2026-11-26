import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";

// What `init` reads of the app itself: whether it is a Next.js app, where
// its memory file goes, and the Drizzle client it already has. Detection
// reads text and runs nothing (ARCHITECTURE decision 98).

/**
 * The `drizzle-orm/<driver>` subpaths whose `db` Mnemocyte takes as
 * `store`, with how the output names each.
 */
const SUPPORTED_DRIVERS: Readonly<Record<string, string>> = {
	"postgres-js": "Drizzle on postgres.js",
	"node-postgres": "Drizzle on node-postgres",
	pglite: "Drizzle on PGlite",
	"neon-http": "Drizzle on Neon's HTTP driver",
	"neon-serverless": "Drizzle on Neon's Pool",
	libsql: "Drizzle on libSQL",
};

/** The libSQL subpaths of drizzle-orm, each over `@libsql/client`. */
const LIBSQL_SUBPATHS: ReadonlySet<string> = new Set([
	"http",
	"node",
	"sqlite3",
	"wasm",
	"web",
	"ws",
]);

/** How the output names a supported driver subpath, or undefined. */
export function driverLabel(driver: string): string | undefined {
	const [base = "", sub] = driver.split("/", 2);
	if (base === "libsql" && sub !== undefined) {
		return LIBSQL_SUBPATHS.has(sub) ? SUPPORTED_DRIVERS.libsql : undefined;
	}
	return driver.includes("/") ? undefined : SUPPORTED_DRIVERS[driver];
}

/** The supported subpaths, for messages. */
export const SUPPORTED_DRIVER_NAMES: readonly string[] =
	Object.keys(SUPPORTED_DRIVERS);

/**
 * Folders whose files `init` reads, every file directly inside: the
 * places apps and their templates keep the Drizzle client (`src/server/db`
 * is create-t3-app's).
 */
export const CLIENT_DIRECTORIES: readonly string[] = [
	"src/db",
	"db",
	"src/lib/db",
	"lib/db",
	"src/server/db",
	"server/db",
];

/** Folders where `db.*` and `drizzle.*` are read; the root takes `db.*` only. */
const CLIENT_FILE_DIRECTORIES: readonly string[] = [
	"src",
	"src/lib",
	"lib",
	"src/server",
	"server",
];

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
	".ts",
	".mts",
	".js",
	".mjs",
]);

/** Where `init` looks, as the output lists it. */
export const CLIENT_PLACES: string = [
	...CLIENT_DIRECTORIES.map((directory) => `${directory}/`),
	...CLIENT_FILE_DIRECTORIES.map((directory) => `${directory}/{db,drizzle}.*`),
	"db.*",
].join(", ");

/** A `drizzle(...)` value a file exports. */
export interface DrizzleExport {
	/** The export's name, `default` for a default export. */
	readonly name: string;
	/** The `drizzle-orm/<driver>` subpath `drizzle` was imported from. */
	readonly driver: string;
}

/** What `readDrizzleSource` finds in one file's text. */
export interface DrizzleSource {
	readonly exports: readonly DrizzleExport[];
	/** Whether the file calls `drizzle(...)` without exporting the result. */
	readonly unexported: boolean;
	/** The `process.env` variables the file reads, in order. */
	readonly variables: readonly string[];
	/** Whether the file imports PGlite's pgvector extension. */
	readonly pgvector: boolean;
}

/**
 * The text with comments replaced by spaces (newlines kept), so a
 * commented-out `export const db = drizzle(...)` does not count. Strings
 * and template literals are copied whole, so `"https://…"` survives.
 */
export function stripComments(text: string): string {
	let out = "";
	for (let index = 0; index < text.length; ) {
		const char = text[index] ?? "";
		if (char === '"' || char === "'" || char === "`") {
			let end = index + 1;
			while (end < text.length && text[end] !== char) {
				end += text[end] === "\\" ? 2 : 1;
			}
			out += text.slice(index, end + 1);
			index = end + 1;
		} else if (text.startsWith("//", index)) {
			const newline = text.indexOf("\n", index);
			index = newline === -1 ? text.length : newline;
		} else if (text.startsWith("/*", index)) {
			const close = text.indexOf("*/", index + 2);
			const end = close === -1 ? text.length : close + 2;
			out += text.slice(index, end).replace(/[^\n]/g, " ");
			index = end;
		} else {
			out += char;
			index += 1;
		}
	}
	return out;
}

/**
 * Characters that continue an expression when a line starts with them, so
 * a newline before them does not end the statement.
 */
const CONTINUATION = /^[.?:)\]}+\-*/|&=,<>]/;

/**
 * Split comment-free text into its top-level statements: a `;` outside
 * brackets ends one, and so does a line break outside brackets when the
 * next line starts at column 0 with something other than a continuation.
 */
export function topLevelStatements(text: string): string[] {
	const statements: string[] = [];
	let depth = 0;
	let start = 0;
	const push = (end: number) => {
		const statement = text.slice(start, end).trim();
		if (statement !== "") {
			statements.push(statement);
		}
	};
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index] ?? "";
		if (char === '"' || char === "'" || char === "`") {
			let end = index + 1;
			while (end < text.length && text[end] !== char) {
				end += text[end] === "\\" ? 2 : 1;
			}
			index = end;
		} else if (char === "(" || char === "[" || char === "{") {
			depth += 1;
		} else if (char === ")" || char === "]" || char === "}") {
			depth = Math.max(0, depth - 1);
		} else if (depth === 0 && char === ";") {
			push(index);
			start = index + 1;
		} else if (depth === 0 && char === "\n") {
			const next = text[index + 1] ?? "";
			if (next !== "" && !/\s/.test(next) && !CONTINUATION.test(next)) {
				push(index);
				start = index + 1;
			}
		}
	}
	push(text.length);
	return statements;
}

const IDENTIFIER = "[A-Za-z_$][\\w$]*";

/**
 * Text before a call that puts the call inside a function: `() => drizzle()`,
 * `cache(() => drizzle())` or `function () { return drizzle(); }` return a
 * client when called, and the value itself is not one.
 */
const FUNCTION_BEFORE = /=>|\bfunction\b/;

function escapeRegExp(text: string): string {
	return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * The `drizzle(...)` values a module exports, from its text alone: `drizzle`
 * imported from `drizzle-orm/<driver>` and called in the initializer of
 * `export const|let|var NAME`, `export default`, or a declaration exported
 * later with `export { NAME }` or `export { NAME as OTHER }`. Functions that
 * return a client and re-exports from other files do not count.
 */
export function readDrizzleSource(text: string): DrizzleSource {
	const code = stripComments(text);
	// The local name of each `drizzle` import, with its subpath.
	const imports = new Map<string, string>();
	for (const match of code.matchAll(
		/\bimport\s*\{([^}]*)\}\s*from\s*["']drizzle-orm\/([^"']+)["']/g,
	)) {
		for (const part of (match[1] ?? "").split(",")) {
			const names = part.trim().split(/\s+as\s+/);
			if (names[0] === "drizzle") {
				imports.set(names[1] ?? "drizzle", match[2] ?? "");
			}
		}
	}

	const variables = [
		...new Set(
			[
				...code.matchAll(
					/\bprocess\.env(?:\.([A-Za-z_][\w]*)|\[\s*["']([A-Za-z_][\w]*)["']\s*\])/g,
				),
			].map((match) => match[1] ?? match[2] ?? ""),
		),
	];
	const pgvector = /@electric-sql\/pglite(?:-pgvector|\/vector)["']/.test(code);
	if (imports.size === 0) {
		return { exports: [], unexported: false, variables, pgvector };
	}

	/** The subpath whose `drizzle` the initializer calls, or undefined. */
	const callsDrizzle = (initializer: string): string | undefined => {
		for (const [local, driver] of imports) {
			const call = new RegExp(
				`(^|[^\\w$.])${escapeRegExp(local)}\\s*(<[^>]*>)?\\s*\\(`,
			).exec(initializer);
			if (call !== null) {
				return FUNCTION_BEFORE.test(initializer.slice(0, call.index))
					? undefined
					: driver;
			}
		}
		return undefined;
	};

	const exports: DrizzleExport[] = [];
	const locals = new Map<string, string>();
	// A local exported twice (`export { db }` and `export default db`) is one
	// client; the named export wins.
	const exportedLocals = new Map<string, DrizzleExport>();
	const exportLocal = (local: string, name: string, driver: string) => {
		const earlier = exportedLocals.get(local);
		const entry = { name, driver };
		if (earlier === undefined) {
			exportedLocals.set(local, entry);
			exports.push(entry);
		} else if (earlier.name === "default" && name !== "default") {
			exportedLocals.set(local, entry);
			exports.splice(exports.indexOf(earlier), 1, entry);
		}
	};
	let calls = 0;
	const declaration = new RegExp(
		`^(export\\s+)?(?:const|let|var)\\s+(${IDENTIFIER})\\s*(?::[^=]*)?=\\s*([\\s\\S]*)$`,
	);
	for (const statement of topLevelStatements(code)) {
		const declared = declaration.exec(statement);
		if (declared !== null) {
			const driver = callsDrizzle(declared[3] ?? "");
			if (driver !== undefined) {
				calls += 1;
				const name = declared[2] ?? "";
				if (declared[1] !== undefined) {
					exports.push({ name, driver });
				} else {
					locals.set(name, driver);
				}
			}
			continue;
		}
		const defaulted = /^export\s+default\s+([\s\S]*)$/.exec(statement);
		if (defaulted !== null) {
			const value = (defaulted[1] ?? "").trim();
			const local = locals.get(value);
			if (local !== undefined) {
				exportLocal(value, "default", local);
			} else {
				const driver = callsDrizzle(value);
				if (driver !== undefined) {
					calls += 1;
					exports.push({ name: "default", driver });
				}
			}
			continue;
		}
		const list = /^export\s*\{([^}]*)\}$/.exec(statement);
		if (list !== null) {
			for (const part of (list[1] ?? "").split(",")) {
				const [local = "", exported] = part.trim().split(/\s+as\s+/);
				const driver = locals.get(local);
				if (driver !== undefined) {
					exportLocal(local, exported ?? local, driver);
				}
			}
		}
	}
	return {
		exports,
		unexported: calls > 0 && exports.length === 0,
		variables,
		pgvector,
	};
}

/** One exported Drizzle client in the app. */
export interface AppClient extends DrizzleExport {
	/** The file, absolute. */
	readonly file: string;
	/** How the output names the driver, or undefined when unsupported. */
	readonly label: string | undefined;
	readonly variables: readonly string[];
	readonly pgvector: boolean;
}

/** Read one file as a client module; null when it cannot be read. */
export async function readClientFile(file: string): Promise<{
	readonly clients: readonly AppClient[];
	readonly unexported: boolean;
} | null> {
	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch {
		return null;
	}
	const source = readDrizzleSource(text);
	return {
		clients: source.exports.map((entry) => ({
			...entry,
			file,
			label: driverLabel(entry.driver),
			variables: source.variables,
			pgvector: source.pgvector,
		})),
		unexported: source.unexported,
	};
}

function isSourceFile(name: string): boolean {
	return (
		SOURCE_EXTENSIONS.has(extname(name)) &&
		!/\.d\.m?ts$/.test(name) &&
		!/\.(test|spec)\.m?[jt]s$/.test(name)
	);
}

async function filesIn(directory: string): Promise<string[]> {
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && isSourceFile(entry.name))
			.map((entry) => join(directory, entry.name))
			.sort();
	} catch {
		return [];
	}
}

/** The files `init` reads, in a fixed order, each once. */
export async function clientCandidates(cwd: string): Promise<string[]> {
	const files: string[] = [];
	for (const directory of CLIENT_DIRECTORIES) {
		files.push(...(await filesIn(join(cwd, directory))));
	}
	for (const directory of [...CLIENT_FILE_DIRECTORIES, ""]) {
		const names = directory === "" ? ["db"] : ["db", "drizzle"];
		for (const file of await filesIn(join(cwd, directory))) {
			const name = basename(file, extname(file));
			if (names.includes(name)) {
				files.push(file);
			}
		}
	}
	return [...new Set(files)];
}

/** What `findDrizzleClients` finds in the app. */
export interface ClientSearch {
	readonly clients: readonly AppClient[];
	/** Files that call `drizzle(...)` but export no client. */
	readonly unexported: readonly string[];
}

/** Every exported Drizzle client in the places `init` reads. */
export async function findDrizzleClients(cwd: string): Promise<ClientSearch> {
	const clients: AppClient[] = [];
	const unexported: string[] = [];
	for (const file of await clientCandidates(cwd)) {
		const result = await readClientFile(file);
		if (result === null) {
			continue;
		}
		clients.push(...result.clients);
		if (result.unexported) {
			unexported.push(file);
		}
	}
	return { clients, unexported };
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The folder a Next.js app's memory file goes in: `lib` next to a root
 * `app` or `pages` (Next.js then ignores `src/app` and `src/pages`),
 * `src/lib` next to `src/app` or `src/pages`, else `src/lib` when there is
 * a `src` folder and `lib` without one. Both are folders the CLI searches.
 */
export async function nextMemoryFolder(cwd: string): Promise<string> {
	for (const folder of ["app", "pages"]) {
		if (await isDirectory(join(cwd, folder))) {
			return "lib";
		}
	}
	for (const folder of ["src/app", "src/pages", "src"]) {
		if (await isDirectory(join(cwd, folder))) {
			return "src/lib";
		}
	}
	return "lib";
}

/**
 * The relative specifier that imports `to` from a file in `fromDirectory`.
 * With `extensions`, `.ts` becomes `.js` and `.mts` becomes `.mjs`, as
 * TypeScript wants in an ES module under `node16` or `nodenext`; without,
 * the extension goes and so does a trailing `/index`.
 */
export function importSpecifier(input: {
	fromDirectory: string;
	to: string;
	extensions: boolean;
}): string {
	let path = relative(input.fromDirectory, input.to).replaceAll("\\", "/");
	const extension = extname(path);
	if (input.extensions) {
		if (extension === ".ts") {
			path = `${path.slice(0, -3)}.js`;
		} else if (extension === ".mts") {
			path = `${path.slice(0, -4)}.mjs`;
		}
	} else {
		path = path.slice(0, path.length - extension.length);
		if (path === "index") {
			path = ".";
		} else if (path.endsWith("/index")) {
			path = path.slice(0, -"/index".length);
		}
	}
	return path.startsWith(".") ? path : `./${path}`;
}

/** Names the memory file declares itself, which an import must not take. */
const TAKEN_NAMES: ReadonlySet<string> = new Set([
	"memory",
	"createMemory",
	"openaiEmbedder",
	"openaiCompatibleEmbedder",
	"openrouterEmbedder",
]);

/** How the memory file imports a client and names it. */
export interface ClientImport {
	/** The import line. */
	readonly line: string;
	/** The local name the `store` property uses. */
	readonly local: string;
}

/** The import of `exportName` from `specifier`, renamed to `db` when taken. */
export function clientImport(
	exportName: string,
	specifier: string,
): ClientImport {
	const from = JSON.stringify(specifier);
	if (exportName === "default") {
		return { line: `import db from ${from};`, local: "db" };
	}
	if (TAKEN_NAMES.has(exportName)) {
		return {
			line: `import { ${exportName} as db } from ${from};`,
			local: "db",
		};
	}
	return { line: `import { ${exportName} } from ${from};`, local: exportName };
}

/** A path relative to the project, with `/`, as the output shows it. */
export function displayPath(cwd: string, file: string): string {
	return relative(cwd, file).replaceAll("\\", "/") || file;
}
