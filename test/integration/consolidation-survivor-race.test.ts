import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { MnemocyteConfig } from "mnemocyte";
import postgres from "postgres";
import { describe, test } from "vitest";
import { createDatabase } from "../../src/db/index.js";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createPostgresStore } from "../../src/memory/postgres.js";
import {
	createPausingConsolidationStore,
	exerciseConsolidationSurvivorRaces,
} from "../fixtures/consolidation-survivor-races.js";

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

async function runPostgresRaceScenario(url: string) {
	const admin = postgres(url, { max: 1 });
	const entityPrefix = `postgres_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	await applyMigration(admin, "0000_initial.sql", ["42P07"]);
	await applyMigration(admin, "0001_add_mnemocyte_meta.sql", ["42P07"]);
	await applyMigration(admin, "0002_add_embedding_model.sql", ["42701"]);

	const config: MnemocyteConfig = {
		embedder: {
			model: "mnemocyte-integration-test",
			dimensions: 1536,
			async embed(texts) {
				return texts.map(createEmbedding);
			},
		},
		audit: { enabled: true },
	};
	const baseStore = createPostgresStore(createDatabase(url));
	const pausingStore = createPausingConsolidationStore(baseStore);
	const client = createMemoryClient(config, pausingStore.store);
	const mutator = createMemoryClient(config, baseStore);

	try {
		await exerciseConsolidationSurvivorRaces({
			client,
			mutator,
			pauseNext: pausingStore.pauseNext,
			entityPrefix,
		});
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

describe("Postgres consolidation survivor mutation races", () => {
	test.skipIf(!databaseUrl)(
		"atomically protects the survivor and current tags",
		async () => {
			await runPostgresRaceScenario(databaseUrl ?? "");
		},
		120_000,
	);
});
