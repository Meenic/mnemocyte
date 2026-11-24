import { statSync } from "node:fs";
import { type ResolveHookSync, registerHooks } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	findTsconfig,
	loadPathMapping,
	mapSpecifier,
	type PathMapping,
} from "./tsconfig.js";

/** The TypeScript source a JavaScript extension in an import stands for. */
const SOURCE_EXTENSION: Readonly<Record<string, string>> = {
	".js": ".ts",
	".mjs": ".mts",
	".cjs": ".cts",
};

const APPENDED_EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const INDEX_FILES = ["index.ts", "index.mts", "index.js", "index.mjs"];

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * The files an import of `path` can mean, in the order tried: the path
 * itself, the `.ts` behind a `.js` name (how TypeScript projects with
 * `module: nodenext` write imports), then an added extension and a folder's
 * index file for an extensionless import.
 */
export function importCandidates(path: string): string[] {
	const extension = extname(path);
	const source = SOURCE_EXTENSION[extension];
	if (source !== undefined) {
		return [path, `${path.slice(0, -extension.length)}${source}`];
	}
	return [
		path,
		...APPENDED_EXTENSIONS.map((appended) => `${path}${appended}`),
		...INDEX_FILES.map((index) => join(path, index)),
	];
}

// Keyed by the importing file's folder. `null` is a folder without a
// tsconfig, or with one that has no `paths`.
const mappings = new Map<string, PathMapping | null>();

function pathMappingFor(directory: string): PathMapping | null {
	let mapping = mappings.get(directory);
	if (mapping === undefined) {
		const tsconfig = findTsconfig(directory);
		mapping = tsconfig === null ? null : loadPathMapping(tsconfig);
		mappings.set(directory, mapping);
	}
	return mapping;
}

/**
 * The file an import in `importer` means when Node's own resolution found
 * nothing, or null. Relative imports get the candidates of
 * {@link importCandidates}; any other specifier goes through the `paths` of
 * the nearest `tsconfig.json`.
 */
export function resolveAppImport(
	specifier: string,
	importer: string,
): string | null {
	const directory = dirname(importer);
	let targets: string[];
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		targets = [resolve(directory, specifier)];
	} else if (specifier.startsWith("node:")) {
		return null;
	} else {
		const mapping = pathMappingFor(directory);
		targets = mapping === null ? [] : mapSpecifier(specifier, mapping);
	}
	for (const target of targets) {
		const found = importCandidates(target).find(isFile);
		if (found !== undefined) {
			return found;
		}
	}
	return null;
}

/**
 * The file `server-only` resolves to, next to the bundled loader: each
 * bin's build writes an empty `dist/server-only.cjs` (the
 * `server-only-stub` plugin in its `tsdown.config.ts`). React's marker
 * package throws at import outside the `react-server` condition, and an
 * app's memory file may import it (Next.js's convention for server code).
 * The bins are server code, so it loads as nothing instead (decisions 81
 * and 97). A real file, because Node 22.18 skips resolve hooks for
 * `require()` in CommonJS loaded by `import` once any load hook is
 * registered, and `require()` cannot load a `data:` URL.
 */
export const SERVER_ONLY_FILE = "server-only.cjs";

/**
 * The resolve hook. `server-only`, the exact bare specifier, maps to
 * {@link SERVER_ONLY_FILE} before Node resolves it, from any importer, so
 * an installed copy is not loaded either. Everything else asks Node first
 * and looks further only when Node fails, for an importer that is a file
 * outside `node_modules`.
 */
export const resolveHook: ResolveHookSync = (
	specifier,
	context,
	nextResolve,
) => {
	if (specifier === "server-only") {
		const url = new URL(SERVER_ONLY_FILE, import.meta.url).href;
		return { url, shortCircuit: true };
	}
	try {
		return nextResolve(specifier, context);
	} catch (error) {
		const parent = context.parentURL;
		if (parent === undefined || !parent.startsWith("file:")) {
			throw error;
		}
		const importer = fileURLToPath(parent);
		if (importer.split(/[\\/]/).includes("node_modules")) {
			throw error;
		}
		const found = resolveAppImport(specifier, importer);
		if (found === null) {
			throw error;
		}
		return nextResolve(pathToFileURL(found).href, context);
	}
};

let registered = false;

/**
 * Teach this process the imports a TypeScript app writes that Node's type
 * stripping does not resolve: extensionless and `.js`-for-`.ts` relative
 * imports, and tsconfig `paths`; and load `server-only` as an empty module.
 *
 * `module.registerHooks` installs a synchronous resolve hook on the current
 * thread, for `import` and `require` alike (`module.register`, the
 * asynchronous one, is deprecated from Node 26). Apart from `server-only`,
 * the resolve hook asks Node first and only looks further when Node fails,
 * so anything Node resolves, every other package included, is untouched.
 * Registering twice does nothing.
 */
export function registerAppResolver(): void {
	if (registered) {
		return;
	}
	registered = true;
	registerHooks({ resolve: resolveHook });
}
