import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm/sql";
import { createMnemocyte, type MnemocyteClient } from "mnemocyte";
import { drizzleStore } from "mnemocyte/stores/drizzle";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;

const callerSchema = {
	applicationTable: pgTable("application_table", {
		id: text("id").primaryKey(),
	}),
};

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

const embedder = {
	model: "mnemocyte-integration-test",
	dimensions: 1536,
	async embed(texts: readonly string[]) {
		return texts.map(createEmbedding);
	},
};

async function exerciseRepresentativePath(
	client: MnemocyteClient,
	entityId: string,
) {
	const remembered = await client.remember({
		entityId,
		content: "Caller-owned Drizzle storage behaves like URL storage.",
		type: "fact",
		tags: ["drizzle", "ownership"],
	});
	const recalled = await client.recall({
		entityId,
		query: "Drizzle ownership",
		limit: 5,
		minScore: 0,
	});

	return {
		remembered: {
			content: remembered.content,
			type: remembered.type,
			tags: remembered.tags,
		},
		recalled: recalled.map((memory) => ({
			content: memory.content,
			type: memory.type,
			tags: memory.tags,
		})),
	};
}

describe("drizzleStore integration", () => {
	test.skipIf(!databaseUrl)(
		"reuses a caller-owned postgres.js Drizzle instance after client close",
		async () => {
			const callerSql = postgres(databaseUrl ?? "", { max: 3 });
			await applyMigrations(callerSql);

			const callerDb = drizzle(callerSql, { schema: callerSchema });
			const callerEntityId = `drizzle_store_${Date.now()}_${Math.random().toString(36).slice(2)}`;
			const urlEntityId = `${callerEntityId}_url`;
			const callerClient = createMnemocyte({
				store: drizzleStore(callerDb),
				embedder,
			});
			const urlClient = createMnemocyte({
				databaseUrl: databaseUrl ?? "",
				embedder,
			});
			let callerClosed = false;
			let urlClosed = false;

			try {
				const callerResult = await exerciseRepresentativePath(
					callerClient,
					callerEntityId,
				);
				const urlResult = await exerciseRepresentativePath(
					urlClient,
					urlEntityId,
				);
				expect(callerResult).toEqual(urlResult);

				await callerClient.close();
				callerClosed = true;

				const probe = await callerDb.execute(
					drizzleSql`select 1 as caller_connection_is_open`,
				);
				expect(probe).toHaveLength(1);

				await urlClient.close();
				urlClosed = true;
			} finally {
				if (!callerClosed) {
					await callerClient.close();
				}
				if (!urlClosed) {
					await urlClient.close();
				}
				await callerSql`DELETE FROM mnemocyte_memories WHERE entity_id IN (${callerEntityId}, ${urlEntityId})`;
				await callerSql.end();
			}
		},
		60_000,
	);
});
