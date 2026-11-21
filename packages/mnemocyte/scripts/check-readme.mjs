// Type-checks the README's `ts` blocks against the built dist/, the way a
// consumer imports "mnemocyte". Run through `pnpm test:readme` after a build.
//
// The blocks build on each other, so they are joined into one file. Every
// line outside a block becomes a blank line, which keeps line N of the
// generated file on line N of README.md, so tsc errors name README lines.
// The file sits inside the package (gitignored) because "mnemocyte" resolves
// through the package's own `exports` only from inside the package.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The README is the repository's, two folders up.
const readmePath = join(root, "..", "..", "README.md");
const outDir = join(root, "test", "package", ".readme");
const outFile = join(outDir, "readme.ts");

const lines = readFileSync(readmePath, "utf8").split(/\r?\n/);
const output = [];
let openFence = 0;
let blocks = 0;

for (const [index, line] of lines.entries()) {
	if (openFence === 0) {
		if (/^```(ts|typescript)\s*$/.test(line)) {
			openFence = index + 1;
			blocks += 1;
		}
		output.push("");
	} else if (/^```\s*$/.test(line)) {
		openFence = 0;
		output.push("");
	} else {
		output.push(line);
	}
}

if (openFence !== 0) {
	console.error(`README.md:${openFence}: ts block is never closed.`);
	process.exit(1);
}
if (blocks === 0) {
	console.error("README.md: no ts blocks found.");
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, output.join("\n"));
writeFileSync(
	join(outDir, "tsconfig.json"),
	`${JSON.stringify(
		{
			extends: "../tsconfig.json",
			compilerOptions: { rootDir: "." },
			include: ["readme.ts"],
		},
		null,
		"\t",
	)}\n`,
);

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

try {
	execFileSync(
		process.execPath,
		[tsc, "--noEmit", "--pretty", "false", "-p", join(outDir, "tsconfig.json")],
		{ cwd: root, encoding: "utf8", stdio: "pipe" },
	);
	console.log(`README.md: ${blocks} ts blocks type-check.`);
} catch (error) {
	const generated = relative(root, outFile).replaceAll("\\", "/");
	const text = `${error.stdout ?? ""}${error.stderr ?? ""}`;
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const normalized = line.replaceAll("\\", "/");
		const match = normalized.match(/^(.+?)\((\d+),(\d+)\): (.*)$/);
		if (match && match[1] === generated) {
			console.error(`README.md:${match[2]}:${match[3]}: ${match[4]}`);
		} else {
			console.error(line);
		}
	}
	process.exitCode = 1;
}
