import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** One `compilerOptions.paths` entry: `prefix*suffix`, or an exact name. */
interface PathPattern {
	readonly prefix: string;
	/** `null` for a pattern without `*`, which must match exactly. */
	readonly suffix: string | null;
	readonly targets: readonly string[];
}

/** The `paths` of a tsconfig and the folder its targets are relative to. */
export interface PathMapping {
	readonly base: string;
	readonly patterns: readonly PathPattern[];
}

interface RawOptions {
	baseUrl?: string;
	paths?: PathPattern[];
	pathsDirectory?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFile(path: string): boolean {
	return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** Index just past the string literal that starts at `start`. */
function stringEnd(text: string, start: number): number {
	let index = start + 1;
	while (index < text.length) {
		if (text[index] === "\\") {
			index += 2;
		} else if (text[index] === '"') {
			return index + 1;
		} else {
			index += 1;
		}
	}
	return text.length;
}

const BEFORE_CLOSING_BRACKET = /\s*[}\]]/y;

/**
 * Parse JSON with comments and trailing commas, which `tsconfig.json`
 * allows and `JSON.parse` rejects. String literals are copied untouched, so
 * a `//` or a comma inside one survives.
 *
 * @throws {SyntaxError} When what is left is not JSON.
 */
export function parseJsonc(text: string): unknown {
	let withoutComments = "";
	for (let index = 0; index < text.length; ) {
		if (text[index] === '"') {
			const end = stringEnd(text, index);
			withoutComments += text.slice(index, end);
			index = end;
		} else if (text.startsWith("//", index)) {
			const newline = text.indexOf("\n", index);
			index = newline === -1 ? text.length : newline;
		} else if (text.startsWith("/*", index)) {
			const close = text.indexOf("*/", index + 2);
			index = close === -1 ? text.length : close + 2;
		} else {
			withoutComments += text[index];
			index += 1;
		}
	}

	let json = "";
	for (let index = 0; index < withoutComments.length; ) {
		if (withoutComments[index] === '"') {
			const end = stringEnd(withoutComments, index);
			json += withoutComments.slice(index, end);
			index = end;
			continue;
		}
		if (withoutComments[index] === ",") {
			BEFORE_CLOSING_BRACKET.lastIndex = index + 1;
			if (BEFORE_CLOSING_BRACKET.test(withoutComments)) {
				index += 1;
				continue;
			}
		}
		json += withoutComments[index];
		index += 1;
	}
	// A UTF-8 byte order mark is not JSON either.
	return JSON.parse(json.replace(/^﻿/, ""));
}

/** The file an `extends` entry names, or null when it cannot be found. */
function resolveExtends(entry: string, from: string): string | null {
	if (entry.startsWith("./") || entry.startsWith("../") || isAbsolute(entry)) {
		const path = resolve(dirname(from), entry);
		// "./tsconfig.base" means tsconfig.base.json: a name's last dot is not
		// necessarily an extension, so both spellings are tried.
		return [path, `${path}.json`].find(isFile) ?? null;
	}
	// A package, such as "@tsconfig/node22/tsconfig.json".
	const require = createRequire(from);
	for (const specifier of [entry, `${entry}.json`, `${entry}/tsconfig.json`]) {
		try {
			return require.resolve(specifier);
		} catch {
			// Try the next spelling.
		}
	}
	return null;
}

function toPatterns(paths: Record<string, unknown>): PathPattern[] {
	const patterns: PathPattern[] = [];
	for (const [key, value] of Object.entries(paths)) {
		if (!Array.isArray(value)) {
			continue;
		}
		const targets = value.filter(
			(target): target is string => typeof target === "string",
		);
		const star = key.indexOf("*");
		patterns.push(
			star === -1
				? { prefix: key, suffix: null, targets }
				: { prefix: key.slice(0, star), suffix: key.slice(star + 1), targets },
		);
	}
	return patterns;
}

/**
 * `baseUrl` and `paths` of a tsconfig, with what it `extends` underneath.
 * As in TypeScript, a config's own value replaces the inherited one whole.
 * A file that cannot be read or parsed contributes nothing: the CLI then
 * resolves no aliases, and Node reports the import it could not find.
 */
function readOptions(file: string, seen: Set<string>): RawOptions {
	if (seen.has(file)) {
		return {};
	}
	seen.add(file);
	let config: unknown;
	try {
		config = parseJsonc(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
	if (!isRecord(config)) {
		return {};
	}

	let options: RawOptions = {};
	const parents =
		typeof config.extends === "string"
			? [config.extends]
			: Array.isArray(config.extends)
				? config.extends.filter(
						(entry): entry is string => typeof entry === "string",
					)
				: [];
	for (const entry of parents) {
		const parent = resolveExtends(entry, file);
		if (parent !== null) {
			options = { ...options, ...readOptions(parent, seen) };
		}
	}

	const compilerOptions = config.compilerOptions;
	if (isRecord(compilerOptions)) {
		if (typeof compilerOptions.baseUrl === "string") {
			options.baseUrl = resolve(dirname(file), compilerOptions.baseUrl);
		}
		if (isRecord(compilerOptions.paths)) {
			options.paths = toPatterns(compilerOptions.paths);
			options.pathsDirectory = dirname(file);
		}
	}
	return options;
}

/**
 * The `paths` mapping of a tsconfig file, or null when it (and what it
 * extends) defines none. Targets are relative to `baseUrl` when one is set,
 * otherwise to the folder of the config that defines `paths`.
 */
export function loadPathMapping(tsconfigPath: string): PathMapping | null {
	const options = readOptions(tsconfigPath, new Set());
	if (options.paths === undefined || options.pathsDirectory === undefined) {
		return null;
	}
	return {
		base: options.baseUrl ?? options.pathsDirectory,
		patterns: options.paths,
	};
}

/** The nearest `tsconfig.json` in `directory` or a folder above it. */
export function findTsconfig(directory: string): string | null {
	for (let current = directory; ; ) {
		const candidate = join(current, "tsconfig.json");
		if (isFile(candidate)) {
			return candidate;
		}
		const parent = dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}

/**
 * The absolute paths `specifier` maps to, in order, or none when no pattern
 * matches. An exact pattern wins; among wildcard patterns the longest
 * prefix wins, as in TypeScript.
 */
export function mapSpecifier(
	specifier: string,
	mapping: PathMapping,
): string[] {
	let best: PathPattern | undefined;
	let matched = "";
	for (const pattern of mapping.patterns) {
		if (pattern.suffix === null) {
			if (pattern.prefix === specifier) {
				best = pattern;
				matched = "";
				break;
			}
			continue;
		}
		if (
			specifier.length >= pattern.prefix.length + pattern.suffix.length &&
			specifier.startsWith(pattern.prefix) &&
			specifier.endsWith(pattern.suffix) &&
			(best === undefined || pattern.prefix.length > best.prefix.length)
		) {
			best = pattern;
			matched = specifier.slice(
				pattern.prefix.length,
				specifier.length - pattern.suffix.length,
			);
		}
	}
	if (best === undefined) {
		return [];
	}
	return best.targets.map((target) =>
		resolve(mapping.base, target.replace("*", matched)),
	);
}
