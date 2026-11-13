import { createMemory, type Embedder, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { expect } from "vitest";
import { encodeListCursor } from "../../../src/memory/cursor.js";
import type { SqlExecutor, SqlStatement } from "../../../src/sql/executor.js";
import {
	capture,
	createRecorder,
	findStatement,
	type Measurement,
	measure,
	rolledBack,
	runRolledBack,
} from "./explain.js";
import type { Report } from "./report.js";
import {
	BENCH_MODEL,
	type EntitySpec,
	formatBytes,
	relationSizes,
	resetSchema,
	seedEvents,
	seedMemories,
} from "./seed.js";

export interface BenchContext {
	/** One connection: session settings and `random()`'s seed stay on it. */
	db: SqlExecutor;
	report: Report;
	/** Measured runs per case, after one warm-up run. */
	runs: number;
	/** Multiplies entity sizes and event counts; 1 is the documented dataset. */
	scale: number;
}

const NAMESPACE = "bench";
const LARGE = "large";
const MID = "mid";
const SMALL = "small_0042";
const QUERY = "w20";
const INDEX = {
	scope: "mnemocyte_memories_scope_idx",
	scopeKey: "mnemocyte_memories_scope_key_idx",
	superseded: "mnemocyte_memories_superseded_by_idx",
	tsv: "mnemocyte_memories_content_tsv_idx",
	hnsw: "mnemocyte_memories_embedding_hnsw_idx",
	events: "mnemocyte_events_scope_time_idx",
	pkey: "mnemocyte_memories_pkey",
} as const;
const drop = (index: string) => `DROP INDEX ${index}`;

/** mulberry32: a seeded generator in [0, 1). */
function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function scaled(ctx: BenchContext, size: number, minimum = 1): number {
	return Math.max(minimum, Math.round(size * ctx.scale));
}

function entities(
	ctx: BenchContext,
	{
		large,
		mid,
		smallCount,
	}: { large: number; mid: number; smallCount: number },
): EntitySpec[] {
	return [
		{ entityId: LARGE, size: scaled(ctx, large, 20) },
		{ entityId: MID, size: scaled(ctx, mid, 20) },
		...Array.from(
			{ length: Math.max(50, Math.round(smallCount * ctx.scale)) },
			(_, n) => ({
				entityId: `small_${String(n).padStart(4, "0")}`,
				size: 100,
			}),
		),
	];
}

/**
 * A memory client over a recording executor. Every embedding it is asked
 * for is `base` plus the in-cluster noise of the seeded data, so a query
 * lands near one stored memory's cluster and an `addMany` writes vectors
 * that look like stored ones.
 */
function benchClient(ctx: BenchContext, dimensions: number) {
	const recorder = createRecorder(ctx.db);
	const random = generator(11);
	let base: number[] = Array.from({ length: dimensions }, () => 0);
	const embedder: Embedder = {
		model: BENCH_MODEL,
		dimensions,
		async embed(texts) {
			return texts.map(() => base.map((x) => x + (random() * 1.6 - 0.8)));
		},
	};
	const memory = createMemory({
		namespace: NAMESPACE,
		store: postgresStore({ client: recorder.executor }),
		embedder,
	});
	return {
		recorder,
		memory,
		setBase(vector: number[]) {
			base = vector;
		},
	};
}

async function storedVector(
	db: SqlExecutor,
	entityId: string,
	offset: number,
): Promise<number[]> {
	const [row] = await db.query<{ v: string }>(
		`SELECT embedding::text AS v FROM mnemocyte_memories
		WHERE namespace = $1 AND entity_id = $2 AND superseded_by IS NULL
		ORDER BY id
		OFFSET $3::int % (SELECT greatest(1, count(*)) FROM mnemocyte_memories
			WHERE namespace = $1 AND entity_id = $2 AND superseded_by IS NULL)
		LIMIT 1`,
		[NAMESPACE, entityId, offset],
	);
	if (!row) {
		throw new Error(`No memory at offset ${offset} of ${entityId}.`);
	}
	return JSON.parse(row.v) as number[];
}

async function memoryIdAt(
	db: SqlExecutor,
	entityId: string,
	where: string,
): Promise<string> {
	const [row] = await db.query<{ id: string }>(
		`SELECT id::text AS id FROM mnemocyte_memories
		WHERE namespace = $1 AND entity_id = $2 AND ${where}
		ORDER BY id LIMIT 1`,
		[NAMESPACE, entityId],
	);
	if (!row) {
		throw new Error(`No memory of ${entityId} where ${where}.`);
	}
	return row.id;
}

/** Server version and the settings that decide the plans and timings. */
export async function describeServer(ctx: BenchContext): Promise<void> {
	const [server] = await ctx.db.query<Record<string, string>>(
		`SELECT current_setting('server_version') AS postgres,
			coalesce(
				(SELECT extversion FROM pg_extension WHERE extname = 'vector'),
				(SELECT default_version FROM pg_available_extensions WHERE name = 'vector') || ' (available)'
			) AS pgvector,
			current_setting('shared_buffers') AS shared_buffers,
			current_setting('work_mem') AS work_mem,
			current_setting('maintenance_work_mem') AS maintenance_work_mem,
			current_setting('effective_cache_size') AS effective_cache_size,
			current_setting('max_parallel_workers_per_gather') AS parallel_per_gather,
			current_setting('max_parallel_maintenance_workers') AS parallel_maintenance,
			current_setting('jit') AS jit,
			current_setting('random_page_cost') AS random_page_cost`,
		[],
	);
	ctx.report.note(
		`Server: ${Object.entries(server ?? {})
			.map(([key, value]) => `${key} ${value}`)
			.join(", ")}`,
	);
}

async function noteSizes(ctx: BenchContext): Promise<void> {
	const sizes = await relationSizes(ctx.db);
	ctx.report.note(
		`Sizes: ${sizes.map((s) => `${s.name} ${formatBytes(s.bytes)}`).join(", ")}`,
	);
}

async function setupMemories(
	ctx: BenchContext,
	dimensions: number,
	specs: EntitySpec[],
): Promise<void> {
	const vectorType = dimensions > 2000 ? "halfvec" : "vector";
	await resetSchema(ctx.db);
	await migrate({
		store: postgresStore({ client: ctx.db }),
		dimensions,
		createExtension: true,
	});
	const seeded = await seedMemories(ctx.db, {
		namespace: NAMESPACE,
		dimensions,
		vectorType,
		entities: specs,
	});
	ctx.report.note(
		`${seeded.rows} memories at ${dimensions} dimensions (${vectorType}): ${specs
			.slice(0, 2)
			.map((s) => `${s.entityId} ${s.size}`)
			.join(
				", ",
			)}, ${specs.length - 2} entities of 100. Load ${(seeded.loadMs / 1000).toFixed(1)} s, VACUUM FULL ${(seeded.vacuumMs / 1000).toFixed(1)} s, HNSW build ${(seeded.hnswBuildMs / 1000).toFixed(1)} s (maintenance_work_mem 1GB).`,
	);
	await noteSizes(ctx);
}

type Client = ReturnType<typeof benchClient>;

interface SearchStatements {
	settings: SqlStatement;
	vector: SqlStatement;
	lexical: SqlStatement;
}

async function searchStatements(
	client: Client,
	entityId: string,
	extra: { kinds?: ["instruction"] } = {},
): Promise<SearchStatements> {
	client.recorder.clear();
	await client.memory.search({
		scope: { entityId },
		query: QUERY,
		limit: 10,
		...extra,
	});
	const { log } = client.recorder;
	return {
		settings: findStatement(log, "hnsw.iterative_scan"),
		vector: findStatement(log, '"vectorDistance"'),
		lexical: findStatement(log, '"lexicalScore"'),
	};
}

const EXACT: SqlStatement = {
	sql: "SET LOCAL enable_indexscan = off",
	params: [],
};

/**
 * HNSW recall of the search vector query: the share of the exact nearest
 * rows (index scans off, so the scope's rows are read and sorted) that the
 * index returns, over `queries` queries near stored memories of the entity,
 * and how much farther the returned rows are on average (the mean distance
 * of the returned rows over that of the exact ones). `efSearch` replaces the
 * library's `hnsw.ef_search` when set.
 */
async function searchRecall(
	ctx: BenchContext,
	client: Client,
	entityId: string,
	queries: number,
	efSearch?: number,
): Promise<string> {
	let found = 0;
	let wanted = 0;
	let approximateDistance = 0;
	let exactDistance = 0;
	for (let n = 0; n < queries; n += 1) {
		client.setBase(await storedVector(ctx.db, entityId, n * 97));
		const statements = await searchStatements(client, entityId);
		const { vector } = statements;
		const settings =
			efSearch === undefined
				? statements.settings
				: { sql: statements.settings.sql, params: [String(efSearch)] };
		const rows = (prelude: SqlStatement[]) =>
			runRolledBack<{ id: string; vectorDistance: number | string }>(
				ctx.db,
				vector,
				prelude,
			);
		const approximate = await rows([settings]);
		const exact = await rows([settings, EXACT]);
		const ids = new Set(approximate.map((row) => row.id));
		wanted += exact.length;
		found += exact.filter((row) => ids.has(row.id)).length;
		approximateDistance += approximate.reduce(
			(sum, row) => sum + Number(row.vectorDistance),
			0,
		);
		exactDistance += exact.reduce(
			(sum, row) => sum + Number(row.vectorDistance),
			0,
		);
	}
	const gap = (approximateDistance / Math.max(1e-9, exactDistance) - 1) * 100;
	return `${found} of ${wanted} exact neighbors returned (${((found / Math.max(1, wanted)) * 100).toFixed(1)}%) over ${queries} queries; returned rows ${gap.toFixed(2)}% farther on average`;
}

async function duplicateStatements(
	client: Client,
	entityId: string,
): Promise<{ settings: SqlStatement; pairs: SqlStatement }> {
	client.recorder.clear();
	await client.memory.findDuplicates({ scope: { entityId }, limit: 1000 });
	const { log } = client.recorder;
	return {
		settings: findStatement(log, "hnsw.iterative_scan"),
		pairs: findStatement(log, "CROSS JOIN LATERAL"),
	};
}

async function duplicates(
	ctx: BenchContext,
	client: Client,
	section: string,
	entityId: string,
	options: { runs: number; recall: boolean },
): Promise<Measurement> {
	const { settings, pairs } = await duplicateStatements(client, entityId);
	const m = await measure(ctx.db, pairs, {
		prelude: [settings],
		runs: options.runs,
		cold: options.runs === 1,
	});
	ctx.report.add(section, {
		case: `findDuplicates, ${entityId}`,
		variant: "default",
		measurement: m,
	});
	if (options.recall) {
		const count = async (prelude: SqlStatement[]) =>
			(await runRolledBack(ctx.db, pairs, prelude)).length;
		const approximate = await count([settings]);
		const exact = await count([settings, EXACT]);
		ctx.report.add(section, {
			case: `findDuplicates, ${entityId}`,
			variant: "recall",
			note: `${approximate} pairs; exact (index scans off): ${exact}`,
		});
	}
	return m;
}

/** Search and duplicates on `halfvec(3072)`. */
export async function halfvecPhase(ctx: BenchContext): Promise<void> {
	const section = "halfvec(3072)";
	await setupMemories(
		ctx,
		3072,
		entities(ctx, { large: 30_000, mid: 2_000, smallCount: 100 }),
	);
	const client = benchClient(ctx, 3072);
	client.setBase(await storedVector(ctx.db, LARGE, 0));
	for (const entityId of [SMALL, LARGE]) {
		const { settings, vector } = await searchStatements(client, entityId);
		ctx.report.add(section, {
			case: `vector search, ${entityId}`,
			variant: "default",
			measurement: await measure(ctx.db, vector, {
				prelude: [settings],
				runs: ctx.runs,
			}),
		});
	}
	const { settings, vector } = await searchStatements(client, LARGE);
	ctx.report.add(section, {
		case: `vector search, ${LARGE}`,
		variant: "no HNSW",
		measurement: await measure(ctx.db, vector, {
			prelude: [settings],
			setup: [drop(INDEX.hnsw)],
			runs: ctx.runs,
		}),
	});
	ctx.report.add(section, {
		case: `vector search recall, ${LARGE}`,
		variant: "HNSW",
		note: await searchRecall(ctx, client, LARGE, 20),
	});
	await duplicates(ctx, client, section, MID, { runs: ctx.runs, recall: true });
}

/** Every default index on `vector(1536)`, with and without it. */
export async function vectorPhase(ctx: BenchContext): Promise<void> {
	await setupMemories(
		ctx,
		1536,
		entities(ctx, { large: 30_000, mid: 2_000, smallCount: 1_000 }),
	);
	const client = benchClient(ctx, 1536);
	const { db, runs } = ctx;
	client.setBase(await storedVector(db, LARGE, 0));

	// Vector search: HNSW and the scope index.
	let section = "vector search";
	for (const entityId of [SMALL, MID, LARGE]) {
		const { settings, vector } = await searchStatements(client, entityId);
		const m = await measure(db, vector, { prelude: [settings], runs });
		ctx.report.add(section, {
			case: entityId,
			variant: "default",
			measurement: m,
		});
		if (entityId === SMALL && ctx.scale === 1) {
			expect(m.indexes).toContain(INDEX.scope);
		}
	}
	{
		const { settings, vector } = await searchStatements(client, LARGE);
		ctx.report.add(section, {
			case: LARGE,
			variant: "no HNSW",
			measurement: await measure(db, vector, {
				prelude: [settings],
				setup: [drop(INDEX.hnsw)],
				runs,
			}),
		});
		const filtered = await searchStatements(client, LARGE, {
			kinds: ["instruction"],
		});
		ctx.report.add(section, {
			case: `${LARGE}, kinds: instruction`,
			variant: "default",
			measurement: await measure(db, filtered.vector, {
				prelude: [filtered.settings],
				runs,
			}),
		});
		const small = await searchStatements(client, SMALL);
		ctx.report.add(section, {
			case: SMALL,
			variant: "no scope index",
			measurement: await measure(db, small.vector, {
				prelude: [small.settings],
				setup: [drop(INDEX.scope)],
				runs,
			}),
		});
		ctx.report.add(section, {
			case: `recall, ${LARGE}`,
			variant: "HNSW",
			note: await searchRecall(ctx, client, LARGE, 20),
		});
		ctx.report.add(section, {
			case: `recall, ${LARGE}`,
			variant: "HNSW, ef_search 200",
			note: await searchRecall(ctx, client, LARGE, 20, 200),
		});
	}

	// Keyword search: the GIN index, and the rejected kind index.
	section = "keyword search";
	const kindIndex =
		"CREATE INDEX mnemocyte_bench_kind_idx ON mnemocyte_memories (namespace, entity_id, kind)";
	for (const entityId of [SMALL, LARGE]) {
		const { lexical } = await searchStatements(client, entityId);
		const m = await measure(db, lexical, { runs });
		ctx.report.add(section, {
			case: entityId,
			variant: "default",
			measurement: m,
		});
		if (entityId === LARGE && ctx.scale === 1) {
			expect(m.indexes).toContain(INDEX.tsv);
		}
		ctx.report.add(section, {
			case: entityId,
			variant: "no GIN",
			measurement: await measure(db, lexical, {
				setup: [drop(INDEX.tsv)],
				runs,
			}),
		});
		const filtered = await searchStatements(client, entityId, {
			kinds: ["instruction"],
		});
		ctx.report.add(section, {
			case: `${entityId}, kinds: instruction`,
			variant: "default",
			measurement: await measure(db, filtered.lexical, { runs }),
		});
		ctx.report.add(section, {
			case: `${entityId}, kinds: instruction`,
			variant: "+ (namespace, entity_id, kind)",
			measurement: await measure(db, filtered.lexical, {
				setup: [kindIndex],
				runs,
			}),
		});
	}

	// list pages and get by id. No index can serve the list order:
	// `date_trunc('milliseconds', created_at)` on a timestamptz is not
	// immutable, so it cannot be indexed.
	section = "list and get";
	const [middle] = await db.query<{ created_at: Date | string; id: string }>(
		`SELECT created_at, id::text AS id FROM mnemocyte_memories
		WHERE namespace = $1 AND entity_id = $2
		ORDER BY created_at DESC, id DESC OFFSET $3 LIMIT 1`,
		[NAMESPACE, LARGE, Math.floor(scaled(ctx, 30_000, 20) / 2)],
	);
	if (!middle) {
		throw new Error("No middle row in the large entity.");
	}
	const pages: Array<[string, string, string | undefined]> = [
		[`${SMALL}, first page`, SMALL, undefined],
		[`${LARGE}, first page`, LARGE, undefined],
		[
			`${LARGE}, middle page`,
			LARGE,
			encodeListCursor({
				createdAt: new Date(middle.created_at),
				id: middle.id,
			}),
		],
	];
	for (const [label, entityId, cursor] of pages) {
		client.recorder.clear();
		await client.memory.list({
			scope: { entityId },
			limit: 50,
			...(cursor ? { cursor } : {}),
		});
		const statement = findStatement(
			client.recorder.log,
			"FROM mnemocyte_memories",
		);
		const m = await measure(db, statement, { runs });
		ctx.report.add(section, {
			case: `list, ${label}`,
			variant: "default",
			measurement: m,
		});
		if (ctx.scale === 1) {
			expect(m.indexes).toContain(INDEX.scope);
		}
	}
	{
		const id = await memoryIdAt(db, SMALL, "superseded_by IS NULL");
		client.recorder.clear();
		await client.memory.get({ scope: { entityId: SMALL }, id });
		const statement = findStatement(
			client.recorder.log,
			"FROM mnemocyte_memories",
		);
		ctx.report.add(section, {
			case: "get by id",
			variant: "default",
			measurement: await measure(db, statement, { runs }),
		});
	}

	// Audit pages: the events scope index read backwards.
	section = "audit log";
	for (const entityId of [SMALL, LARGE]) {
		client.recorder.clear();
		await client.memory.listAuditLog({ scope: { entityId }, limit: 50 });
		const statement = findStatement(
			client.recorder.log,
			"FROM mnemocyte_events",
		);
		const m = await measure(db, statement, { runs });
		ctx.report.add(section, {
			case: `listAuditLog, ${entityId}`,
			variant: "default",
			measurement: m,
		});
		if (ctx.scale === 1) {
			expect(m.indexes).toContain(INDEX.events);
		}
		ctx.report.add(section, {
			case: `listAuditLog, ${entityId}`,
			variant: "no events index",
			measurement: await measure(db, statement, {
				setup: [drop(INDEX.events)],
				runs,
			}),
		});
	}

	// Duplicates: one HNSW scan per memory, or the scope index and a sort.
	section = "findDuplicates";
	await duplicates(ctx, client, section, SMALL, { runs, recall: true });
	await duplicates(ctx, client, section, MID, { runs, recall: true });
	{
		// Without the scope index the planner has only HNSW for the lateral
		// kNN, which shows what that path costs for a mid-sized scope.
		const { settings, pairs } = await duplicateStatements(client, MID);
		ctx.report.add(section, {
			case: `findDuplicates, ${MID}`,
			variant: "no scope index (HNSW path)",
			measurement: await measure(db, pairs, {
				prelude: [settings],
				setup: [drop(INDEX.scope)],
				runs: 1,
				cold: true,
			}),
		});
		const found = await rolledBack(db, async (tx) => {
			await tx.query(drop(INDEX.scope), []);
			await tx.query(settings.sql, settings.params);
			return (await tx.query(pairs.sql, pairs.params)).length;
		});
		ctx.report.add(section, {
			case: `findDuplicates, ${MID}`,
			variant: "no scope index, recall",
			note: `${found} pairs`,
		});
	}
	await duplicates(ctx, client, section, LARGE, { runs: 1, recall: false });

	// Deletes: the superseded_by index serves the foreign-key check and the
	// dependents check.
	section = "delete and prune";
	{
		const id = await memoryIdAt(
			db,
			LARGE,
			`superseded_by IS NULL AND key IS NULL AND NOT EXISTS (
				SELECT 1 FROM mnemocyte_memories AS d
				WHERE d.superseded_by = mnemocyte_memories.id)`,
		);
		client.recorder.block((s) =>
			s.sql.includes("DELETE FROM mnemocyte_memories"),
		);
		const statement = await capture(() =>
			client.memory.delete({ scope: { entityId: LARGE }, id }),
		);
		client.recorder.block(undefined);
		const m = await measure(db, statement, { runs });
		ctx.report.add(section, {
			case: `delete one, ${LARGE}`,
			variant: "default",
			measurement: m,
		});
		if (ctx.scale === 1) {
			expect(m.indexes).toContain(INDEX.superseded);
		}
		// The foreign-key trigger fires only when the row was deleted.
		expect(m.triggerMs).toBeGreaterThan(0);
		ctx.report.add(section, {
			case: `delete one, ${LARGE}`,
			variant: "no superseded_by index",
			measurement: await measure(db, statement, {
				setup: [drop(INDEX.superseded)],
				runs,
			}),
		});
	}
	{
		client.recorder.block((s) =>
			s.sql.includes("DELETE FROM mnemocyte_memories"),
		);
		const statement = await capture(() =>
			client.memory.prune({ scope: { entityId: LARGE }, superseded: true }),
		);
		client.recorder.block(undefined);
		ctx.report.add(section, {
			case: `prune superseded, ${LARGE}`,
			variant: "default",
			measurement: await measure(db, statement, { runs }),
		});
		ctx.report.add(section, {
			case: `prune superseded, ${LARGE}`,
			variant: "no superseded_by index",
			measurement: await measure(db, statement, {
				setup: [drop(INDEX.superseded)],
				runs: 1,
				cold: true,
			}),
		});
	}

	// Writes: what each index costs a 250-row addMany chunk, and the keyed
	// upsert's arbiter.
	section = "writes";
	{
		client.recorder.block((s) =>
			s.sql.includes("INSERT INTO mnemocyte_memories"),
		);
		const upsert = await capture(() =>
			client.memory.add({
				scope: { entityId: LARGE },
				key: "k3",
				content: "w20 w35 keyed",
			}),
		);
		const chunk = await capture(() =>
			client.memory.addMany({
				scope: { entityId: LARGE },
				memories: Array.from({ length: 250 }, (_, n) => ({
					content: `w${n % 50} w${(n * 7) % 300} benchmark insert ${n}`,
					tags: [`t${n % 20}`],
				})),
			}),
		);
		client.recorder.block(undefined);
		const m = await measure(db, upsert, { runs });
		ctx.report.add(section, {
			case: "keyed add (existing key)",
			variant: "default",
			measurement: m,
		});
		if (ctx.scale === 1) {
			expect(m.arbiters).toContain(
				INDEX.scopeKey.replace("mnemocyte_memories_", ""),
			);
		}
		const variants: Array<[string, string[]]> = [
			["default", []],
			["no HNSW", [drop(INDEX.hnsw)]],
			["no GIN", [drop(INDEX.tsv)]],
			["no scope index", [drop(INDEX.scope)]],
			["no superseded_by index", [drop(INDEX.superseded)]],
			[
				"no HNSW, GIN or btrees but the key",
				[
					drop(INDEX.hnsw),
					drop(INDEX.tsv),
					drop(INDEX.scope),
					drop(INDEX.superseded),
				],
			],
		];
		for (const [variant, setup] of variants) {
			ctx.report.add(section, {
				case: "addMany, 250 rows",
				variant,
				measurement: await measure(db, chunk, { setup, runs }),
			});
		}
	}
}

/**
 * `pruneAuditLog` over a large backlog: whole runs, and the middle batch of
 * each, measured in a rolled-back transaction before it runs for real, so it
 * sees the dead index entries of the batches before it.
 */
export async function auditPhase(ctx: BenchContext): Promise<void> {
	const section = "pruneAuditLog";
	const total = scaled(ctx, 1_000_000, 10_000);
	await resetSchema(ctx.db);
	await migrate({ store: postgresStore({ client: ctx.db }), dimensions: 1536 });
	const recorder = createRecorder(ctx.db);
	const memory = createMemory({
		store: postgresStore({ client: recorder.executor }),
		embedder: {
			model: BENCH_MODEL,
			dimensions: 1536,
			async embed(texts) {
				return texts.map(() => []);
			},
		},
	});
	const timeIndex =
		"CREATE INDEX mnemocyte_bench_events_time_idx ON mnemocyte_events (timestamp)";
	const cases: Array<{
		label: string;
		variant: string;
		input:
			| { allNamespaces: true }
			| { scope: { namespace: string; entityId?: string } };
		setup?: string;
	}> = [
		{
			label: "all namespaces",
			variant: "default",
			input: { allNamespaces: true },
		},
		{
			label: "one namespace",
			variant: "default",
			input: { scope: { namespace: "audit_3" } },
		},
		{
			label: "one entity",
			variant: "default",
			input: { scope: { namespace: "audit_3", entityId: "entity_42" } },
		},
		{
			label: "all namespaces",
			variant: "+ (timestamp) index",
			input: { allNamespaces: true },
			setup: timeIndex,
		},
	];
	const before = new Date(Date.now() - 90 * 24 * 3600 * 1000);
	for (const entry of cases) {
		const loadMs = await seedEvents(ctx.db, {
			total,
			namespaces: 10,
			entitiesPerNamespace: 100,
			days: 180,
		});
		if (entry.setup) {
			await ctx.db.query(entry.setup, []);
			await ctx.db.query("ANALYZE mnemocyte_events", []);
		}
		const { matchedCount: count } = await memory.pruneAuditLog({
			...entry.input,
			before,
			dryRun: true,
		});
		const batches = Math.ceil((count + 1) / 1000);
		const middle = Math.max(1, Math.ceil(batches / 2));
		let seen = 0;
		let middleBatch: Measurement | undefined;
		recorder.before(async (statement) => {
			if (!statement.sql.includes("DELETE FROM mnemocyte_events")) {
				return;
			}
			seen += 1;
			if (seen === middle) {
				middleBatch = await measure(ctx.db, statement, { runs: ctx.runs });
			}
		});
		const start = performance.now();
		const result = await memory.pruneAuditLog({
			...entry.input,
			before,
			batchSize: 1000,
		});
		const wallMs = performance.now() - start;
		recorder.before(undefined);
		if (entry.setup) {
			await ctx.db.query("DROP INDEX mnemocyte_bench_events_time_idx", []);
		}
		ctx.report.add(section, {
			case: `${entry.label}: ${result.deletedCount} of ${total} events`,
			variant: entry.variant,
			note: `whole run ${(wallMs / 1000).toFixed(2)} s in ${seen} batches (load ${(loadMs / 1000).toFixed(1)} s)`,
		});
		if (middleBatch) {
			ctx.report.add(section, {
				case: `${entry.label}: batch ${middle} of ${seen}`,
				variant: entry.variant,
				measurement: middleBatch,
			});
			if (ctx.scale === 1 && !entry.setup) {
				expect(middleBatch.indexes).toContain(INDEX.events);
			}
		}
	}
	await noteSizes(ctx);
}
