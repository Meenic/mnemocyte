import { describe, expect, test } from "vitest";
import {
	assertSqlExecutor,
	INSERT_CHUNK_ROWS,
	runAtomically,
} from "../../src/db/atomic.js";
import { runPostgresMigrations } from "../../src/db/migrations/runner.js";
import { insertEvents } from "../../src/db/queries/events.js";
import {
	insertMemories,
	type NewMemoryRow,
	vectorSearch,
} from "../../src/db/queries/memories.js";
import { createPostgresStore } from "../../src/memory/postgres.js";
import { createUuidV7 } from "../../src/memory/records.js";
import type {
	SqlExecutor,
	SqlQueryOptions,
	SqlStatement,
} from "../../src/sql/executor.js";
import { expectMnemocyteError } from "../helpers.js";
import { testStoreScope, testVisibility } from "../store-helpers.js";

interface Recorded {
	queries: SqlStatement[];
	batches: SqlStatement[][];
	transactions: number;
	signals: Array<AbortSignal | undefined>;
}

/**
 * An executor whose statements return `rowsFor(sql)`. `batch` and
 * `transaction` exist only when asked for.
 */
function createExecutor(
	options: {
		batch?: boolean;
		transaction?: boolean;
		rowsFor?: (sql: string) => Record<string, unknown>[];
	} = {},
): { executor: SqlExecutor; recorded: Recorded } {
	const recorded: Recorded = {
		queries: [],
		batches: [],
		transactions: 0,
		signals: [],
	};
	const rowsFor = options.rowsFor ?? (() => []);
	const executor: SqlExecutor = {
		async query<Row>(
			sql: string,
			params: readonly unknown[],
			queryOptions?: SqlQueryOptions,
		): Promise<Row[]> {
			recorded.queries.push({ sql, params });
			recorded.signals.push(queryOptions?.signal);
			return rowsFor(sql) as Row[];
		},
	};
	if (options.transaction) {
		executor.transaction = async (fn) => {
			recorded.transactions += 1;
			return fn(executor);
		};
	}
	if (options.batch) {
		executor.batch = async (statements, batchOptions) => {
			recorded.batches.push([...statements]);
			recorded.signals.push(batchOptions?.signal);
			return statements.map((statement) => rowsFor(statement.sql));
		};
	}
	return { executor, recorded };
}

function newMemoryRow(index: number): NewMemoryRow {
	const now = new Date("2026-11-12T00:00:00.000Z");
	return {
		id: createUuidV7(),
		scope: testStoreScope("alice"),
		key: null,
		content: `memory ${index}`,
		kind: "fact",
		importance: "normal",
		tags: [],
		source: null,
		metadata: {},
		confidence: 1,
		embedding: [1, 0, 0],
		embeddingModel: "test",
		embeddingDimensions: 3,
		supersededBy: null,
		supersededAt: null,
		expiresAt: null,
		lastAccessedAt: null,
		accessCount: 0,
		createdAt: now,
		updatedAt: now,
	};
}

const PARAMS_PER_MEMORY_ROW = 23;

describe("runAtomically", () => {
	const statements: SqlStatement[] = [
		{ sql: "SELECT 1", params: [] },
		{ sql: "SELECT 2", params: [] },
	];

	test("sends a single statement through query, without a transaction", async () => {
		const { executor, recorded } = createExecutor({
			batch: true,
			transaction: true,
		});

		await runAtomically(executor, [{ sql: "SELECT 1", params: [] }]);

		expect(recorded.queries).toHaveLength(1);
		expect(recorded.batches).toHaveLength(0);
		expect(recorded.transactions).toBe(0);
	});

	test("prefers batch when the executor has both", async () => {
		const { executor, recorded } = createExecutor({
			batch: true,
			transaction: true,
			rowsFor: (sql) => [{ sql }],
		});

		const results = await runAtomically(executor, statements);

		expect(results).toEqual([[{ sql: "SELECT 1" }], [{ sql: "SELECT 2" }]]);
		expect(recorded.batches).toEqual([statements]);
		expect(recorded.transactions).toBe(0);
	});

	test("falls back to one transaction that sends the statements in order", async () => {
		const { executor, recorded } = createExecutor({
			transaction: true,
			rowsFor: (sql) => [{ sql }],
		});

		const results = await runAtomically(executor, statements);

		expect(results).toEqual([[{ sql: "SELECT 1" }], [{ sql: "SELECT 2" }]]);
		expect(recorded.transactions).toBe(1);
		expect(recorded.queries.map((query) => query.sql)).toEqual([
			"SELECT 1",
			"SELECT 2",
		]);
	});

	test("rejects a batch that returns the wrong number of results", async () => {
		const { executor } = createExecutor();
		executor.batch = async () => [[]];

		await expectMnemocyteError(runAtomically(executor, statements), "DB");
	});

	test("rejects an executor without transaction or batch", async () => {
		const { executor } = createExecutor();

		await expectMnemocyteError(runAtomically(executor, statements), "CONFIG");
	});
});

describe("assertSqlExecutor", () => {
	test("accepts query with transaction, with batch, or with both", () => {
		for (const options of [
			{ transaction: true },
			{ batch: true },
			{ transaction: true, batch: true },
		]) {
			expect(() =>
				assertSqlExecutor(createExecutor(options).executor),
			).not.toThrow();
		}
	});

	test.each([
		["no client", undefined],
		["no query", { transaction: async () => undefined }],
		["neither transaction nor batch", { query: async () => [] }],
	])("rejects %s as a config error", (_name, client) => {
		expect(() => assertSqlExecutor(client)).toThrow(
			expect.objectContaining({ code: "CONFIG" }),
		);
	});

	test("createPostgresStore checks the executor", () => {
		expect(() =>
			createPostgresStore({ query: async () => [] } as SqlExecutor),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});
});

describe("chunked memory inserts", () => {
	test(`splits rows into INSERTs of at most ${INSERT_CHUNK_ROWS} rows in one batch`, async () => {
		const { executor, recorded } = createExecutor({ batch: true });
		const rows = Array.from({ length: 2 * INSERT_CHUNK_ROWS + 1 }, (_, index) =>
			newMemoryRow(index),
		);
		const controller = new AbortController();

		await insertMemories(executor, rows, "vector", controller.signal);

		expect(recorded.queries).toHaveLength(0);
		expect(recorded.batches).toHaveLength(1);
		const [batch = []] = recorded.batches;
		expect(batch.map((statement) => statement.params.length)).toEqual([
			INSERT_CHUNK_ROWS * PARAMS_PER_MEMORY_ROW,
			INSERT_CHUNK_ROWS * PARAMS_PER_MEMORY_ROW,
			PARAMS_PER_MEMORY_ROW,
		]);
		for (const statement of batch) {
			expect(statement.sql).toMatch(/^INSERT INTO mnemocyte_memories/);
			// Placeholders restart at $1 in every statement.
			expect(statement.sql).toContain("$1::uuid");
		}
		expect(recorded.signals).toEqual([controller.signal]);
	});

	test("stays under postgres.js's 65,534-parameter limit per statement", () => {
		expect(INSERT_CHUNK_ROWS * PARAMS_PER_MEMORY_ROW).toBeLessThan(65_534);
	});

	test("uses one transaction when the executor has no batch", async () => {
		const { executor, recorded } = createExecutor({ transaction: true });
		const rows = Array.from({ length: INSERT_CHUNK_ROWS + 1 }, (_, index) =>
			newMemoryRow(index),
		);

		await insertMemories(executor, rows, "vector");

		expect(recorded.transactions).toBe(1);
		expect(recorded.queries).toHaveLength(2);
	});

	test("sends one statement with no transaction when the rows fit in a chunk", async () => {
		const { executor, recorded } = createExecutor({
			batch: true,
			transaction: true,
		});

		await insertMemories(executor, [newMemoryRow(0)], "vector");

		expect(recorded.queries).toHaveLength(1);
		expect(recorded.batches).toHaveLength(0);
		expect(recorded.transactions).toBe(0);
	});

	test("returns the rows of every chunk", async () => {
		const id = createUuidV7();
		const { executor } = createExecutor({
			batch: true,
			rowsFor: () => [
				{
					id,
					namespace: "test",
					entityId: "alice",
					agentId: null,
					sessionId: null,
					key: null,
					content: "c",
					kind: "fact",
					importance: "normal",
					tags: [],
					source: null,
					metadata: "{}",
					confidence: 1,
					embeddingModel: "test",
					embeddingDimensions: 3,
					supersededBy: null,
					supersededAt: null,
					expiresAt: null,
					lastAccessedAt: null,
					accessCount: 0,
					createdAt: "2026-11-12T00:00:00.000Z",
					updatedAt: "2026-11-12T00:00:00.000Z",
				},
			],
		});
		const rows = Array.from({ length: INSERT_CHUNK_ROWS + 1 }, (_, index) =>
			newMemoryRow(index),
		);

		const inserted = await insertMemories(executor, rows, "vector");

		expect(inserted).toHaveLength(2);
		expect(inserted.every((row) => row.id === id)).toBe(true);
	});
});

describe("batched audit inserts", () => {
	test("writes events as multi-row INSERTs", async () => {
		const { executor, recorded } = createExecutor({ batch: true });
		const events = Array.from({ length: INSERT_CHUNK_ROWS + 1 }, () => ({
			id: createUuidV7(),
			scope: testStoreScope("alice"),
			description: "Memory created",
			metadata: {},
			timestamp: new Date(),
		}));

		await insertEvents(executor, events);

		const [batch = []] = recorded.batches;
		expect(batch).toHaveLength(2);
		expect(batch.map((statement) => statement.params.length)).toEqual([
			INSERT_CHUNK_ROWS * 8,
			8,
		]);
	});

	test("sends nothing for no events", async () => {
		const { executor, recorded } = createExecutor({ batch: true });

		await insertEvents(executor, []);

		expect(recorded.queries).toHaveLength(0);
		expect(recorded.batches).toHaveLength(0);
	});
});

describe("vector search through batch", () => {
	test("sends the settings and the query as one batch and returns the query's rows", async () => {
		const { executor, recorded } = createExecutor({
			batch: true,
			transaction: true,
		});

		const rows = await vectorSearch(executor, {
			visibility: testVisibility("alice"),
			embedding: [1, 0, 0],
			limit: 150,
			vectorType: "vector",
		});

		expect(rows).toEqual([]);
		expect(recorded.transactions).toBe(0);
		const [batch = []] = recorded.batches;
		expect(batch).toHaveLength(2);
		expect(batch[0]?.sql).toContain(
			"set_config('hnsw.iterative_scan', 'strict_order', true)",
		);
		expect(batch[0]?.params).toEqual(["150"]);
		expect(batch[1]?.sql).toContain('ORDER BY "vectorDistance"');
	});
});

describe("migrate without interactive transactions", () => {
	test("is a config error for a batch-only executor", async () => {
		const { executor, recorded } = createExecutor({ batch: true });

		await expectMnemocyteError(
			runPostgresMigrations(executor, { dimensions: 3 }),
			"CONFIG",
		);
		expect(recorded.queries).toHaveLength(0);
	});
});
