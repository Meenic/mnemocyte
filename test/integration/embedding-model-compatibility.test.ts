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
const installationModel = "mnemocyte-integration-test";

function hasPostgresCode(error: unknown, code: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === code
	);
}

async function applyMigration(
	sql: ReturnType<typeof postgres>,
	name: string,
	duplicateCode: string,
) {
	const migration = await readFile(resolve("migrations", name), "utf8");
	try {
		await sql.unsafe(migration);
	} catch (error) {
		if (!hasPostgresCode(error, duplicateCode)) {
			throw error;
		}
	}
}

async function applyMigrations(sql: ReturnType<typeof postgres>) {
	await sql`CREATE EXTENSION IF NOT EXISTS vector`;
	await applyMigration(sql, "0000_initial.sql", "42P07");
	await applyMigration(sql, "0001_add_mnemocyte_meta.sql", "42P07");
	await sql`
		INSERT INTO mnemocyte_meta (key, embedding_dimensions)
		VALUES ('installation', 1536)
		ON CONFLICT (key) DO UPDATE
		SET embedding_dimensions = EXCLUDED.embedding_dimensions
	`;
	await applyMigration(sql, "0002_add_embedding_model.sql", "42701");
}

function createEmbedder(model: string, embedCalls: string[]) {
	return {
		model,
		dimensions: 1536,
		async embed(texts: readonly string[]) {
			embedCalls.push(...texts);
			return texts.map(() => {
				const embedding = Array.from({ length: 1536 }, () => 0);
				embedding[0] = 1;
				return embedding;
			});
		},
	};
}

describe("Postgres embedding-model compatibility", () => {
	test.skipIf(!databaseUrl)(
		"records, repairs, and enforces one installation model",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `model_compat_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const mixedMemoryId = `mem_mixed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const incompatibleModel = "mnemocyte-incompatible-test";
			const vector = `[1,${Array.from({ length: 1535 }, () => "0").join(",")}]`;
			await applyMigrations(sql);
			const originalMeta = await sql<Array<{ embeddingModel: string | null }>>`
				SELECT embedding_model AS "embeddingModel"
				FROM mnemocyte_meta
				WHERE key = 'installation'
			`;
			const originalModel = originalMeta[0]?.embeddingModel ?? null;

			try {
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
				await sql`
					UPDATE mnemocyte_meta
					SET embedding_model = ${installationModel}
					WHERE key = 'installation'
				`;

				const matchingCalls: string[] = [];
				const matchingClient = createMnemocyte({
					databaseUrl: databaseUrl ?? "",
					embedder: createEmbedder(installationModel, matchingCalls),
				});
				try {
					await matchingClient.remember({
						entityId,
						content: "written-by-installation-model",
					});
					const recalled = await matchingClient.recall({
						entityId,
						query: "matching-query",
					});
					expect(recalled.map((memory) => memory.embeddingModel)).toEqual([
						installationModel,
					]);
				} finally {
					await matchingClient.close();
				}
				expect(matchingCalls).toEqual([
					"written-by-installation-model",
					"matching-query",
				]);

				const incompatibleCalls: string[] = [];
				const incompatibleClient = createMnemocyte({
					databaseUrl: databaseUrl ?? "",
					embedder: createEmbedder(incompatibleModel, incompatibleCalls),
				});
				try {
					await expectMnemocyteError(
						incompatibleClient.recall({
							entityId,
							query: "must-not-be-embedded",
						}),
						"CONFIG",
					);
					await expectMnemocyteError(
						incompatibleClient.findDuplicates({ entityId }),
						"CONFIG",
					);
					await expect(
						incompatibleClient.stats({ entityId }),
					).resolves.toMatchObject({
						entityId,
						memoryCount: 1,
					});
				} finally {
					await incompatibleClient.close();
				}
				expect(incompatibleCalls).toEqual([]);

				await sql`
					UPDATE mnemocyte_meta
					SET embedding_model = NULL
					WHERE key = 'installation'
				`;
				const repairCalls: string[] = [];
				const repairClient = createMnemocyte({
					databaseUrl: databaseUrl ?? "",
					embedder: createEmbedder(installationModel, repairCalls),
				});
				try {
					await expect(
						repairClient.recall({ entityId, query: "repair-query" }),
					).resolves.toHaveLength(1);
				} finally {
					await repairClient.close();
				}
				const repairedMeta = await sql<
					Array<{ embeddingModel: string | null }>
				>`
					SELECT embedding_model AS "embeddingModel"
					FROM mnemocyte_meta
					WHERE key = 'installation'
				`;
				expect(repairedMeta[0]?.embeddingModel).toBe(installationModel);
				expect(repairCalls).toEqual(["repair-query"]);

				await sql`
					INSERT INTO mnemocyte_memories (
						id,
						entity_id,
						content,
						embedding,
						embedding_model,
						embedding_dimensions
					)
					VALUES (
						${mixedMemoryId},
						${entityId},
						'mixed-historical-model',
						${vector}::vector,
						${incompatibleModel},
						1536
					)
				`;
				await sql`
					UPDATE mnemocyte_meta
					SET embedding_model = NULL
					WHERE key = 'installation'
				`;
				const mixedClient = createMnemocyte({
					databaseUrl: databaseUrl ?? "",
					embedder: createEmbedder(installationModel, []),
				});
				try {
					const error = await expectMnemocyteError(
						mixedClient.findDuplicates({ entityId }),
						"MIGRATION",
					);
					expect(error.message).toContain("multiple");
				} finally {
					await mixedClient.close();
				}
				const mixedMeta = await sql<Array<{ embeddingModel: string | null }>>`
					SELECT embedding_model AS "embeddingModel"
					FROM mnemocyte_meta
					WHERE key = 'installation'
				`;
				expect(mixedMeta[0]?.embeddingModel).toBeNull();
			} finally {
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql`DELETE FROM mnemocyte_events WHERE entity_id = ${entityId}`;
				await sql`
					UPDATE mnemocyte_meta
					SET embedding_model = ${originalModel}
					WHERE key = 'installation'
				`;
				await sql.end();
			}
		},
		60_000,
	);
});
