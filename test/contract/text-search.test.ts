import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
	createMemory,
	type Embedder,
	migrate,
	setTextSearchConfig,
} from "mnemocyte";
import { afterEach, describe, expect, test } from "vitest";
import { inspectPostgresInstallation } from "../../src/db/migrations/inspect.js";
import { changeTextSearchStatements } from "../../src/db/text-search.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import { expectMnemocyteError } from "../helpers.js";

const embedder: Embedder = {
	model: "text-search",
	dimensions: 3,
	async embed(texts) {
		return texts.map(() => [1, 0, 0]);
	},
};

const scope = { entityId: "u" };

let open: PGlite[] = [];

afterEach(async () => {
	await Promise.all(open.map((db) => db.close()));
	open = [];
});

/** An in-process Postgres 18 with pgvector and no Mnemocyte tables. */
async function createDb(): Promise<PGlite> {
	const db = await PGlite.create({ extensions: { vector } });
	await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
	open.push(db);
	return db;
}

/** Keyword search only: the vector list is off, so a miss returns nothing. */
function client(db: PGlite) {
	return createMemory({
		namespace: "text-search",
		store: db,
		embedder,
		retrieval: { fusion: { vector: 0 } },
	});
}

async function keywordHits(
	memory: ReturnType<typeof client>,
	query: string,
): Promise<string[]> {
	const results = await memory.search({ scope, query });
	return results.map((result) => result.content);
}

async function columnExpression(db: PGlite): Promise<string | undefined> {
	const { rows } = await db.query<{ expression: string }>(
		`SELECT pg_get_expr(d.adbin, d.adrelid) AS "expression"
		FROM pg_attribute a
		JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid = 'mnemocyte_memories'::regclass
			AND a.attname = 'content_tsv' AND NOT a.attisdropped`,
	);
	return rows[0]?.expression;
}

/** Live columns in order, and whether the GIN index on content_tsv exists. */
async function layout(db: PGlite) {
	const columns = await db.query<{ name: string }>(
		`SELECT attname AS "name" FROM pg_attribute
		WHERE attrelid = 'mnemocyte_memories'::regclass
			AND attnum > 0 AND NOT attisdropped
		ORDER BY attnum`,
	);
	const index = await db.query<{ definition: string }>(
		`SELECT indexdef AS "definition" FROM pg_indexes
		WHERE indexname = 'mnemocyte_memories_content_tsv_idx'`,
	);
	return {
		columns: columns.rows.map((row) => row.name),
		index: index.rows[0]?.definition,
	};
}

describe("text search configuration (PGlite)", () => {
	test("a fresh install defaults to english: stemming and stop words", async () => {
		const db = await createDb();
		const memory = client(db);
		await migrate({ memory });
		expect(await columnExpression(db)).toBe(
			"to_tsvector('english'::regconfig, content)",
		);
		await memory.add({ scope, content: "The runners were running late" });
		expect(await keywordHits(memory, "run")).toEqual([
			"The runners were running late",
		]);
		// "the" is an English stop word, so the query has no terms.
		expect(await keywordHits(memory, "the")).toEqual([]);
		const report = await inspectPostgresInstallation(toSqlExecutor(db));
		expect(report.textSearchConfig).toBe("english");
	});

	test("textSearchConfig picks the configuration of a fresh install", async () => {
		const db = await createDb();
		const memory = client(db);
		const plan = await migrate({
			memory,
			textSearchConfig: "simple",
			dryRun: true,
		});
		expect(plan.applied.length).toBeGreaterThan(0);
		await migrate({ memory, textSearchConfig: "simple" });
		expect(await columnExpression(db)).toBe(
			"to_tsvector('simple'::regconfig, content)",
		);
		await memory.add({ scope, content: "The runners were running late" });
		// No stemming and no stop words.
		expect(await keywordHits(memory, "run")).toEqual([]);
		expect(await keywordHits(memory, "running")).toEqual([
			"The runners were running late",
		]);
		expect(await keywordHits(memory, "the")).toEqual([
			"The runners were running late",
		]);
	});

	test("migrate compares textSearchConfig on an existing installation", async () => {
		const db = await createDb();
		const memory = client(db);
		await migrate({ memory, textSearchConfig: "simple" });
		// The same configuration, however it is spelled.
		await migrate({ memory, textSearchConfig: "Simple" });
		await migrate({ memory, textSearchConfig: "pg_catalog.simple" });
		// Without the option, migrate does not look.
		await migrate({ memory });
		await expectMnemocyteError(
			migrate({ memory, textSearchConfig: "english" }),
			"CONFIG",
			"TEXT_SEARCH_CONFIG_MISMATCH",
		);
		await expectMnemocyteError(
			migrate({ memory, textSearchConfig: "english", dryRun: true }),
			"CONFIG",
			"TEXT_SEARCH_CONFIG_MISMATCH",
		);
	});

	test("an unknown configuration rejects before anything is created", async () => {
		const db = await createDb();
		const memory = client(db);
		for (const name of ["klingon", "nowhere.simple", "a.b.c"]) {
			await expectMnemocyteError(
				migrate({ memory, textSearchConfig: name }),
				"VALIDATION",
			);
		}
		const { rows } = await db.query<{ exists: boolean }>(
			`SELECT to_regclass('mnemocyte_memories') IS NOT NULL AS "exists"`,
		);
		expect(rows[0]?.exists).toBe(false);
	});

	test("setTextSearchConfig rewrites the column, keeps its index and updates the client", async () => {
		const db = await createDb();
		const memory = client(db);
		await migrate({ memory });
		await memory.add({ scope, content: "The runners were running late" });
		expect(await keywordHits(memory, "run")).toHaveLength(1);
		const before = await layout(db);

		const plan = await setTextSearchConfig({
			memory,
			textSearchConfig: "simple",
			dryRun: true,
		});
		expect(plan).toEqual({
			previous: "english",
			current: "simple",
			changed: true,
		});
		expect(await columnExpression(db)).toContain("'english'");

		await expect(
			setTextSearchConfig({ memory, textSearchConfig: "simple" }),
		).resolves.toEqual({
			previous: "english",
			current: "simple",
			changed: true,
		});
		expect(await columnExpression(db)).toBe(
			"to_tsvector('simple'::regconfig, content)",
		);
		expect(await layout(db)).toEqual(before);
		// The store that ran the change reads with the new configuration.
		expect(await keywordHits(memory, "run")).toEqual([]);
		expect(await keywordHits(memory, "running")).toHaveLength(1);

		await expect(
			setTextSearchConfig({ store: db, textSearchConfig: "SIMPLE" }),
		).resolves.toEqual({
			previous: "simple",
			current: "simple",
			changed: false,
		});
		const report = await inspectPostgresInstallation(toSqlExecutor(db));
		expect(report.textSearchConfig).toBe("simple");
	});

	test("another client keeps the configuration it read until it restarts", async () => {
		const db = await createDb();
		const first = client(db);
		await migrate({ memory: first });
		await first.add({ scope, content: "The runners were running late" });
		expect(await keywordHits(first, "run")).toHaveLength(1);

		await setTextSearchConfig({ store: db, textSearchConfig: "simple" });
		// Stemmed english query against simple lexemes: "run" vs "running".
		expect(await keywordHits(first, "running")).toEqual([]);
		expect(await keywordHits(client(db), "running")).toHaveLength(1);
	});

	test("names that need quotes round-trip through the column expression", async () => {
		const db = await createDb();
		await db.exec(
			`CREATE TEXT SEARCH CONFIGURATION public."it's Mine" (COPY = pg_catalog.simple);`,
		);
		const memory = client(db);
		await migrate({ memory, textSearchConfig: `"it's Mine"` });
		expect(await columnExpression(db)).toBe(
			`to_tsvector('"it''s Mine"'::regconfig, content)`,
		);
		await memory.add({ scope, content: "The runners were running late" });
		expect(await keywordHits(memory, "running")).toHaveLength(1);
		await expect(
			setTextSearchConfig({ memory, textSearchConfig: "english" }),
		).resolves.toEqual({
			previous: `"it's Mine"`,
			current: "english",
			changed: true,
		});
		expect(await keywordHits(memory, "run")).toHaveLength(1);
	});

	test("the Postgres 15/16 statements drop, re-add and re-index the column", async () => {
		const db = await createDb();
		const memory = client(db);
		await migrate({ memory });
		await memory.add({ scope, content: "The runners were running late" });
		const before = await layout(db);
		await db.transaction(async (tx) => {
			for (const statement of changeTextSearchStatements("simple", 160000)) {
				await tx.query(statement);
			}
		});
		// content_tsv was the last column, so it still is.
		expect(await layout(db)).toEqual(before);
		expect(await columnExpression(db)).toBe(
			"to_tsvector('simple'::regconfig, content)",
		);
		expect(await keywordHits(client(db), "running")).toHaveLength(1);
	});

	test("setTextSearchConfig needs the schema and a known name", async () => {
		const db = await createDb();
		const memory = client(db);
		await expectMnemocyteError(
			setTextSearchConfig({ memory, textSearchConfig: "simple" }),
			"MIGRATION",
			"SCHEMA_MISSING",
		);
		await migrate({ memory });
		await expectMnemocyteError(
			setTextSearchConfig({ memory, textSearchConfig: "klingon" }),
			"VALIDATION",
		);
		expect(await columnExpression(db)).toContain("'english'");
	});

	test("a content_tsv changed by hand is reported, not guessed", async () => {
		const db = await createDb();
		const memory = client(db);
		await migrate({ memory });
		await db.exec(
			`ALTER TABLE mnemocyte_memories ALTER COLUMN content_tsv SET EXPRESSION AS (to_tsvector('simple'::regconfig, coalesce(content, '')))`,
		);
		await expectMnemocyteError(
			memory.search({ scope, query: "late" }),
			"MIGRATION",
			"SCHEMA_UNRECOGNIZED",
		);
		await expectMnemocyteError(
			setTextSearchConfig({ memory, textSearchConfig: "english" }),
			"MIGRATION",
			"SCHEMA_UNRECOGNIZED",
		);
		const report = await inspectPostgresInstallation(toSqlExecutor(db));
		expect(report.migrations.state).toBe("invalid");
	});
});

describe("text search configuration (in-memory)", () => {
	test("the in-memory store has none and ignores the option", async () => {
		const memory = createMemory({ namespace: "text-search", embedder });
		await expect(
			migrate({ memory, textSearchConfig: "simple" }),
		).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
			schemaCreated: false,
		});
		await expect(
			setTextSearchConfig({ memory, textSearchConfig: "simple" }),
		).resolves.toEqual({ previous: null, current: null, changed: false });
	});

	test("input is validated before any store is touched", async () => {
		const memory = createMemory({ namespace: "text-search", embedder });
		for (const textSearchConfig of ["", "x".repeat(257), "a\u0000b"]) {
			await expectMnemocyteError(
				setTextSearchConfig({ memory, textSearchConfig }),
				"VALIDATION",
			);
			await expectMnemocyteError(
				migrate({ memory, textSearchConfig }),
				"VALIDATION",
			);
		}
		await expectMnemocyteError(
			// @ts-expect-error: an unknown key
			setTextSearchConfig({ memory, textSearchConfig: "simple", force: true }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			// @ts-expect-error: neither memory nor store
			setTextSearchConfig({ textSearchConfig: "simple" }),
			"VALIDATION",
		);
	});
});
