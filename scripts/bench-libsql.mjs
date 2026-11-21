#!/usr/bin/env node
// Times the libSQL store's exact scans on a local file, against dist/ (run
// `pnpm bench:libsql`, which builds first). One entity holds N memories of
// 1,536 dimensions, next to a second entity of the same size, so the scope
// index has rows to skip. Prints a Markdown table; the numbers in
// docs/features/libsql.md come from it. Needs @libsql/client (a dev
// dependency). Sizes: MNEMOCYTE_BENCH_SIZES (default 1000,10000,50000).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { createMemory, migrate } from "mnemocyte";

const DIMENSIONS = 1536;
const SIZES = (process.env.MNEMOCYTE_BENCH_SIZES ?? "1000,10000,50000")
	.split(",")
	.map(Number);
const SEARCHES = 20;
const WORDS = ["amber", "birch", "cedar", "dune", "ember", "fjord", "grove"];

function random(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function vectorFor(text) {
	let seed = 2166136261;
	for (const char of text) {
		seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
	}
	const next = random(seed);
	return Array.from({ length: DIMENSIONS }, () => next() * 2 - 1);
}

const embedder = {
	model: "bench-libsql",
	dimensions: DIMENSIONS,
	async embed(texts) {
		return texts.map(vectorFor);
	},
};

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

async function time(fn) {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

const rows = [];
for (const size of SIZES) {
	const dir = await mkdtemp(join(tmpdir(), "mnemocyte-bench-libsql-"));
	const client = createClient({
		url: `file:${join(dir, "bench.db").replaceAll("\\", "/")}`,
	});
	const memory = createMemory({ store: client, embedder });
	await migrate({ memory });
	const seedStart = performance.now();
	for (const entityId of ["other", "measured"]) {
		for (let start = 0; start < size; start += 1000) {
			await memory.addMany({
				scope: { namespace: "bench", entityId },
				memories: Array.from(
					{ length: Math.min(1000, size - start) },
					(_, offset) => {
						const index = start + offset;
						return {
							content: `${WORDS[index % WORDS.length]} memory ${index} of ${entityId}`,
							kind: index % 10 === 0 ? "preference" : "fact",
						};
					},
				),
			});
		}
	}
	const seedSeconds = (performance.now() - seedStart) / 1000;
	const scope = { namespace: "bench", entityId: "measured" };

	const hybrid = [];
	const vectorOnly = [];
	const filtered = [];
	for (let query = 0; query < SEARCHES; query += 1) {
		hybrid.push(
			await time(() =>
				memory.search({
					scope,
					query: `${WORDS[query % WORDS.length]} memory`,
				}),
			),
		);
		vectorOnly.push(
			await time(() => memory.search({ scope, query: `quay gantry ${query}` })),
		);
		filtered.push(
			await time(() =>
				memory.search({
					scope,
					query: `quay gantry ${query}`,
					kinds: ["preference"],
				}),
			),
		);
	}
	const row = {
		size,
		seedSeconds,
		hybrid: median(hybrid),
		vectorOnly: median(vectorOnly),
		filtered: median(filtered),
	};
	if (size <= 10_000) {
		row.page = await time(() =>
			memory.experimental.findDuplicatesPage({
				scope,
				threshold: 0.9,
				batchSize: 100,
			}),
		);
	}
	if (size <= 10_000) {
		row.top = await time(() =>
			memory.findDuplicates({ scope, threshold: 0.9 }),
		);
	}
	rows.push(row);
	client.close();
	await rm(dir, { recursive: true, force: true, maxRetries: 10 }).catch(
		() => undefined,
	);
	process.stderr.write(`size ${size} done\n`);
}

const ms = (value) => (value === undefined ? "-" : `${value.toFixed(1)} ms`);
console.log(
	`Node ${process.version}, ${process.platform} ${process.arch}, ${DIMENSIONS} dimensions, median of ${SEARCHES} searches (limit 10).\n`,
);
console.log(
	"| Memories in the entity | `search` (keyword matches) | `search` (vector only) | same, `kinds` keeping a tenth | first `findDuplicatesPage` (100) | `findDuplicates` | seeding both entities |",
);
console.log("|---|---|---|---|---|---|---|");
for (const row of rows) {
	console.log(
		`| ${row.size.toLocaleString("en-US")} | ${ms(row.hybrid)} | ${ms(row.vectorOnly)} | ${ms(row.filtered)} | ${ms(row.page)} | ${ms(row.top)} | ${row.seedSeconds.toFixed(1)} s |`,
	);
}
