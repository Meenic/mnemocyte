import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte } from "mnemocyte";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

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
});
