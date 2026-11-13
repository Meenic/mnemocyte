import { sqlUuidV7 } from "../../../src/db/sql.js";
import type { SqlExecutor } from "../../../src/sql/executor.js";

export const BENCH_MODEL = "mnemocyte-bench";
const HNSW_INDEX = "mnemocyte_memories_embedding_hnsw_idx";
const CENTERS = 256;
/** Words `w0`…`w1999`, drawn as `2000 · random()³`, so low numbers are common. */
const VOCABULARY = 2000;

export interface EntitySpec {
	entityId: string;
	size: number;
}

export interface SeedMemoriesInput {
	namespace: string;
	dimensions: number;
	vectorType: "vector" | "halfvec";
	entities: readonly EntitySpec[];
}

export interface SeedResult {
	rows: number;
	loadMs: number;
	vacuumMs: number;
	hnswBuildMs: number;
}

/** Drops Mnemocyte's tables and the benchmark's helper tables. */
export async function resetSchema(db: SqlExecutor): Promise<void> {
	await db.query(
		`DROP TABLE IF EXISTS mnemocyte_memories, mnemocyte_events, mnemocyte_meta,
			mnemocyte_migrations, mnemocyte_bench_centers, mnemocyte_bench_slots CASCADE`,
		[],
	);
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
	const start = performance.now();
	await fn();
	return performance.now() - start;
}

function toVector(expression: string, input: SeedMemoriesInput): string {
	const cast = `${expression}::real[]::vector(${input.dimensions})`;
	return input.vectorType === "halfvec"
		? `${cast}::halfvec(${input.dimensions})`
		: cast;
}

/**
 * Seeds memories into a migrated, empty schema, the way an application that
 * has run for a year would have written them:
 *
 * - Rows of all entities are interleaved in time order (one year), so an
 *   entity's rows are spread over the heap instead of sitting together.
 * - Each embedding is one of 256 random cluster centers plus uniform noise
 *   (cosine about 0.6 within a cluster, about 0 across clusters).
 * - Per entity, in creation order: position 10n+1 is a near-copy of 10n
 *   (cosine above 0.99), 10n+5 is superseded by 10n+4, 10n+3 has a key, and
 *   every 20n+7 has expired. Contents are 12–30 words from a skewed
 *   vocabulary, kinds and importance follow fixed shares, and rows have 0–3
 *   of 20 tags.
 * - Every memory has its `memory.created` audit event.
 *
 * The HNSW index is dropped before the load and rebuilt from its own
 * definition afterwards, as pgvector recommends for an initial load; the
 * build time is returned. `random()` is seeded, so a run on the same server
 * version produces the same data.
 */
export async function seedMemories(
	db: SqlExecutor,
	input: SeedMemoriesInput,
): Promise<SeedResult> {
	const { dimensions } = input;
	const total = input.entities.reduce((sum, entity) => sum + entity.size, 0);
	const [indexDef] = await db.query<{ def: string }>(
		"SELECT pg_get_indexdef($1::regclass) AS def",
		[HNSW_INDEX],
	);
	if (!indexDef) {
		throw new Error(`${HNSW_INDEX} is missing; run migrate first.`);
	}
	await db.query(`DROP INDEX ${HNSW_INDEX}`, []);
	await db.query("SELECT setseed(0.42)", []);

	const loadMs = await timed(async () => {
		await db.query(
			`CREATE UNLOGGED TABLE mnemocyte_bench_centers AS
			SELECT c, ARRAY(
				SELECT random() * 2 - 1 FROM generate_series(1, ${dimensions}) WHERE c >= 0
			) AS v
			FROM generate_series(0, ${CENTERS - 1}) AS c`,
			[],
		);
		await db.query(
			`CREATE UNLOGGED TABLE mnemocyte_bench_slots AS
			WITH slots AS (
				SELECT e."entityId" AS entity_id, pos,
					row_number() OVER (ORDER BY random()) AS g
				FROM jsonb_to_recordset($1::text::jsonb) AS e("entityId" text, size int)
				CROSS JOIN LATERAL generate_series(0, e.size - 1) AS pos
			),
			timed AS (
				SELECT *, now() - interval '365 days'
					+ g * (interval '365 days' / ${total}) AS created_at
				FROM slots
			)
			SELECT *, ${sqlUuidV7("created_at")} AS id,
				floor(random() * ${CENTERS})::int AS center
			FROM timed`,
			[JSON.stringify(input.entities)],
		);
		await db.query(
			"CREATE INDEX ON mnemocyte_bench_slots (entity_id, pos)",
			[],
		);
		await db.query(
			`INSERT INTO mnemocyte_memories (
				id, namespace, entity_id, key, content, kind, importance, tags,
				embedding, embedding_model, embedding_dimensions, expires_at,
				created_at, updated_at
			)
			SELECT s.id, $1, s.entity_id,
				CASE WHEN s.pos % 10 = 3 THEN 'k' || s.pos END,
				(SELECT string_agg('w' || floor(${VOCABULARY} * random() ^ 3)::int, ' ')
					FROM generate_series(1, 12 + s.g % 19)),
				CASE
					WHEN s.g % 20 < 10 THEN 'fact'
					WHEN s.g % 20 < 15 THEN 'preference'
					WHEN s.g % 20 < 17 THEN 'instruction'
					WHEN s.g % 20 = 17 THEN 'backstory'
					WHEN s.g % 20 = 18 THEN 'episode'
					ELSE 'session'
				END,
				CASE
					WHEN s.g % 100 = 2 THEN 'critical'
					WHEN s.g % 10 = 0 THEN 'high'
					WHEN s.g % 50 = 1 THEN 'low'
					ELSE 'normal'
				END,
				ARRAY(SELECT DISTINCT 't' || floor(random() * 20)::int
					FROM generate_series(1, s.g % 4)),
				${toVector(
					`(SELECT array_agg(u.x + (random() * 1.6 - 0.8) ORDER BY u.i)
					FROM mnemocyte_bench_centers AS c, unnest(c.v) WITH ORDINALITY AS u(x, i)
					WHERE c.c = s.center)`,
					input,
				)},
				$2, ${dimensions},
				CASE WHEN s.pos % 20 = 7 THEN s.created_at + interval '30 days' END,
				s.created_at, s.created_at
			FROM (SELECT * FROM mnemocyte_bench_slots ORDER BY g) AS s`,
			[input.namespace, BENCH_MODEL],
		);
		await db.query(
			`UPDATE mnemocyte_memories AS m
			SET embedding = ${toVector(
				`(SELECT array_agg(u.x + (random() * 0.1 - 0.05) ORDER BY u.i)
				FROM unnest(src.embedding::vector::real[]) WITH ORDINALITY AS u(x, i))`,
				input,
			)}
			FROM mnemocyte_bench_slots AS s, mnemocyte_bench_slots AS sp,
				mnemocyte_memories AS src
			WHERE m.id = s.id AND s.pos % 10 = 1
				AND sp.entity_id = s.entity_id AND sp.pos = s.pos - 1
				AND src.id = sp.id`,
			[],
		);
		await db.query(
			`UPDATE mnemocyte_memories AS m
			SET superseded_by = sp.id, superseded_at = s.created_at + interval '1 day'
			FROM mnemocyte_bench_slots AS s, mnemocyte_bench_slots AS sp
			WHERE m.id = s.id AND s.pos % 10 = 5
				AND sp.entity_id = s.entity_id AND sp.pos = s.pos - 1`,
			[],
		);
		await db.query(
			`INSERT INTO mnemocyte_events (id, namespace, entity_id, description, metadata, timestamp)
			SELECT ${sqlUuidV7("created_at")}, namespace, entity_id, 'memory.created',
				jsonb_build_object('memoryId', id::text), created_at
			FROM mnemocyte_memories
			ORDER BY created_at`,
			[],
		);
		await db.query(
			"UPDATE mnemocyte_meta SET embedding_model = $1 WHERE key = 'installation'",
			[BENCH_MODEL],
		);
	});

	// The updates left a dead version of a fifth of the rows; rewrite the
	// tables so the heap looks like one written by inserts.
	const vacuumMs = await timed(async () => {
		await db.query("VACUUM FULL mnemocyte_memories", []);
		await db.query("VACUUM FULL mnemocyte_events", []);
	});

	const hnswBuildMs = await timed(async () => {
		await db.query("SET maintenance_work_mem = '1GB'", []);
		try {
			await db.query(indexDef.def, []);
		} finally {
			await db.query("RESET maintenance_work_mem", []);
		}
	});
	await db.query("VACUUM (ANALYZE) mnemocyte_memories", []);
	await db.query("VACUUM (ANALYZE) mnemocyte_events", []);
	return { rows: total, loadMs, vacuumMs, hnswBuildMs };
}

export interface SeedEventsInput {
	total: number;
	namespaces: number;
	entitiesPerNamespace: number;
	days: number;
}

/**
 * Replaces the audit log with `total` events appended in time order over
 * `days` days, spread evenly over the namespaces (`audit_<n>`) and their
 * entities (`entity_<n>`).
 */
export async function seedEvents(
	db: SqlExecutor,
	input: SeedEventsInput,
): Promise<number> {
	return timed(async () => {
		await db.query("TRUNCATE mnemocyte_events", []);
		await db.query(
			`INSERT INTO mnemocyte_events (id, namespace, entity_id, description, metadata, timestamp)
			SELECT ${sqlUuidV7("t")}, 'audit_' || (g % ${input.namespaces}),
				'entity_' || ((g / ${input.namespaces}) % ${input.entitiesPerNamespace}),
				'memory.created', '{}'::jsonb, t
			FROM generate_series(1, ${input.total}) AS g,
				LATERAL (SELECT now() - interval '${input.days} days'
					+ g * (interval '${input.days} days' / ${input.total}) AS t) AS times`,
			[],
		);
		await db.query("VACUUM (ANALYZE) mnemocyte_events", []);
	});
}

export interface RelationSize {
	name: string;
	bytes: number;
}

/** Heap (with TOAST) and index sizes of Mnemocyte's tables. */
export async function relationSizes(db: SqlExecutor): Promise<RelationSize[]> {
	const rows = await db.query<{ name: string; bytes: string | number }>(
		`SELECT c.relname AS name,
			CASE WHEN c.relkind = 'r'
				THEN pg_table_size(c.oid) ELSE pg_relation_size(c.oid) END AS bytes
		FROM pg_class AS c
		JOIN pg_namespace AS n ON n.oid = c.relnamespace
		WHERE n.nspname = current_schema()
			AND c.relkind IN ('r', 'i')
			AND c.relname LIKE 'mnemocyte\\_%'
			AND c.relname NOT LIKE 'mnemocyte\\_bench\\_%'
		ORDER BY c.relname`,
		[],
	);
	return rows.map((row) => ({ name: row.name, bytes: Number(row.bytes) }));
}

export function formatBytes(bytes: number): string {
	if (bytes >= 1024 ** 3) {
		return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
	}
	if (bytes >= 1024 ** 2) {
		return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
	}
	return `${(bytes / 1024).toFixed(0)} kB`;
}
