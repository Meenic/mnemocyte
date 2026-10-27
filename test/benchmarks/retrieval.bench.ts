import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createMnemocyte,
	type MnemocyteClient,
	type RememberInput,
} from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import {
	retrievalConfig,
	testEmbedder,
} from "../fixtures/retrieval-quality.js";
import { expectDefined } from "../helpers.js";

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
	client: MnemocyteClient;
	entityId: string;
	memoryCount: number;
}

function cycle<T>(values: readonly T[], index: number) {
	return expectDefined(values[index % values.length]);
}

function createEntityId(backend: string, memoryCount: number) {
	return `retrieval_bench_${backend}_${memoryCount}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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

// Seeding happens before any bench is registered, so only recall is timed.
async function seed({ client, entityId, memoryCount }: SeededClient) {
	await client.rememberMany(createInputs(entityId, memoryCount));
	const results = await client.recall({
		entityId,
		query: cycle(queries, 0),
		limit: 5,
	});
	expect(results.length).toBeGreaterThan(0);
}

function recallTask({ client, entityId }: SeededClient) {
	let index = 0;
	return async () => {
		await client.recall({
			entityId,
			query: cycle(queries, index),
			limit: 5,
		});
		index += 1;
	};
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
	await applyMigration(sql, "0003_schema_v2.sql");
	await sql`
		INSERT INTO mnemocyte_meta (key, embedding_dimensions)
		VALUES ('installation', 1536)
		ON CONFLICT (key) DO NOTHING
	`;
}

async function deleteEntity(
	sql: ReturnType<typeof postgres>,
	entityId: string,
) {
	await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
	await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
}

const databaseUrl = process.env.DATABASE_URL;

describe("retrieval benchmarks", () => {
	test("in-memory recall by store size", { timeout: 120_000 }, async ({
		bench,
	}) => {
		const seeded: SeededClient[] = [];
		try {
			for (const memoryCount of IN_MEMORY_SIZES) {
				const entry = {
					client: createMnemocyte({
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
						`in-memory recall over ${entry.memoryCount} memories`,
						recallTask(entry),
					),
				),
			);
		} finally {
			await Promise.all(seeded.map(({ client }) => client.close()));
		}
	});

	test.skipIf(!databaseUrl)(
		"Postgres recall by store size",
		{ timeout: 300_000 },
		async ({ bench }) => {
			const url = expectDefined(databaseUrl);
			const sql = postgres(url, { max: 1 });
			const storeSql = postgres(url, { max: 5 });
			const seeded: SeededClient[] = [];
			try {
				await ensureMigrations(sql);
				for (const memoryCount of POSTGRES_SIZES) {
					const entry = {
						client: createMnemocyte({
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
							`Postgres recall over ${entry.memoryCount} memories`,
							recallTask(entry),
						),
					),
				);
			} finally {
				await Promise.all(seeded.map(({ client }) => client.close()));
				for (const { entityId } of seeded) {
					await deleteEntity(sql, entityId);
				}
				await Promise.all([sql.end(), storeSql.end()]);
			}
		},
	);
});
