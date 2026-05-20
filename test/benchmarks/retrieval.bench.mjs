import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { createMnemocyte } from "../../dist/index.mjs";
import {
	retrievalConfig,
	testEmbedder,
} from "../fixtures/retrieval-quality.mjs";

const IN_MEMORY_SIZES = [200, 1_000, 5_000];
const POSTGRES_SIZES = [200, 1_000];
const QUERY_COUNT = 25;
const contents = [
	"Prefers concise TypeScript library answers.",
	"Postgres and pgvector store memory embeddings.",
	"Release workflow uses npm publish after version bump.",
	"Database migration scripts should be explicit and reviewed.",
	"Short responses are preferred for direct workflow questions.",
];
const queries = ["typescript concise answers", "postgres pgvector database"];

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

function createInputs(entityId, count) {
	return Array.from({ length: count }, (_, index) => ({
		entityId,
		content: contents[index % contents.length],
		type: index % 2 === 0 ? "preference" : "fact",
		importance: index % 5 === 0 ? "high" : "normal",
		confidence: 0.8 + (index % 3) * 0.05,
	}));
}

async function measureRecall(client, entityId) {
	await client.recall({
		entityId,
		query: queries[0],
		limit: 5,
	});

	const startedAt = performance.now();
	for (let index = 0; index < QUERY_COUNT; index += 1) {
		const results = await client.recall({
			entityId,
			query: queries[index % queries.length],
			limit: 5,
		});
		assert.ok(results.length > 0);
	}
	const durationMs = performance.now() - startedAt;
	return Number((durationMs / QUERY_COUNT).toFixed(3));
}

async function runInMemoryBench(memoryCount) {
	const client = createMnemocyte({
		embedder: testEmbedder,
		retrieval: retrievalConfig,
	});
	const entityId = `retrieval_bench_mem_${memoryCount}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	try {
		await client.rememberMany(createInputs(entityId, memoryCount));
		return {
			backend: "in-memory",
			memoryCount,
			queryCount: QUERY_COUNT,
			averageRecallMs: await measureRecall(client, entityId),
		};
	} finally {
		await client.close();
	}
}

function createPostgresEmbedding(seed) {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed.toLowerCase()) {
		const index = char.charCodeAt(0) % values.length;
		values[index] += 1;
	}
	return values;
}

const postgresEmbedder = {
	model: "retrieval-bench-postgres",
	dimensions: 1536,
	async embed(texts) {
		return texts.map(createPostgresEmbedding);
	},
};

async function ensureMigration(sql) {
	const migration = await readFile(
		resolve("migrations", "0000_initial.sql"),
		"utf8",
	);
	try {
		await sql.unsafe(migration);
	} catch (error) {
		if (error.code !== "42P07") {
			throw error;
		}
	}
}

async function runPostgresBench(databaseUrl, memoryCount) {
	const sql = postgres(databaseUrl, { max: 1 });
	const entityId = `retrieval_bench_pg_${memoryCount}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	try {
		await ensureMigration(sql);
		await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;

		const client = createMnemocyte({
			databaseUrl,
			embedder: postgresEmbedder,
			retrieval: retrievalConfig,
		});

		try {
			await client.rememberMany(createInputs(entityId, memoryCount));
			return {
				backend: "postgres",
				memoryCount,
				queryCount: QUERY_COUNT,
				averageRecallMs: await measureRecall(client, entityId),
			};
		} finally {
			await client.close();
		}
	} finally {
		await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
		await sql.end();
	}
}

const inMemory = [];
for (const size of IN_MEMORY_SIZES) {
	inMemory.push(await runInMemoryBench(size));
}

const postgresResults = [];
if (process.env.DATABASE_URL) {
	for (const size of POSTGRES_SIZES) {
		postgresResults.push(
			await runPostgresBench(process.env.DATABASE_URL, size),
		);
	}
}

console.log(
	JSON.stringify(
		{
			queryCount: QUERY_COUNT,
			inMemory,
			postgres: process.env.DATABASE_URL
				? postgresResults
				: { skipped: "DATABASE_URL is not set" },
		},
		null,
		2,
	),
);
