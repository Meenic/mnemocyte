// Type-checks the ```ts blocks in `@example` doc comments under src/ against
// the built dist/, the way a consumer imports "mnemocyte". Run through
// `pnpm test:jsdoc` after a build. See check-readme.mjs for the README.
//
// Examples use names they never declare (`memory`, `scope`, `userId`, ...),
// so every block becomes its own async function behind one shared preamble
// of `declare` lines; a block's own `const memory` shadows the preamble.
// Mnemocyte exports are not in the preamble: an example imports what it
// uses. The import lines of all blocks are merged per module at the top and
// relative imports are skipped. Lines are not kept in place, so a line map
// turns tsc errors back into `src/<file>:<line>:<col>`.
// The file sits inside the package (gitignored) because "mnemocyte" resolves
// through the package's own `exports` only from inside the package.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const outDir = join(root, "test", "package", ".readme");
const outFile = join(outDir, "jsdoc.ts");
const configFile = join(outDir, "tsconfig.jsdoc.json");

// Application-side names the examples may use without declaring them.
const preamble = [
	'import type { BoundMemoryClient, Embedder, MemoryClient, MemoryConfig } from "mnemocyte";',
	'import type { LanguageModel, ModelMessage } from "ai";',
	"declare const memory: MemoryClient<true>;",
	"declare const user: BoundMemoryClient;",
	"declare const embedder: Embedder;",
	'declare const store: MemoryConfig["store"];',
	'declare const sql: MemoryConfig["store"];',
	"declare const scope: { entityId: string };",
	"declare const id: string;",
	"declare const userId: string;",
	"declare const message: string;",
	"declare const prompt: string;",
	"declare const messages: ModelMessage[];",
	"declare const model: LanguageModel;",
	"declare const openai: (modelId: string) => Exclude<LanguageModel, string>;",
	"declare const content: string;",
	"declare const query: string;",
	"declare const survivorId: string;",
	"declare function review(pairs: unknown[]): Promise<void>;",
	"declare function waitUntil(promise: Promise<unknown>): void;",
];

function* sourceFiles(dir) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) yield* sourceFiles(path);
		else if (path.endsWith(".ts")) yield path;
	}
}

const fail = (message) => {
	console.error(message);
	process.exit(1);
};

// Blocks: { file, line (of the fence), lines: [{ text, line }] }
const blocks = [];
for (const path of [...sourceFiles(srcDir)].sort()) {
	const file = relative(root, path).replaceAll("\\", "/");
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	let current;
	let sawExample = false;
	for (const [index, raw] of lines.entries()) {
		const text = raw.replace(/^\s*\*\s?/, "");
		const isComment = /^\s*\*/.test(raw);
		if (current === undefined) {
			if (isComment && /^@example\b/.test(text)) {
				sawExample = true;
			} else if (sawExample && isComment && /^```ts\s*$/.test(text)) {
				current = { file, line: index + 1, lines: [] };
				sawExample = false;
			} else if (!isComment || /^@\w+/.test(text)) {
				sawExample = false;
			}
		} else if (/^```\s*$/.test(text) && isComment) {
			blocks.push(current);
			current = undefined;
		} else if (isComment) {
			current.lines.push({ text, line: index + 1 });
		} else {
			fail(`${file}:${current.line}: ts block in @example is never closed.`);
		}
	}
	if (current !== undefined) {
		fail(`${file}:${current.line}: ts block in @example is never closed.`);
	}
}
if (blocks.length === 0) fail("src: no @example ts blocks found.");

// Merge imports per module; everything else goes into the block's function.
const modules = new Map();
const bodies = [];
for (const block of blocks) {
	const body = [];
	for (const { text, line } of block.lines) {
		if (!/^import\s/.test(text)) {
			body.push({ text, line });
			continue;
		}
		const match = text.match(
			/^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}\s*)?from\s+["']([^"']+)["'];?\s*$/,
		);
		if (match === null) {
			fail(
				`${block.file}:${line}: unsupported import (use one single-line default or named import per line).`,
			);
		}
		const [, defaultName, named, specifier] = match;
		if (specifier.startsWith(".")) continue;
		const entry = modules.get(specifier) ?? {
			defaults: new Set(),
			named: new Set(),
		};
		if (defaultName) entry.defaults.add(defaultName);
		for (const name of (named ?? "").split(",")) {
			if (name.trim() !== "") entry.named.add(name.trim());
		}
		modules.set(specifier, entry);
	}
	bodies.push({ block, body });
}

// Generated file, with a source position for every line that came from src.
const output = [];
const origin = [];
const emit = (text, source) => {
	output.push(text);
	origin.push(source);
};
for (const line of preamble) emit(line, undefined);
for (const [specifier, { defaults, named }] of [...modules].sort()) {
	// A merged default import cannot clash across modules, but two blocks may
	// import the same default (`postgres`); a Set keeps one.
	const parts = [...defaults];
	if (named.size > 0) parts.push(`{ ${[...named].sort().join(", ")} }`);
	emit(`import ${parts.join(", ")} from "${specifier}";`, undefined);
}
for (const [index, { block, body }] of bodies.entries()) {
	emit(`async function example${index + 1}(): Promise<void> {`, {
		file: block.file,
		line: block.line,
	});
	for (const { text, line } of body) {
		emit(text, { file: block.file, line });
	}
	emit("}", undefined);
	emit(`void example${index + 1};`, undefined);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${output.join("\n")}\n`);
writeFileSync(
	configFile,
	`${JSON.stringify(
		{
			extends: "../tsconfig.json",
			compilerOptions: { rootDir: "." },
			include: ["jsdoc.ts"],
		},
		null,
		"\t",
	)}\n`,
);

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

try {
	execFileSync(
		process.execPath,
		[tsc, "--noEmit", "--pretty", "false", "-p", configFile],
		{ cwd: root, encoding: "utf8", stdio: "pipe" },
	);
	console.log(`src: ${blocks.length} @example ts blocks type-check.`);
} catch (error) {
	const generated = relative(root, outFile).replaceAll("\\", "/");
	const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const normalized = line.replaceAll("\\", "/");
		const match = normalized.match(/^(.+?)\((\d+),(\d+)\): (.*)$/);
		if (match && match[1] === generated) {
			const source = origin[Number(match[2]) - 1];
			console.error(
				source === undefined
					? `${generated}:${match[2]}:${match[3]}: ${match[4]}`
					: `${source.file}:${source.line}:${match[3]}: ${match[4]}`,
			);
		} else {
			console.error(line);
		}
	}
	process.exitCode = 1;
}
