import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { findMemoryFile, locateMemoryFile } from "../../src/cli/memory-file.js";
import {
	importCandidates,
	resolveAppImport,
} from "../../src/cli/resolve-hook.js";
import {
	findTsconfig,
	loadPathMapping,
	mapSpecifier,
	parseJsonc,
} from "../../src/cli/tsconfig.js";

let root: string;

beforeAll(async () => {
	root = await mkdtemp(join(tmpdir(), "mnemocyte-cli-unit-"));
});

afterAll(async () => {
	await rm(root, { recursive: true, force: true });
});

async function write(
	directory: string,
	files: Record<string, string>,
): Promise<string> {
	const base = join(root, directory);
	for (const [name, content] of Object.entries(files)) {
		const path = join(base, name);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, content, "utf8");
	}
	return base;
}

describe("parseJsonc", () => {
	test("drops comments and trailing commas, and keeps strings whole", () => {
		expect(
			parseJsonc(`﻿{
				// line comment
				"url": "https://example.com/a,]", /* block
				comment */
				"escaped": "quote \\" // not a comment",
				"list": [1, 2, ],
				"nested": { "a": 1, },
			}`),
		).toEqual({
			url: "https://example.com/a,]",
			escaped: 'quote " // not a comment',
			list: [1, 2],
			nested: { a: 1 },
		});
	});

	test("throws on what is not JSON", () => {
		expect(() => parseJsonc("{ paths: }")).toThrow(SyntaxError);
	});
});

describe("tsconfig paths", () => {
	test("maps exact names and the longest wildcard prefix", () => {
		const mapping = {
			base: join(root, "project"),
			patterns: [
				{ prefix: "@/", suffix: "", targets: ["./src/*"] },
				{ prefix: "@/db/", suffix: "", targets: ["./database/*", "./db/*"] },
				{ prefix: "config", suffix: null, targets: ["./config/index.ts"] },
				{ prefix: "~", suffix: ".server", targets: ["./server/*.ts"] },
			],
		};
		expect(mapSpecifier("@/lib/memory", mapping)).toEqual([
			join(root, "project", "src", "lib", "memory"),
		]);
		expect(mapSpecifier("@/db/client", mapping)).toEqual([
			join(root, "project", "database", "client"),
			join(root, "project", "db", "client"),
		]);
		expect(mapSpecifier("config", mapping)).toEqual([
			join(root, "project", "config", "index.ts"),
		]);
		expect(mapSpecifier("~auth.server", mapping)).toEqual([
			join(root, "project", "server", "auth.ts"),
		]);
		expect(mapSpecifier("config/extra", mapping)).toEqual([]);
		expect(mapSpecifier("postgres", mapping)).toEqual([]);
	});

	test("reads paths through extends, relative to baseUrl or the defining file", async () => {
		const base = await write("extends", {
			"configs/base.json":
				'{ "compilerOptions": { "paths": { "#/*": ["./shared/*"] } } }',
			"app/tsconfig.json": '{ "extends": "../configs/base" }',
			"own/tsconfig.json": `{
				"extends": ["../configs/base.json"],
				"compilerOptions": { "baseUrl": "./src", "paths": { "@/*": ["./*"] } },
			}`,
			"loop/tsconfig.json": '{ "extends": "./tsconfig.json" }',
			"broken/tsconfig.json": "{ not json",
		});
		// Inherited paths stay relative to the config that defines them.
		const inherited = loadPathMapping(join(base, "app", "tsconfig.json"));
		expect(inherited?.base).toBe(join(base, "configs"));
		expect(
			mapSpecifier("#/util", inherited ?? { base: "", patterns: [] }),
		).toEqual([join(base, "configs", "shared", "util")]);
		// A config's own paths replace the inherited ones; baseUrl is the base.
		const own = loadPathMapping(join(base, "own", "tsconfig.json"));
		expect(own?.base).toBe(join(base, "own", "src"));
		expect(own?.patterns.map((pattern) => pattern.prefix)).toEqual(["@/"]);

		expect(loadPathMapping(join(base, "loop", "tsconfig.json"))).toBeNull();
		expect(loadPathMapping(join(base, "broken", "tsconfig.json"))).toBeNull();
		expect(loadPathMapping(join(base, "missing", "tsconfig.json"))).toBeNull();
	});

	test("finds the nearest tsconfig.json above a folder", async () => {
		const base = await write("nearest", {
			"tsconfig.json": "{}",
			"packages/app/tsconfig.json": "{}",
			"packages/app/src/lib/x.ts": "",
			"packages/other/src/y.ts": "",
		});
		expect(findTsconfig(join(base, "packages", "app", "src", "lib"))).toBe(
			join(base, "packages", "app", "tsconfig.json"),
		);
		expect(findTsconfig(join(base, "packages", "other", "src"))).toBe(
			join(base, "tsconfig.json"),
		);
	});
});

describe("resolveAppImport", () => {
	test("lists what an import can mean, in order", () => {
		expect(importCandidates(join("a", "db.js"))).toEqual([
			join("a", "db.js"),
			join("a", "db.ts"),
		]);
		expect(importCandidates(join("a", "db.mjs"))).toEqual([
			join("a", "db.mjs"),
			join("a", "db.mts"),
		]);
		expect(importCandidates(join("a", "db")).slice(0, 3)).toEqual([
			join("a", "db"),
			join("a", "db.ts"),
			join("a", "db.mts"),
		]);
		expect(importCandidates(join("a", "db"))).toContain(
			join("a", "db", "index.ts"),
		);
	});

	test("resolves the imports type stripping leaves unresolved", async () => {
		const base = await write("app", {
			"tsconfig.json":
				'{ "compilerOptions": { "paths": { "@/*": ["./src/*"] } } }',
			"src/lib/memory.ts": "",
			"src/lib/db.ts": "",
			"src/lib/plain.js": "",
			"src/settings/index.ts": "",
			"src/embedder.mts": "",
			"src/folder/keep.txt": "",
		});
		const importer = join(base, "src", "lib", "memory.ts");
		const lib = join(base, "src", "lib");

		expect(resolveAppImport("./db.js", importer)).toBe(join(lib, "db.ts"));
		expect(resolveAppImport("./db", importer)).toBe(join(lib, "db.ts"));
		expect(resolveAppImport("./plain", importer)).toBe(join(lib, "plain.js"));
		expect(resolveAppImport("../settings", importer)).toBe(
			join(base, "src", "settings", "index.ts"),
		);
		expect(resolveAppImport("@/embedder", importer)).toBe(
			join(base, "src", "embedder.mts"),
		);
		expect(resolveAppImport("@/lib/db.js", importer)).toBe(join(lib, "db.ts"));

		// A folder without an index, a file that is not there, a package and
		// a builtin are left to Node's own error.
		expect(resolveAppImport("../folder", importer)).toBeNull();
		expect(resolveAppImport("./missing.js", importer)).toBeNull();
		expect(resolveAppImport("postgres", importer)).toBeNull();
		expect(resolveAppImport("node:fs", importer)).toBeNull();
	});
});

describe("memory file lookup", () => {
	test("searches the root, lib, src and src/lib, in that order", async () => {
		const base = await write("lookup", {
			"src/lib/memory.ts": "",
			"other/memory.ts": "",
		});
		expect(findMemoryFile(base)).toBe(join(base, "src", "lib", "memory.ts"));
		await write("lookup", { "src/memory.mjs": "" });
		expect(findMemoryFile(base)).toBe(join(base, "src", "memory.mjs"));
		await write("lookup", { "lib/memory.js": "", "lib/memory.mts": "" });
		expect(findMemoryFile(base)).toBe(join(base, "lib", "memory.mts"));
		await write("lookup", { "memory.ts": "" });
		expect(findMemoryFile(base)).toBe(join(base, "memory.ts"));
		expect(findMemoryFile(join(base, "other", "nested"))).toBeNull();
	});

	test("--config names any file, and must exist", async () => {
		const base = await write("config", {
			"app/clients/mem.ts": "",
			"memory.ts": "",
		});
		expect(locateMemoryFile(base, "app/clients/mem.ts")).toBe(
			join(base, "app", "clients", "mem.ts"),
		);
		expect(locateMemoryFile(base, undefined)).toBe(join(base, "memory.ts"));
		expect(() => locateMemoryFile(base, "app/nope.ts")).toThrow(
			"--config: app/nope.ts is not a file.",
		);
		// A folder is not a memory file.
		expect(() => locateMemoryFile(base, "app")).toThrow("is not a file");
	});
});
