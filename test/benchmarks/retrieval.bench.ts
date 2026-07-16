import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
	createMnemocyte,
	type MnemocyteClient,
	type RememberInput,
} from "mnemocyte";
import postgres from "postgres";
import { bench, describe, expect } from "vitest";
import {
	retrievalConfig,
	testEmbedder,
} from "../fixtures/retrieval-quality.js";
import { expectDefined } from "../helpers.js";

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

function cycle<T>(values: readonly T[], index: number) {
	return expectDefined(values[index % values.length]);
}

function createInputs(entityId: string, count: number): RememberInput[] {
	return Array.from({ length: count }, (_, index) => ({
		entityId,
		content: cycle(contents, index),
		type: index % 2 === 0 ? "preference" : "fact",
		importance: index % 5 === 0 ? "high" : "normal",
		confidence: 0.8 + (index % 3) * 0.05,
	}));
}

async function measureRecall(client: MnemocyteClient, entityId: string) {
	await client.recall({
		entityId,
		query: cycle(queries, 0),
		limit: 5,
	});

	const startedAt = performance.now();
	for (let index = 0; index < QUERY_COUNT; index += 1) {
		const results = await client.recall({
			entityId,
			query: cycle(queries, index),
			limit: 5,
		});
		expect(results.length).toBeGreaterThan(0);
	}
	const durationMs = performance.now() - startedAt;
	return Number((durationMs / QUERY_COUNT).toFixed(3));
}

async function runInMemoryBench(memoryCount: number) {
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

function createPostgresEmbedding(seed: string) {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed.toLowerCase()) {
		const index = char.charCodeAt(0) % values.length;
		values[index] = (values[index] ?? 0) + 1;
	}
	return values;
}

const postgresEmbedder = {
	model: "retrieval-bench-postgres",
	dimensions: 1536,
	async embed(texts: readonly string[]) {
		return texts.map(createPostgresEmbedding);
	},
};

async function applyMigration(
	sql: ReturnType<typeof postgres>,
	filename: string,
) {
	const migration = await readFile(resolve("migrations", filename), "utf8");
	try {
		await sql.unsafe(migration);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				(error.code === "42P07" || error.code === "42701")
			)
		) {
			throw error;
		}
	}
}

async function ensureMigrations(sql: ReturnType<typeof postgres>) {
	await applyMigration(sql, "0000_initial.sql");
	await applyMigration(sql, "0001_add_mnemocyte_meta.sql");
	await applyMigration(sql, "0002_add_embedding_model.sql");
	await sql`
		INSERT INTO mnemocyte_meta (key, embedding_dimensions)
		VALUES ('installation', 1536)
		ON CONFLICT (key) DO NOTHING
	`;
}

async function runPostgresBench(databaseUrl: string, memoryCount: number) {
	const sql = postgres(databaseUrl, { max: 1 });
	const entityId = `retrieval_bench_pg_${memoryCount}_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	try {
		await ensureMigrations(sql);
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

describe("retrieval benchmarks", () => {
	for (const size of IN_MEMORY_SIZES) {
		bench(
			`in-memory recall over ${size} memories`,
			async () => {
				await runInMemoryBench(size);
			},
			{ iterations: 1, time: 0 },
		);
	}

	if (process.env.DATABASE_URL) {
		for (const size of POSTGRES_SIZES) {
			bench(
				`Postgres recall over ${size} memories`,
				async () => {
					await runPostgresBench(process.env.DATABASE_URL ?? "", size);
				},
				{ iterations: 1, time: 0 },
			);
		}
	}
});
