import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte } from "mnemocyte";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

async function applyMigrations(sql: ReturnType<typeof postgres>) {
	await sql`CREATE EXTENSION IF NOT EXISTS vector`;
	const migration = await readFile(
		resolve("migrations", "0000_initial.sql"),
		"utf8",
	);
	const metaMigration = await readFile(
		resolve("migrations", "0001_add_mnemocyte_meta.sql"),
		"utf8",
	);

	try {
		await sql.unsafe(migration);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "42P07"
			)
		) {
			throw error;
		}
	}
	try {
		await sql.unsafe(metaMigration);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "42P07"
			)
		) {
			throw error;
		}
		await sql`
			INSERT INTO mnemocyte_meta (key, embedding_dimensions)
			VALUES ('installation', 1536)
			ON CONFLICT (key) DO UPDATE
			SET embedding_dimensions = EXCLUDED.embedding_dimensions
		`;
	}
}

function firstVectorComponent(value: unknown): number {
	if (typeof value !== "string") {
		throw new Error("Expected pgvector text output.");
	}
	const component = value.slice(1, -1).split(",")[0];
	if (component === undefined) {
		throw new Error("Expected at least one pgvector component.");
	}
	return Number(component);
}

describe("Postgres vector correctness", () => {
	test.skipIf(!databaseUrl)(
		"preserves finite components through pgvector float4 storage",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `serialization_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const components = [1e-20, -1e-20, Math.PI, 1e20, 0, -0];
			const componentByContent = new Map(
				components.map((component, index) => [`component-${index}`, component]),
			);

			await applyMigrations(sql);
			const client = createMnemocyte({
				databaseUrl: databaseUrl ?? "",
				embedder: {
					model: "serialization-integration-test",
					dimensions: 1536,
					async embed(texts) {
						return texts.map((text) => {
							const embedding = Array.from({ length: 1536 }, () => 0);
							embedding[0] = componentByContent.get(text) ?? 0;
							embedding[1] = 1;
							return embedding;
						});
					},
				},
			});

			try {
				const memories = await client.rememberMany({
					inputs: components.map((_component, index) => ({
						entityId,
						content: `component-${index}`,
					})),
				});
				const rows = await sql<Array<{ id: string; embedding: string }>>`
					SELECT id, embedding::text AS embedding
					FROM mnemocyte_memories
					WHERE entity_id = ${entityId}
				`;
				const storedById = new Map(
					rows.map((row) => [row.id, firstVectorComponent(row.embedding)]),
				);

				for (const [index, component] of components.entries()) {
					const memory = memories[index];
					if (!memory) {
						throw new Error("Expected one memory per vector component.");
					}
					const expected = Object.is(component, -0)
						? 0
						: Math.fround(component);
					const stored = storedById.get(memory.id);
					if (expected === 0) {
						expect(stored).toBe(0);
					} else {
						expect(stored).toBeDefined();
						expect(
							Math.abs((stored ?? 0) - expected) / Math.abs(expected),
						).toBeLessThan(1e-6);
					}
				}
				expect(storedById.get(memories[0]?.id ?? "")).not.toBe(0);
			} finally {
				await client.close();
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
				await sql.end();
			}
		},
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"rejects zero vectors before storage or comparison while retaining tiny vectors",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `zero_norm_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			await applyMigrations(sql);
			const client = createMnemocyte({
				databaseUrl: databaseUrl ?? "",
				embedder: {
					model: "zero-norm-integration-test",
					dimensions: 1536,
					async embed(texts) {
						return texts.map((text) => {
							const embedding = Array.from({ length: 1536 }, () => 0);
							if (!text.includes("zero")) {
								embedding[0] = 1e-20;
							}
							return embedding;
						});
					},
				},
			});

			try {
				await expectMnemocyteError(
					client.remember({ entityId, content: "zero stored" }),
					"EMBEDDING",
				);
				const zeroRows = await sql<Array<{ count: number }>>`
					SELECT count(*)::int AS count
					FROM mnemocyte_memories
					WHERE entity_id = ${entityId}
				`;
				expect(zeroRows[0]?.count).toBe(0);

				await client.rememberMany({
					inputs: [
						{ entityId, content: "alpha" },
						{ entityId, content: "beta" },
					],
				});
				const pairs = await client.findDuplicates({
					entityId,
					threshold: 0.99,
				});
				expect(pairs).toHaveLength(1);
				expect(pairs[0]?.similarity).toBeGreaterThanOrEqual(0.99);

				const recalled = await client.recall({
					entityId,
					query: "gamma",
					limit: 2,
				});
				expect(recalled).toHaveLength(2);
				expect(recalled.every((memory) => memory.scores.vector >= 0.99)).toBe(
					true,
				);
				const tinyQueryVector = `[1e-20,${Array.from(
					{ length: 1535 },
					() => "0",
				).join(",")}]`;
				await sql`SET enable_seqscan = off`;
				try {
					const plan = await sql<Array<{ "QUERY PLAN": string }>>`
						EXPLAIN (COSTS OFF)
						SELECT id
						FROM mnemocyte_memories
						WHERE embedding IS NOT NULL
						ORDER BY embedding <=> ${tinyQueryVector}::vector
						LIMIT 2
					`;
					expect(
						plan.some((row) =>
							row["QUERY PLAN"].includes(
								"mnemocyte_memories_embedding_hnsw_idx",
							),
						),
					).toBe(true);
					const indexedRows = await sql<Array<{ id: string }>>`
						SELECT id
						FROM mnemocyte_memories
						WHERE embedding IS NOT NULL
						ORDER BY embedding <=> ${tinyQueryVector}::vector
						LIMIT 2
					`;
					expect(indexedRows).toHaveLength(2);
				} finally {
					await sql`RESET enable_seqscan`;
				}
				const beforeZeroQuery = await sql<Array<{ accessCount: number }>>`
					SELECT access_count AS "accessCount"
					FROM mnemocyte_memories
					WHERE entity_id = ${entityId}
					ORDER BY id
				`;

				await expectMnemocyteError(
					client.recall({ entityId, query: "zero query" }),
					"EMBEDDING",
				);
				const afterZeroQuery = await sql<Array<{ accessCount: number }>>`
					SELECT access_count AS "accessCount"
					FROM mnemocyte_memories
					WHERE entity_id = ${entityId}
					ORDER BY id
				`;
				expect(afterZeroQuery).toEqual(beforeZeroQuery);
			} finally {
				await client.close();
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
				await sql.end();
			}
		},
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"matches in-memory clamping for signed cosine candidates",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `signed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const vectorByText = new Map<string, number>([
				["positive", 1],
				["orthogonal", 0],
				["slightly-negative", -1e-9],
				["opposite", -1],
				["query", 1],
			]);
			await applyMigrations(sql);
			const client = createMnemocyte({
				databaseUrl: databaseUrl ?? "",
				embedder: {
					model: "signed-vector-integration-test",
					dimensions: 1536,
					async embed(texts) {
						return texts.map((text) => {
							const embedding = Array.from({ length: 1536 }, () => 0);
							const first = vectorByText.get(text) ?? 1;
							embedding[0] = first;
							if (text === "orthogonal" || text === "slightly-negative") {
								embedding[1] = 1;
							}
							return embedding;
						});
					},
				},
			});

			try {
				for (const content of [
					"positive",
					"orthogonal",
					"slightly-negative",
					"opposite",
				]) {
					await client.remember({ entityId, content });
				}

				const all = await client.recall({
					entityId,
					query: "query",
					limit: 4,
				});
				expect(all).toHaveLength(4);
				const vectorScores = new Map(
					all.map((memory) => [memory.content, memory.scores.vector]),
				);
				expect(vectorScores.get("positive")).toBe(1);
				expect(vectorScores.get("orthogonal")).toBe(0);
				expect(vectorScores.get("slightly-negative")).toBe(0);
				expect(vectorScores.get("opposite")).toBe(0);
				expect(
					all
						.filter((memory) => memory.content !== "positive")
						.every((memory) => memory.score > 0),
				).toBe(true);

				const finalScoreFiltered = await client.recall({
					entityId,
					query: "query",
					limit: 4,
					minScore: 0.2,
				});
				expect(finalScoreFiltered.map((memory) => memory.content)).toEqual([
					"positive",
				]);
			} finally {
				await client.close();
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
				await sql.end();
			}
		},
		60_000,
	);
});
