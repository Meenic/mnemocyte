import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import {
	generateDrizzleJson,
	generateMigration,
	pushSchema,
} from "drizzle-kit/api";
import { drizzle } from "drizzle-orm/pglite";
import { createMemory, type Embedder, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { evaluateInstallation } from "../../src/cli/check.js";
import {
	renderDrizzleSchema,
	renderDrizzleSetupSql,
	renderDrizzleTextSearchIndexSql,
} from "../../src/cli/drizzle.js";
import {
	type InstallationReport,
	inspectPostgresInstallation,
} from "../../src/db/migrations/inspect.js";
import { splitStatements } from "../../src/db/migrations/runner.js";
import { postgresTables } from "../../src/db/tables.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import { openPGlite } from "./pglite.js";

/**
 * The generated files import drizzle-orm, so they are written under the
 * repository's node_modules, where Node and Vite resolve it.
 */
let folder: string;

beforeAll(async () => {
	const cache = resolve("node_modules/.cache");
	await mkdir(cache, { recursive: true });
	folder = await mkdtemp(join(cache, "mnemocyte-drizzle-"));
});

afterAll(async () => {
	await rm(folder, { recursive: true, force: true });
});

let open: PGlite[] = [];

afterEach(async () => {
	await Promise.all(open.map((db) => db.close()));
	open = [];
});

/** An in-process Postgres 18 without pgvector or tables. */
async function createDb(): Promise<PGlite> {
	const db = await openPGlite({ pgvector: false });
	open.push(db);
	return db;
}

interface Variant {
	readonly dimensions: number;
	readonly textSearchConfig?: string;
	readonly schema?: string;
}

let fileCount = 0;

/** Write the schema for `variant` and import it. */
async function loadSchema(
	variant: Variant,
): Promise<{ source: string; module: Record<string, unknown> }> {
	const source = renderDrizzleSchema({ ...variant, version: "0.0.0-test" });
	fileCount += 1;
	const file = join(folder, `schema-${fileCount}.ts`);
	await writeFile(file, source);
	const module = (await import(pathToFileURL(file).href)) as Record<
		string,
		unknown
	>;
	return { source, module };
}

/**
 * What a drizzle-kit app runs: the first custom migration, `drizzle-kit
 * generate` from an empty snapshot, then the second custom migration.
 */
async function drizzleKitStatements(
	variant: Variant,
	module: Record<string, unknown>,
): Promise<string[]> {
	const setup = renderDrizzleSetupSql(variant);
	const empty = generateDrizzleJson({});
	const current = generateDrizzleJson(module, empty.id);
	const generated = await generateMigration(empty, current);
	return [
		...splitStatements(setup.before),
		...generated,
		...splitStatements(setup.after),
	];
}

async function installWithDrizzleKit(
	db: PGlite,
	variant: Variant,
): Promise<{ statements: string[]; module: Record<string, unknown> }> {
	const { module } = await loadSchema(variant);
	const statements = await drizzleKitStatements(variant, module);
	for (const statement of statements) {
		await db.exec(statement);
	}
	return { statements, module };
}

async function installWithMigrate(db: PGlite, variant: Variant) {
	await migrate({
		store: postgresStore({
			client: db,
			...(variant.schema === undefined ? {} : { schemaName: variant.schema }),
		}),
		dimensions: variant.dimensions,
		createExtension: true,
		...(variant.textSearchConfig === undefined
			? {}
			: { textSearchConfig: variant.textSearchConfig }),
	});
}

/**
 * The catalog of the Mnemocyte tables in `schema`, without the tracking
 * table, which drizzle-kit does not create: columns in order, defaults and
 * generated expressions, constraints, indexes and the installation row.
 */
async function readCatalog(db: PGlite, schema: string) {
	const tables = `n.nspname = $1 AND c.relkind = 'r'
		AND c.relname LIKE 'mnemocyte\\_%'
		AND c.relname <> 'mnemocyte_migrations'`;
	const columns = await db.query(
		`SELECT c.relname AS "table", a.attname AS "column",
			pg_catalog.format_type(a.atttypid, a.atttypmod) AS "type",
			a.attnotnull AS "notNull",
			a.attgenerated::text AS "generated",
			pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "expression"
		FROM pg_catalog.pg_attribute a
		JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_catalog.pg_attrdef d
			ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE ${tables} AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY c.relname, a.attnum`,
		[schema],
	);
	const constraints = await db.query(
		`SELECT c.relname AS "table", k.conname AS "name",
			k.contype::text AS "type",
			pg_catalog.pg_get_constraintdef(k.oid, true) AS "definition"
		FROM pg_catalog.pg_constraint k
		JOIN pg_catalog.pg_class c ON c.oid = k.conrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE ${tables}
		ORDER BY c.relname, k.conname`,
		[schema],
	);
	const indexes = await db.query(
		`SELECT c.relname AS "table", i.relname AS "name",
			pg_catalog.pg_get_indexdef(x.indexrelid) AS "definition"
		FROM pg_catalog.pg_index x
		JOIN pg_catalog.pg_class c ON c.oid = x.indrelid
		JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE ${tables}
		ORDER BY c.relname, i.relname`,
		[schema],
	);
	const meta = await db.query(
		`SELECT * FROM ${postgresTables(schema).meta} ORDER BY "key"`,
	);
	return {
		columns: columns.rows,
		constraints: constraints.rows,
		indexes: indexes.rows,
		meta: meta.rows,
	};
}

const VARIANTS: readonly Variant[] = [
	{ dimensions: 1536 },
	{ dimensions: 3072 },
	{ dimensions: 3, textSearchConfig: "simple" },
	{ dimensions: 1536, schema: "memory" },
];

const embedder: Embedder = {
	model: "drizzle-schema",
	dimensions: 3,
	async embed(texts) {
		return texts.map((text) => [text.length, 1, 0]);
	},
};

describe("generate --adapter drizzle through drizzle-kit (PGlite)", () => {
	for (const variant of VARIANTS) {
		test(`matches a fresh install: ${JSON.stringify(variant)}`, async () => {
			const kit = await createDb();
			const fresh = await createDb();
			await installWithDrizzleKit(kit, variant);
			await installWithMigrate(fresh, variant);
			const schema = variant.schema ?? "public";
			const expected = await readCatalog(fresh, schema);
			expect(expected.columns).toHaveLength(37);
			expect(await readCatalog(kit, schema)).toEqual(expected);
		});
	}

	test("check reports the installation as untracked and current", async () => {
		const db = await createDb();
		await installWithDrizzleKit(db, { dimensions: 3 });
		const report: InstallationReport = await inspectPostgresInstallation(
			toSqlExecutor(db),
		);
		expect(report.migrations.state).toBe("untracked");
		const verdict = evaluateInstallation(report, { dimensions: 3 });
		expect(verdict.problems).toEqual([]);
		expect(verdict.notes.map((note) => note.code)).toContain(
			"SCHEMA_UNTRACKED",
		);
	});

	test("the client works on it, keyed writes included", async () => {
		const db = await createDb();
		await installWithDrizzleKit(db, { dimensions: 3 });
		const memory = createMemory({ store: db, embedder });
		// No agentId: the key index's NULLS NOT DISTINCT makes the second add
		// update the first.
		const scope = { namespace: "drizzle", entityId: "u" };
		const first = await memory.add({ scope, key: "drink", content: "tea" });
		const second = await memory.add({ scope, key: "drink", content: "coffee" });
		expect(second.id).toBe(first.id);
		expect((await memory.stats({ scope })).memoryCount).toBe(1);
		const results = await memory.search({ scope, query: "coffee" });
		expect(results.map((result) => result.id)).toEqual([first.id]);
	});

	// drizzle-kit drops content_tsv and adds it back, which drops its GIN
	// index; generate prints the index and ANALYZE to add to that migration.
	test("a new text search configuration through drizzle-kit, plus the printed index, matches a fresh install", async () => {
		for (const schema of [undefined, "memory"]) {
			const before: Variant = {
				dimensions: 3,
				...(schema === undefined ? {} : { schema }),
			};
			const after: Variant = { ...before, textSearchConfig: "simple" };
			const kit = await createDb();
			const { module } = await installWithDrizzleKit(kit, before);
			const english = generateDrizzleJson(module);
			const simple = generateDrizzleJson(
				(await loadSchema(after)).module,
				english.id,
			);
			const generated = await generateMigration(english, simple);
			const table = `${schema === undefined ? "" : `"${schema}".`}"mnemocyte_memories"`;
			expect(generated).toEqual([
				`ALTER TABLE ${table} drop column "content_tsv";`,
				`ALTER TABLE ${table} ADD COLUMN "content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "content")) STORED;`,
			]);
			for (const statement of [
				...generated,
				...splitStatements(
					renderDrizzleTextSearchIndexSql({ schema: schema ?? null }),
				),
			]) {
				await kit.exec(statement);
			}

			const fresh = await createDb();
			await installWithMigrate(fresh, after);
			const name = schema ?? "public";
			expect(await readCatalog(kit, name)).toEqual(
				await readCatalog(fresh, name),
			);
		}
	});

	// Why the guide says not to push these tables. drizzle-kit 0.31 also
	// reads the text[] default back differently and sets it again on every
	// push, which changes nothing.
	test("drizzle-kit push would drop the key index", async () => {
		const db = await createDb();
		const { module } = await installWithDrizzleKit(db, { dimensions: 3 });
		const { statementsToExecute } = await pushSchema(module, drizzle(db));
		expect(statementsToExecute).toEqual([
			'DROP INDEX "mnemocyte_memories_scope_key_idx";',
			`ALTER TABLE "mnemocyte_memories" ALTER COLUMN "tags" SET DEFAULT '{}';`,
		]);
		for (const statement of statementsToExecute) {
			await db.exec(statement);
		}
		// ON CONFLICT has no arbiter index left (42P10).
		const memory = createMemory({ store: db, embedder });
		const scope = { namespace: "drizzle", entityId: "u" };
		await expect(
			memory.add({ scope, key: "drink", content: "tea" }),
		).rejects.toThrow();
	});
});
