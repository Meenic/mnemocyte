import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createPostgresStore } from "../../src/memory/postgres.js";
import { postgresJs } from "../../src/sql/postgres-js.js";
import {
	type AccessTrackingHarness,
	type StoredAccessState,
	verifyAccessTracking,
	verifyAccessTrackingSkipsDeletedRows,
	verifyNotAccessedSinceUsesCreatedAt,
} from "../fixtures/access-tracking.js";

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
		["0003_schema_v2.sql", "42701"],
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

async function withHarness(
	run: (harness: AccessTrackingHarness) => Promise<void>,
): Promise<void> {
	const sql = postgres(databaseUrl ?? "", { max: 2 });
	const entityId = `access_postgres_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	await applyMigrations(sql);
	try {
		await run({
			store: createPostgresStore(postgresJs(sql)),
			embedder: {
				model: "mnemocyte-integration-test",
				dimensions: 1536,
				async embed(texts) {
					return texts.map(createEmbedding);
				},
			},
			entityId,
			readStoredState(ids) {
				return sql<StoredAccessState[]>`
					SELECT
						id::text AS id,
						access_count AS "accessCount",
						last_accessed_at AS "lastAccessedAt",
						updated_at AS "updatedAt"
					FROM mnemocyte_memories
					WHERE id = ANY(${ids as string[]}::uuid[])
					ORDER BY id
				`;
			},
		});
	} finally {
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id LIKE ${`${entityId}%`}`;
		await sql.end();
	}
}

describe("Postgres recall access tracking", () => {
	test.skipIf(!databaseUrl)(
		"is opt-in, deferred and leaves updated_at alone",
		() => withHarness(verifyAccessTracking),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"skips rows deleted before the write",
		() => withHarness(verifyAccessTrackingSkipsDeletedRows),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"prunes never-accessed rows by created_at",
		() => withHarness(verifyNotAccessedSinceUsesCreatedAt),
		60_000,
	);

	test.skipIf(!databaseUrl)(
		"finishes the access write when the caller ends its client right after recall",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });
			const check = postgres(databaseUrl ?? "", { max: 1 });
			const entityId = `access_postgres_end_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			try {
				await applyMigrations(sql);
				const client = createMemoryClient(
					{
						embedder: {
							model: "mnemocyte-integration-test",
							dimensions: 1536,
							async embed(texts) {
								return texts.map(createEmbedding);
							},
						},
						retrieval: { trackAccess: true },
					},
					createPostgresStore(postgresJs(sql)),
				);
				const memory = await client.remember({
					entityId,
					content: "ended right after recall",
				});

				await client.recall({ entityId, query: "ended right after recall" });
				await sql.end();

				const [row] = await check<Array<{ accessCount: number }>>`
					SELECT access_count AS "accessCount"
					FROM mnemocyte_memories
					WHERE id = ${memory.id}::uuid
				`;
				expect(row?.accessCount).toBe(1);
			} finally {
				await sql.end();
				await check`DELETE FROM mnemocyte_memories WHERE entity_id = ${entityId}`;
				await check.end();
			}
		},
		60_000,
	);
});
