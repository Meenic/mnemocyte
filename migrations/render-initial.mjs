#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readOption(name) {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	return process.argv[index + 1];
}

function parseDimensions(value) {
	const dimensions = Number(value);
	if (!Number.isInteger(dimensions) || dimensions < 1) {
		throw new Error("--dimensions must be a positive integer.");
	}
	return dimensions;
}

const dimensions = parseDimensions(readOption("--dimensions"));
const out = readOption("--out");
const dir = dirname(fileURLToPath(import.meta.url));
const template = await readFile(
	resolve(dir, "0000_initial.sql.template"),
	"utf8",
);
const rendered = template.replaceAll(
	"{{EMBEDDING_DIMENSIONS}}",
	String(dimensions),
);

if (out) {
	await writeFile(resolve(process.cwd(), out), rendered);
} else {
	process.stdout.write(rendered);
}
