import {
	createMemory,
	type MemoryClient,
	migrate,
	type NewMemory,
} from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import {
	retrievalConfig,
	testEmbedder,
} from "../fixtures/retrieval-quality.js";
import { expectDefined, testScope } from "../helpers.js";

const IN_MEMORY_SIZES = [200, 1_000, 5_000];
const POSTGRES_SIZES = [200, 1_000];
const contents = [
	"Prefers concise TypeScript library answers.",
	"Postgres and pgvector store memory embeddings.",
	"Release workflow uses npm publish after version bump.",
	"Database migration scripts should be explicit and reviewed.",
	"Short responses are preferred for direct workflow questions.",
];
const queries = ["typescript concise answers", "postgres pgvector database"];

interface SeededClient {
	client: MemoryClient;
	entityId: string;
	memoryCount: number;
}

function cycle<T>(values: readonly T[], index: number) {
	return expectDefined(values[index % values.length]);
}

function createEntityId(backend: string, memoryCount: number) {
	return `retrieval_bench_${backend}_${memoryCount}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

// Contents are distinct so the Postgres embedder gives every memory its own
// vector; many equal vectors can leave parts of an HNSW graph unreachable.
function createInputs(count: number): NewMemory[] {
	return Array.from({ length: count }, (_, index) => ({
		content: `${cycle(contents, index)} (${index})`,
		kind: index % 2 === 0 ? "preference" : "fact",
		importance: index % 5 === 0 ? "high" : "normal",
		confidence: 0.8 + (index % 3) * 0.05,
	}));
}

// Seeding happens before any bench is registered, so only search is timed.
// `addMany` takes at most 1,000 memories per call.
async function seed({ client, entityId, memoryCount }: SeededClient) {
	const inputs = createInputs(memoryCount);
	for (let start = 0; start < inputs.length; start += 1000) {
		await client.addMany({
			scope: testScope(entityId),
			memories: inputs.slice(start, start + 1000),
		});
	}
	const results = await client.search({
		scope: testScope(entityId),
		query: cycle(queries, 0),
		limit: 5,
	});
	expect(results.length).toBeGreaterThan(0);
}

function searchTask({ client, entityId }: SeededClient) {
	let index = 0;
	return async () => {
		await client.search({
			scope: testScope(entityId),
			query: cycle(queries, index),
			limit: 5,
		});
		index += 1;
	};
}

/** A seeded pseudo-random vector per text (FNV-1a, then mulberry32). */
function createPostgresEmbedding(text: string) {
	let state = 2166136261;
	for (const char of text) {
		state = Math.imul(state ^ (char.codePointAt(0) ?? 0), 16777619);
	}
	return Array.from({ length: 1536 }, () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
	});
}

// The model name of the Postgres plan benchmark, so both can share a
// disposable database.
const postgresEmbedder = {
	model: "mnemocyte-bench",
	dimensions: 1536,
	async embed(texts: readonly string[]) {
		return texts.map(createPostgresEmbedding);
	},
};

async function deleteEntity(
	sql: ReturnType<typeof postgres>,
	entityId: string,
) {
	await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
	await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
}

const databaseUrl = process.env.DATABASE_URL;

describe("retrieval benchmarks", () => {
	test("in-memory search by store size", { timeout: 120_000 }, async ({
		bench,
	}) => {
		const seeded: SeededClient[] = [];
		try {
			for (const memoryCount of IN_MEMORY_SIZES) {
				const entry = {
					client: createMemory({
						embedder: testEmbedder,
						retrieval: retrievalConfig,
					}),
					entityId: createEntityId("mem", memoryCount),
					memoryCount,
				};
				seeded.push(entry);
				await seed(entry);
			}

			await bench.compare(
				...seeded.map((entry) =>
					bench(
						`in-memory search over ${entry.memoryCount} memories`,
						searchTask(entry),
					),
				),
			);
		} finally {
			seeded.length = 0;
		}
	});

	test.skipIf(!databaseUrl)(
		"Postgres search by store size",
		{ timeout: 300_000 },
		async ({ bench }) => {
			const url = expectDefined(databaseUrl);
			const sql = postgres(url, { max: 1 });
			const storeSql = postgres(url, { max: 5 });
			const seeded: SeededClient[] = [];
			try {
				await migrate({ store: sql, dimensions: 1536 });
				for (const memoryCount of POSTGRES_SIZES) {
					const entry = {
						client: createMemory({
							store: postgresStore({ client: postgresJs(storeSql) }),
							embedder: postgresEmbedder,
							retrieval: retrievalConfig,
						}),
						entityId: createEntityId("pg", memoryCount),
						memoryCount,
					};
					seeded.push(entry);
					await deleteEntity(sql, entry.entityId);
					await seed(entry);
				}

				await bench.compare(
					...seeded.map((entry) =>
						bench(
							`Postgres search over ${entry.memoryCount} memories`,
							searchTask(entry),
						),
					),
				);
			} finally {
				for (const { entityId } of seeded) {
					await deleteEntity(sql, entityId);
				}
				await Promise.all([sql.end(), storeSql.end()]);
			}
		},
	);
});
