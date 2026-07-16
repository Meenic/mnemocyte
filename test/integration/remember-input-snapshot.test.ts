import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMnemocyte } from "mnemocyte";
import postgres from "postgres";
import { describe, test } from "vitest";
import {
	createGatedEmbedder,
	verifyRememberInputSnapshots,
} from "../fixtures/remember-input-snapshot.js";
import {
	createCountingEmbedder,
	verifyRememberInputValidation,
} from "../fixtures/remember-input-validation.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

async function applyMigrations(sql: ReturnType<typeof postgres>) {
	for (const file of [
		"0000_initial.sql",
		"0001_add_mnemocyte_meta.sql",
		"0002_add_embedding_model.sql",
	]) {
		try {
			await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? error.code
					: undefined;
			if (
				(file === "0000_initial.sql" && code === "42P07") ||
				(file === "0001_add_mnemocyte_meta.sql" && code === "42P07") ||
				(file === "0002_add_embedding_model.sql" && code === "42701")
			) {
				continue;
			}
			throw error;
		}
	}
}

describe("Postgres remember input snapshots", () => {
	test.skipIf(!databaseUrl)(
		"owns mutable single and batch inputs before awaiting",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `snapshot_postgres_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			await applyMigrations(sql);
			const gate = createGatedEmbedder("mnemocyte-integration-test", 1536);
			const client = createMnemocyte({
				databaseUrl: databaseUrl ?? "",
				embedder: gate.embedder,
			});

			try {
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await verifyRememberInputSnapshots(client, gate.nextCall, entityId);
			} finally {
				await client.close();
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql.end();
			}
		},
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"rejects malformed runtime values before embedding or storage",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `validation_postgres_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			await applyMigrations(sql);
			const counter = createCountingEmbedder(
				"mnemocyte-integration-test",
				1536,
			);
			const client = createMnemocyte({
				databaseUrl: databaseUrl ?? "",
				embedder: counter.embedder,
			});

			try {
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await verifyRememberInputValidation(client, counter.getCalls, entityId);
			} finally {
				await client.close();
				await sql`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await sql.end();
			}
		},
		60_000,
	);
});
