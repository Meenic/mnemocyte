import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte } from "mnemocyte";
import postgres from "postgres";
import { describe, test } from "vitest";
import {
	type StoredAccessState,
	verifyRecallAccessMetadata,
} from "../fixtures/recall-access-metadata.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

async function applyMigrations(sql: ReturnType<typeof postgres>) {
	for (const [file, ignoredCode] of [
		["0000_initial.sql", "42P07"],
		["0001_add_mnemocyte_meta.sql", "42P07"],
		["0002_add_embedding_model.sql", "42701"],
	] as const) {
		try {
			await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? error.code
					: undefined;
			if (code !== ignoredCode) {
				throw error;
			}
		}
	}
}

function createEmbedding(seed: string): number[] {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed) {
		const index = char.charCodeAt(0) % values.length;
		values[index] = (values[index] ?? 0) + 1;
	}
	return values;
}

describe("Postgres recall access metadata", () => {
	test.skipIf(!databaseUrl)(
		"returns the successful access update without rescoring it",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `recall_access_postgres_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			await applyMigrations(sql);
			const client = createMnemocyte({
				databaseUrl: databaseUrl ?? "",
				embedder: {
					model: "mnemocyte-integration-test",
					dimensions: 1536,
					async embed(texts) {
						return texts.map(createEmbedding);
					},
				},
			});

			try {
				await verifyRecallAccessMetadata(client, entityId, async (memories) => {
					const ids = memories.map((memory) => memory.id);
					return sql<StoredAccessState[]>`
						SELECT
							id,
							access_count AS "accessCount",
							last_accessed_at AS "lastAccessedAt",
							updated_at AS "updatedAt"
						FROM mnemocyte_memories
						WHERE id = ANY(${ids})
					`;
				});
			} finally {
				await client.close();
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql.end();
			}
		},
		60_000,
	);
});
