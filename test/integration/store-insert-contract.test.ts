import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte } from "mnemocyte";
import postgres from "postgres";
import { describe, test } from "vitest";
import { verifyStoreInsertContract } from "../fixtures/store-insert-contract.js";

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

describe("Postgres MemoryStore insert contract", () => {
	test.skipIf(!databaseUrl)(
		"preserves rememberMany input order and cardinality",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `store_contract_postgres_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
				await verifyStoreInsertContract(client, entityId);
			} finally {
				await client.close();
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql.end();
			}
		},
		60_000,
	);
});
