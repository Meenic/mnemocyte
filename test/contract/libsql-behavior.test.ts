import {
	createMemory,
	type Embedder,
	type MnemocyteObservation,
	migrate,
	setTextSearchConfig,
} from "mnemocyte";
import { libsqlStore } from "mnemocyte/libsql";
import { afterEach, describe, expect, test } from "vitest";
import { LIBSQL_CAPABILITIES } from "../../src/memory/capabilities.js";
import { readMemoryClientInternals } from "../../src/memory/client-internals.js";
import { expectMnemocyteError } from "../helpers.js";
import { type LibsqlDatabase, openLibsql } from "./libsql.js";

/** Three dimensions: word counts of "tea", "coffee" and everything else. */
const embedder: Embedder = {
	model: "libsql-behavior",
	dimensions: 3,
	async embed(texts) {
		return texts.map((text) => {
			const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
			const tea = words.filter((word) => word === "tea").length;
			const coffee = words.filter((word) => word === "coffee").length;
			return [tea, coffee, words.length - tea - coffee + 1];
		});
	},
};

const ALL_MIGRATIONS = ["0000_initial"];

const opened: LibsqlDatabase[] = [];

async function open(): Promise<LibsqlDatabase> {
	const database = await openLibsql();
	opened.push(database);
	return database;
}

afterEach(async () => {
	for (const database of opened.splice(0)) {
		await database.close();
	}
});

async function installed(options: { textSearchConfig?: string } = {}) {
	const database = await open();
	const memory = createMemory({ store: database.client, embedder });
	await migrate({ memory, ...options });
	return { database, memory, scope: { namespace: "ns", entityId: "alice" } };
}

async function keywordIds(
	memory: ReturnType<typeof createMemory>,
	query: string,
): Promise<string[]> {
	// Vector weight 0 leaves only the keyword list.
	const results = await memory.search({
		scope: { namespace: "ns", entityId: "alice" },
		query,
		limit: 10,
	});
	return results.map((result) => result.id).sort();
}

describe("libSQL migrations", () => {
	test("a dry run on an empty database lists every migration and creates nothing", async () => {
		const database = await open();
		const store = libsqlStore({ client: database.client });
		await expect(
			migrate({ store, dimensions: 3, dryRun: true, createExtension: true }),
		).resolves.toEqual({
			applied: ALL_MIGRATIONS,
			adopted: [],
			extensionCreated: false,
			schemaCreated: false,
		});
		const tables = await database.client.execute(
			"SELECT name FROM sqlite_master WHERE name LIKE 'mnemocyte_%'",
		);
		expect(tables.rows).toEqual([]);
	});

	test("a fresh install needs dimensions and records its migrations", async () => {
		const database = await open();
		const store = libsqlStore({ client: database.client });
		await expectMnemocyteError(migrate({ store }), "VALIDATION");
		await expect(migrate({ store, dimensions: 3 })).resolves.toMatchObject({
			applied: ALL_MIGRATIONS,
		});
		const recorded = await database.client.execute(
			"SELECT version, name FROM mnemocyte_migrations ORDER BY version",
		);
		expect(recorded.rows.map((row) => [row.version, row.name])).toEqual([
			[0, "0000_initial"],
		]);
		await expectMnemocyteError(
			migrate({ store, dimensions: 4 }),
			"CONFIG",
			"DIMENSIONS_MISMATCH",
		);
	});

	test("accepts embeddings above the 4,000 dimensions Postgres can index", async () => {
		const database = await open();
		const store = libsqlStore({ client: database.client });
		await expect(migrate({ store, dimensions: 5000 })).resolves.toMatchObject({
			applied: ALL_MIGRATIONS,
		});
		await expectMnemocyteError(
			migrate({
				store: libsqlStore({ client: (await open()).client }),
				dimensions: 65_537,
			}),
			"VALIDATION",
		);
	});

	test("refuses tables that migrate() did not record", async () => {
		const database = await open();
		await database.client.execute(
			'CREATE TABLE "mnemocyte_memories" ("id" text PRIMARY KEY)',
		);
		await expectMnemocyteError(
			migrate({ store: database.client, dimensions: 3 }),
			"MIGRATION",
			"SCHEMA_UNRECOGNIZED",
		);
	});

	test("a missing schema is a MIGRATION error that names migrate", async () => {
		const database = await open();
		const memory = createMemory({ store: database.client, embedder });
		const error = await expectMnemocyteError(
			memory.list({ scope: { namespace: "ns", entityId: "alice" } }),
			"MIGRATION",
			"SCHEMA_MISSING",
		);
		expect(error.message).toContain("mnemocyte migrate");
	});

	test("inspectInstallation reports what is installed", async () => {
		const { memory } = await installed();
		const report =
			await readMemoryClientInternals(memory).store.inspectInstallation();
		expect(report).toMatchObject({
			schema: null,
			pgvectorVersion: null,
			migrations: { state: "tracked", applied: ALL_MIGRATIONS, pending: [] },
			column: { dimensions: 3, vectorType: "F32_BLOB" },
			meta: { dimensions: 3, model: null, vectorType: "F32_BLOB" },
			textSearchConfig: "porter",
		});
		expect(report?.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
	});
});

describe("libSQL keyword search", () => {
	test("porter stems English words; unicode61 does not", async () => {
		for (const [config, stemmed] of [
			["porter", true],
			["unicode61", false],
		] as const) {
			const { memory, scope } = await installed({ textSearchConfig: config });
			const added = await memory.add({
				scope,
				content: "She was running late.",
			});
			// No vector match either: the query has neither "tea" nor "coffee".
			const found = await memory.search({ scope, query: "runs", limit: 5 });
			const lexical = found.filter((result) => result.id === added.id);
			expect(lexical.length > 0).toBe(true);
			const keyword = await readMemoryClientInternals(
				memory,
			).store.searchCandidates({
				visibility: {
					scope: { ...scope, agentId: null, sessionId: null },
					exactAgent: false,
					exactSession: false,
				},
				lexical: { query: "runs", limit: 5 },
			});
			expect(keyword.lexical.map((item) => item.memory.id)).toEqual(
				stemmed ? [added.id] : [],
			);
		}
	});

	test("FTS5 syntax in a query is matched as words", async () => {
		const { memory, scope } = await installed();
		const quoted = await memory.add({
			scope,
			content: 'A "quoted" note about NOT and NEAR and col:on',
		});
		const store = readMemoryClientInternals(memory).store;
		const visibility = {
			scope: { ...scope, agentId: null, sessionId: null },
			exactAgent: false,
			exactSession: false,
		};
		for (const query of [
			'"quoted',
			"NOT",
			"NEAR(",
			"col:on",
			"* ^ + - ( )",
			'""',
			"AND OR",
		]) {
			const found = await store.searchCandidates({
				visibility,
				lexical: { query, limit: 5 },
			});
			for (const candidate of found.lexical) {
				expect(candidate.memory.id).toBe(quoted.id);
				expect(candidate.lexicalScore).toBeGreaterThan(0);
			}
		}
		const near = await store.searchCandidates({
			visibility,
			lexical: { query: "NEAR(", limit: 5 },
		});
		expect(near.lexical.map((item) => item.memory.id)).toEqual([quoted.id]);
	});

	test("the keyword index follows updates, keyed upserts and deletes", async () => {
		const { memory, scope } = await installed();
		const note = await memory.add({ scope, content: "Plays the violin." });
		expect(await keywordIds(memory, "violin")).toContain(note.id);
		await memory.update({ scope, id: note.id, content: "Plays the cello." });
		const store = readMemoryClientInternals(memory).store;
		const visibility = {
			scope: { ...scope, agentId: null, sessionId: null },
			exactAgent: false,
			exactSession: false,
		};
		const lexical = async (query: string) =>
			(
				await store.searchCandidates({
					visibility,
					lexical: { query, limit: 5 },
				})
			).lexical.map((item) => item.memory.id);
		expect(await lexical("violin")).toEqual([]);
		expect(await lexical("cello")).toEqual([note.id]);

		const keyed = await memory.add({
			scope,
			key: "pet",
			content: "Has a cat.",
		});
		await memory.add({ scope, key: "pet", content: "Has a parrot." });
		expect(await lexical("cat")).toEqual([]);
		expect(await lexical("parrot")).toEqual([keyed.id]);

		await memory.delete({ scope, id: note.id });
		expect(await lexical("cello")).toEqual([]);
	});

	test("setTextSearchConfig rebuilds the keyword index", async () => {
		const { memory, scope } = await installed();
		await memory.add({ scope, content: "She was running late." });
		await expectMnemocyteError(
			migrate({ memory, textSearchConfig: "unicode61" }),
			"CONFIG",
			"TEXT_SEARCH_CONFIG_MISMATCH",
		);
		await expectMnemocyteError(
			setTextSearchConfig({ memory, textSearchConfig: "english" }),
			"VALIDATION",
		);
		await expect(
			setTextSearchConfig({
				memory,
				textSearchConfig: "unicode61",
				dryRun: true,
			}),
		).resolves.toEqual({
			previous: "porter",
			current: "unicode61",
			changed: true,
		});
		await expect(
			setTextSearchConfig({ memory, textSearchConfig: "unicode61" }),
		).resolves.toEqual({
			previous: "porter",
			current: "unicode61",
			changed: true,
		});
		await expect(
			setTextSearchConfig({ memory, textSearchConfig: "unicode61" }),
		).resolves.toEqual({
			previous: "unicode61",
			current: "unicode61",
			changed: false,
		});
		const store = readMemoryClientInternals(memory).store;
		const visibility = {
			scope: { ...scope, agentId: null, sessionId: null },
			exactAgent: false,
			exactSession: false,
		};
		const lexical = async (query: string) =>
			(
				await store.searchCandidates({
					visibility,
					lexical: { query, limit: 5 },
				})
			).lexical.length;
		expect(await lexical("runs")).toBe(0);
		expect(await lexical("running")).toBe(1);
		await expect(
			migrate({ memory, textSearchConfig: "unicode61" }),
		).resolves.toMatchObject({ applied: [] });
	});
});

describe("libSQL store", () => {
	test("declares its capabilities and backend before loading", async () => {
		const database = await open();
		const events: MnemocyteObservation[] = [];
		const memory = createMemory({
			store: database.client,
			embedder,
			observability: {
				onEvent: (event) => {
					events.push(event);
				},
			},
		});
		const store = readMemoryClientInternals(memory).store;
		expect(store.backend).toBe("libsql");
		expect(store.capabilities).toEqual(LIBSQL_CAPABILITIES);
		expect(LIBSQL_CAPABILITIES).toEqual({
			vectorSearch: "exact",
			filteredVectorSearch: "prefilter",
			lexicalSearch: "bm25",
			locking: "database",
			maxDimensions: 65_536,
		});
		await migrate({ memory });
		await memory.add({
			scope: { namespace: "ns", entityId: "alice" },
			content: "Drinks tea.",
		});
		expect(events.every((event) => event.backend === "libsql")).toBe(true);
	});

	test("audit ids built in SQL are UUIDv7 with the event's milliseconds", async () => {
		const database = await open();
		const memory = createMemory({
			store: database.client,
			embedder,
			audit: { enabled: true },
		});
		await migrate({ memory });
		const scope = { namespace: "ns", entityId: "alice" };
		const added = await memory.addMany({
			scope,
			memories: [{ content: "One tea." }, { content: "Two tea." }],
		});
		const before = Date.now();
		await memory.prune({ scope, createdBefore: new Date(Date.now() + 1000) });
		await memory
			.delete({ scope, id: added[0]?.id ?? "" })
			.catch(() => undefined);
		const { events } = await memory.listAuditLog({ scope, limit: 10 });
		const pruned = events.find((event) => event.type === "memory.pruned");
		expect(pruned?.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const millis = Number.parseInt(
			(pruned?.id ?? "").replaceAll("-", "").slice(0, 12),
			16,
		);
		expect(millis).toBeGreaterThanOrEqual(before - 5);
		expect(millis).toBe(pruned?.timestamp.getTime());
		const ids = new Set(events.map((event) => event.id));
		expect(ids.size).toBe(events.length);
	});

	test("an aborted signal stops a call before it is sent", async () => {
		const { memory, scope } = await installed();
		const controller = new AbortController();
		controller.abort();
		await expectMnemocyteError(
			memory.list({ scope, signal: controller.signal }),
			"ABORTED",
		);
	});

	test("libsqlStore rejects a value that is not a libSQL client", () => {
		expect(() => libsqlStore({ client: {} as never })).toThrow(
			expect.objectContaining({ code: "CONFIG" }),
		);
		expect(() =>
			libsqlStore({ client: {} as never, extra: true } as never),
		).toThrow(expect.objectContaining({ code: "CONFIG" }));
	});

	test("concurrent writes from one client all land", async () => {
		const { memory, scope } = await installed();
		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				memory.add({ scope, content: `Parallel note ${index} about tea.` }),
			),
		);
		await expect(memory.stats({ scope })).resolves.toMatchObject({
			memoryCount: 20,
		});
	});
});
