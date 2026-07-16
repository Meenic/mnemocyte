import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte } from "mnemocyte";
import postgres from "postgres";
import { describe, test } from "vitest";
import { exerciseConsolidationDeletePolicy } from "../fixtures/consolidation-delete-policy.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

function createEmbedding(seed: string) {
	const values = Array.from({ length: 1536 }, () => 0);
	for (const char of seed) {
		const index = char.charCodeAt(0) % values.length;
		values[index] = (values[index] ?? 0) + 1;
	}
	return values;
}

async function applyMigration(
	sql: ReturnType<typeof postgres>,
	path: string,
	ignoredCodes: readonly string[],
) {
	try {
		await sql.unsafe(await readFile(resolve("migrations", path), "utf8"));
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				typeof error.code === "string" &&
				ignoredCodes.includes(error.code)
			)
		) {
			throw error;
		}
	}
}

async function runPostgresPolicyScenario(url: string) {
	const admin = postgres(url, { max: 1 });
	const entityPrefix = `postgres_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	await applyMigration(admin, "0000_initial.sql", ["42P07"]);
	await applyMigration(admin, "0001_add_mnemocyte_meta.sql", ["42P07"]);
	await applyMigration(admin, "0002_add_embedding_model.sql", ["42701"]);

	const client = createMnemocyte({
		databaseUrl: url,
		embedder: {
			model: "mnemocyte-integration-test",
			dimensions: 1536,
			async embed(texts) {
				return texts.map(createEmbedding);
			},
		},
	});

	try {
		await exerciseConsolidationDeletePolicy(client, entityPrefix);
	} finally {
		await client.close();
		await admin`
			DELETE FROM mnemocyte_memories
			WHERE entity_id LIKE ${`${entityPrefix}%`}
		`;
		await admin`
			DELETE FROM mnemocyte_events
			WHERE entity_id LIKE ${`${entityPrefix}%`}
		`;
		await admin.end();
	}
}

describe("Postgres consolidation survivor deletion policy", () => {
	test.skipIf(!databaseUrl)(
		"matches the in-memory typed rejection and atomicity rules",
		async () => {
			await runPostgresPolicyScenario(databaseUrl ?? "");
		},
		120_000,
	);
});
