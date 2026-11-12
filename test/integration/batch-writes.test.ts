import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createMemory, type Embedder, type NewMemory } from "mnemocyte";
import {
	postgresJs,
	postgresStore,
	type SqlExecutor,
} from "mnemocyte/postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const DIMENSIONS = 1536;

type Sql = ReturnType<typeof postgres>;

async function applyMigrations(sql: Sql) {
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

/** A deterministic pseudo-random unit-ish vector per text. */
function embedText(text: string): number[] {
	let state = 2166136261;
	for (const char of text) {
		state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
	}
	return Array.from({ length: DIMENSIONS }, () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 2 ** 32 - 0.5;
	});
}

const embedder: Embedder = {
	model: "mnemocyte-integration-test",
	dimensions: DIMENSIONS,
	async embed(texts) {
		return texts.map(embedText);
	},
};

function memories(prefix: string, count: number): NewMemory[] {
	return Array.from({ length: count }, (_, index) => ({
		content: `${prefix} memory ${index}`,
	}));
}

/** postgres.js without `transaction`, like a stateless HTTP driver. */
function batchOnly(inner: SqlExecutor): SqlExecutor {
	return {
		query: (text, params, options) => inner.query(text, params, options),
		...(inner.batch ? { batch: inner.batch.bind(inner) } : {}),
	};
}

describe.skipIf(!databaseUrl)("Postgres batch writes", () => {
	let sql: Sql;
	const entityPrefix = `batch_writes_${Date.now()}_${Math.random().toString(36).slice(2)}`;

	beforeAll(async () => {
		sql = postgres(databaseUrl ?? "", { max: 2, onnotice: () => {} });
		await applyMigrations(sql);
	});

	afterAll(async () => {
		await sql`DELETE FROM mnemocyte_events WHERE entity_id LIKE ${`${entityPrefix}%`}`;
		await sql`DELETE FROM mnemocyte_memories WHERE entity_id LIKE ${`${entityPrefix}%`}`;
		await sql.end();
	});

	test("addMany writes 1,000 memories in four INSERT chunks", async () => {
		const scope = testScope(`${entityPrefix}_many`);
		const client = createMemory({
			store: postgresStore({ client: postgresJs(sql) }),
			embedder,
			audit: { enabled: true },
		});

		const added = await client.addMany({
			scope,
			memories: memories("many", 1000),
		});

		expect(added.map((memory) => memory.content)).toEqual(
			memories("many", 1000).map((memory) => memory.content),
		);
		const [row] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM mnemocyte_memories
			WHERE entity_id = ${scope.entityId}`;
		expect(row?.count).toBe(1000);
		const [events] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM mnemocyte_events
			WHERE entity_id = ${scope.entityId}`;
		expect(events?.count).toBe(1000);
	}, 60_000);

	test("a failing last chunk rolls back every chunk", async () => {
		const scope = testScope(`${entityPrefix}_rollback`);
		const client = createMemory({
			store: postgresStore({ client: postgresJs(sql) }),
			embedder,
		});
		const batch = memories("rollback", 1000);
		// Postgres text cannot hold a NUL byte (22021), so the fourth INSERT
		// fails after the first three ran.
		batch[999] = { content: "rollback memory \u0000" };

		await expectMnemocyteError(
			client.addMany({ scope, memories: batch }),
			"DB",
		);

		const [row] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM mnemocyte_memories
			WHERE entity_id = ${scope.entityId}`;
		expect(row?.count).toBe(0);
	}, 60_000);

	test("an executor with batch and no transaction writes and searches", async () => {
		const scope = testScope(`${entityPrefix}_batch_only`);
		const client = createMemory({
			store: postgresStore({ client: batchOnly(postgresJs(sql)) }),
			embedder,
		});

		await client.addMany({ scope, memories: memories("batch only", 300) });
		const results = await client.search({
			scope,
			query: "batch only memory 7",
			limit: 5,
		});

		expect(results[0]?.content).toBe("batch only memory 7");
		const [row] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM mnemocyte_memories
			WHERE entity_id = ${scope.entityId}`;
		expect(row?.count).toBe(300);
	}, 60_000);
});
