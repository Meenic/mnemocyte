import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createMnemocyte, type Embedder, migrate } from "mnemocyte";
import {
	postgresJs,
	postgresStore,
	type SqlExecutor,
} from "mnemocyte/postgres";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const MODEL = "mnemocyte-integration-test";
const HNSW_INDEX = "mnemocyte_memories_embedding_hnsw_idx";

// 400 facts sit next to the query vector and 5 preferences sit further away,
// so pgvector's default 40-row HNSW candidate list holds only facts and a
// `types: ["preference"]` filter used to leave nothing.
const NEAR_COUNT = 400;
const FAR_COUNT = 5;

type Sql = ReturnType<typeof postgres>;

interface RecordedQuery {
	text: string;
	params: readonly unknown[];
}

/** Delegates to `inner` and records the recall vector query. */
function recordVectorQueries(
	inner: SqlExecutor,
	recorded: RecordedQuery[],
): SqlExecutor {
	return {
		query(text, params, options) {
			if (text.includes('"vectorDistance"')) {
				recorded.push({ text, params });
			}
			return inner.query(text, params, options);
		},
		transaction(fn) {
			return inner.transaction((tx) => fn(recordVectorQueries(tx, recorded)));
		},
	};
}

/** Deterministic vector with components in [-0.5, 0.5), seeded by `text`. */
function seededVector(text: string, dimensions: number): number[] {
	// FNV-1a for the seed, then mulberry32.
	let state = 2166136261;
	for (const char of text) {
		state = Math.imul(state ^ (char.codePointAt(0) ?? 0), 16777619);
	}
	return Array.from({ length: dimensions }, () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
	});
}

/**
 * Facts are the query plus a little noise; preferences point in unrelated
 * directions. Equidistant hand-made vectors would not do: they leave parts of
 * the HNSW graph unreachable, so no `ef_search` finds them.
 */
function embedder(dimensions: number): Embedder {
	const query = seededVector("query", dimensions);
	return {
		model: MODEL,
		dimensions,
		async embed(texts) {
			return texts.map((text) => {
				const own = seededVector(text, dimensions);
				return text.startsWith("near-")
					? query.map((value, index) => value + 0.1 * (own[index] ?? 0))
					: text === "query"
						? query
						: own;
			});
		},
	};
}

async function seed(
	client: ReturnType<typeof createMnemocyte>,
	entityId: string,
): Promise<void> {
	await client.rememberMany({
		inputs: [
			...Array.from({ length: NEAR_COUNT }, (_, index) => ({
				entityId,
				content: `near-${index}`,
				type: "fact" as const,
			})),
			...Array.from({ length: FAR_COUNT }, (_, index) => ({
				entityId,
				content: `far-${index}`,
				type: "preference" as const,
			})),
		],
	});
}

/** Thrown to roll back the setup transaction after a check passes. */
class Rollback extends Error {}

/**
 * Run `check` in a transaction that is always rolled back. `setup` runs first
 * and can change the schema; the planner is steered off sequential and bitmap
 * scans and the per-scope btree index is dropped, as on a scope large enough
 * for the planner to pick the HNSW index by itself. (On a small scope it
 * reads the scope index and sorts, which is exact.)
 */
async function inRolledBackTransaction(
	sql: Sql,
	setup: (tx: Sql) => Promise<void>,
	check: (tx: Sql) => Promise<void>,
): Promise<void> {
	try {
		await sql.begin(async (transaction) => {
			const tx = transaction as unknown as Sql;
			await tx`SET LOCAL enable_seqscan = off`;
			await tx`SET LOCAL enable_bitmapscan = off`;
			await tx`DROP INDEX mnemocyte_memories_scope_idx`;
			await setup(tx);
			await check(tx);
			throw new Rollback();
		});
	} catch (error) {
		if (!(error instanceof Rollback)) {
			throw error;
		}
	}
}

/** Run a recorded query after setting the HNSW settings for the transaction. */
async function runWithSettings<Row extends object>(
	tx: Sql,
	settings: { iterativeScan: string; efSearch: number },
	query: RecordedQuery,
	prefix = "",
): Promise<Row[]> {
	await tx`SELECT set_config('hnsw.iterative_scan', ${settings.iterativeScan}, true),
		set_config('hnsw.ef_search', ${String(settings.efSearch)}, true)`;
	return tx.unsafe<Row[]>(
		`${prefix}${query.text}`,
		query.params as postgres.ParameterOrJSON<never>[],
	);
}

async function checkFilteredRecall(tx: Sql, dimensions: number): Promise<void> {
	const entityId = `filtered_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const recorded: RecordedQuery[] = [];
	const client = createMnemocyte({
		store: postgresStore({
			client: recordVectorQueries(postgresJs(tx), recorded),
		}),
		embedder: embedder(dimensions),
	});
	await seed(client, entityId);

	const recalled = await client.recall({
		entityId,
		query: "query",
		types: ["preference"],
		limit: FAR_COUNT,
		minScore: 0,
	});
	expect(recalled.map((memory) => memory.content).sort()).toEqual(
		Array.from({ length: FAR_COUNT }, (_, index) => `far-${index}`),
	);

	const [query] = recorded;
	if (!query) {
		throw new Error("Expected the recall vector query to be recorded.");
	}
	const recallSettings = { iterativeScan: "strict_order", efSearch: 40 };

	const plan = await runWithSettings<{ "QUERY PLAN": string }>(
		tx,
		recallSettings,
		query,
		"EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ",
	);
	const planText = plan.map((row) => row["QUERY PLAN"]).join("\n");
	expect(planText).toContain(`Index Scan using ${HNSW_INDEX}`);
	expect(planText).not.toMatch(/\bSort\b/);

	// The same statement without an iterative scan (pgvector before 0.8, or
	// Mnemocyte before this fix) finds none of the preferences.
	const withoutIterative = await runWithSettings<{ content: string }>(
		tx,
		{ iterativeScan: "off", efSearch: 40 },
		query,
	);
	expect(withoutIterative).toHaveLength(0);
}

describe.skipIf(!databaseUrl)("Postgres filtered vector search", () => {
	const sql = postgres(databaseUrl ?? "postgres://unused", { max: 1 });

	beforeAll(async () => {
		await sql`CREATE EXTENSION IF NOT EXISTS vector`;
		await migrate({
			store: postgresStore({ client: postgresJs(sql) }),
			dimensions: 1536,
		});
	});

	afterAll(async () => {
		await sql.end();
	});

	test("returns filtered matches beyond the first HNSW candidates (vector)", async () => {
		await inRolledBackTransaction(
			sql,
			async () => {},
			(tx) => checkFilteredRecall(tx, 1536),
		);
	}, 60_000);

	test("returns filtered matches beyond the first HNSW candidates (halfvec)", async () => {
		await inRolledBackTransaction(
			sql,
			async (tx) => {
				await tx.unsafe(`DROP INDEX ${HNSW_INDEX}`);
				await tx`ALTER TABLE mnemocyte_memories
					ALTER COLUMN embedding TYPE halfvec(3072) USING NULL`;
				await tx.unsafe(
					`CREATE INDEX ${HNSW_INDEX} ON mnemocyte_memories USING hnsw (embedding halfvec_cosine_ops)`,
				);
				await tx`UPDATE mnemocyte_meta
					SET vector_type = 'halfvec', embedding_dimensions = 3072, embedding_model = ${MODEL}`;
			},
			(tx) => checkFilteredRecall(tx, 3072),
		);
	}, 60_000);
});
