#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// pgvector's HNSW index supports `vector` up to 2,000 dimensions and
// `halfvec` up to 4,000.
const MAX_VECTOR_DIMENSIONS = 2000;
const MAX_HALFVEC_DIMENSIONS = 4000;

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
	if (dimensions > MAX_HALFVEC_DIMENSIONS) {
		throw new Error(
			`--dimensions must be at most ${MAX_HALFVEC_DIMENSIONS}, the largest halfvec size an HNSW index supports.`,
		);
	}
	return dimensions;
}

const dimensions = parseDimensions(readOption("--dimensions"));
const vectorType = dimensions > MAX_VECTOR_DIMENSIONS ? "halfvec" : "vector";
const out = readOption("--out");
const dir = dirname(fileURLToPath(import.meta.url));
const template = await readFile(
	resolve(dir, "0000_initial.sql.template"),
	"utf8",
);
const rendered = template
	.replaceAll("{{EMBEDDING_DIMENSIONS}}", String(dimensions))
	.replaceAll("{{VECTOR_TYPE}}", vectorType);

if (out) {
	await writeFile(resolve(process.cwd(), out), rendered);
} else {
	process.stdout.write(rendered);
}
