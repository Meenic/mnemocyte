import type { PGlite } from "@electric-sql/pglite";
import {
	createMemory,
	type Embedder,
	migrate,
	setTextSearchConfig,
} from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { afterEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations/bundled.js";
import { inspectPostgresInstallation } from "../../src/db/migrations/inspect.js";
import { MIGRATION_LOCK_KEY } from "../../src/db/migrations/runner.js";
import { postgresTables } from "../../src/db/tables.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import { expectMnemocyteError } from "../helpers.js";
import { openPGlite } from "./pglite.js";

const NAMES = MIGRATIONS.map((migration) => migration.name);

const embedder: Embedder = {
	model: "schema-name",
	dimensions: 3,
	async embed(texts) {
		return texts.map((text) => [text.length, 1, 0]);
	},
};

const scope = { namespace: "schema-name", entityId: "u" };

let open: PGlite[] = [];

afterEach(async () => {
	await Promise.all(open.map((db) => db.close()));
	open = [];
});

/** An in-process Postgres 18 with pgvector in `public` and no tables. */
async function createDb(): Promise<PGlite> {
	const db = await openPGlite({ pgvector: true });
	open.push(db);
	return db;
}

function client(db: PGlite, schemaName?: string) {
	return createMemory({
		store: postgresStore({
			client: db,
			...(schemaName === undefined ? {} : { schemaName }),
		}),
		embedder,
	});
}

/** The schema each Mnemocyte table is in, by table name. */
async function tableSchemas(db: PGlite): Promise<Record<string, string[]>> {
	const { rows } = await db.query<{ table: string; schema: string }>(
		`SELECT c.relname AS "table", n.nspname AS "schema"
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind = 'r' AND c.relname LIKE 'mnemocyte\\_%'
		ORDER BY 1, 2`,
	);
	const found: Record<string, string[]> = {};
	for (const row of rows) {
		found[row.table] = [...(found[row.table] ?? []), row.schema];
	}
	return found;
}

/** What the self foreign key on `schema`'s memories table points at. */
async function selfReference(db: PGlite, schema: string): Promise<string> {
	const { rows } = await db.query<{ target: string }>(
		`SELECT n.nspname || '.' || c.relname AS "target"
		FROM pg_constraint k
		JOIN pg_class c ON c.oid = k.confrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE k.conrelid = to_regclass($1)
			AND k.conname = 'mnemocyte_memories_superseded_by_mnemocyte_memories_id_fk'`,
		[`"${schema}".mnemocyte_memories`],
	);
	return rows[0]?.target ?? "";
}

describe("schemaName (PGlite)", () => {
	test("a fresh install creates the schema and puts every table there", async () => {
		const db = await createDb();
		const memory = client(db, "memory");
		const searchPath = async () =>
			(
				await db.query<{ path: string }>(
					"SELECT current_setting('search_path') AS path",
				)
			).rows[0]?.path;
		const pathBefore = await searchPath();

		await expect(migrate({ memory, dryRun: true })).resolves.toEqual({
			applied: NAMES,
			adopted: [],
			extensionCreated: false,
			schemaCreated: true,
		});
		expect(await tableSchemas(db)).toEqual({});

		await expect(migrate({ memory })).resolves.toEqual({
			applied: NAMES,
			adopted: [],
			extensionCreated: false,
			schemaCreated: true,
		});
		expect(await tableSchemas(db)).toEqual({
			mnemocyte_events: ["memory"],
			mnemocyte_memories: ["memory"],
			mnemocyte_meta: ["memory"],
			mnemocyte_migrations: ["memory"],
		});
		expect(await selfReference(db, "memory")).toBe("memory.mnemocyte_memories");
		// SET LOCAL ended with the transaction.
		expect(await searchPath()).toBe(pathBefore);

		await expect(migrate({ memory })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
			schemaCreated: false,
		});
	});

	test("an existing empty schema is used as it is", async () => {
		const db = await createDb();
		await db.exec("CREATE SCHEMA memory;");
		await expect(migrate({ memory: client(db, "memory") })).resolves.toEqual({
			applied: NAMES,
			adopted: [],
			extensionCreated: false,
			schemaCreated: false,
		});
	});

	test("every operation works with the tables off search_path", async () => {
		const db = await createDb();
		const memory = createMemory({
			store: postgresStore({ client: db, schemaName: "memory" }),
			embedder,
			audit: { enabled: true },
		});
		await migrate({ memory });

		const kept = await memory.add({ scope, content: "likes green tea" });
		const merged = await memory.add({ scope, content: "likes tea" });
		await memory.consolidate({
			scope,
			survivorId: kept.id,
			supersededIds: [merged.id],
		});
		const results = await memory.search({ scope, query: "tea" });
		expect(results.map((result) => result.id)).toContain(kept.id);
		await expectMnemocyteError(
			memory.delete({ scope, id: kept.id }),
			"CONFLICT",
			"HAS_DEPENDENTS",
		);
		const { events } = await memory.listAuditLog({ scope, memoryId: kept.id });
		expect(events.map((event) => event.type)).toContain("memory.created");
		expect((await memory.stats({ scope })).memoryCount).toBe(2);

		await expect(
			setTextSearchConfig({ memory, textSearchConfig: "simple" }),
		).resolves.toEqual({
			previous: "english",
			current: "simple",
			changed: true,
		});
		const { rows } = await db.query<{ expression: string }>(
			`SELECT pg_get_expr(d.adbin, d.adrelid) AS "expression"
			FROM pg_attribute a
			JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE a.attrelid = 'memory.mnemocyte_memories'::regclass
				AND a.attname = 'content_tsv'`,
		);
		expect(rows[0]?.expression).toBe(
			"to_tsvector('simple'::regconfig, content)",
		);

		// Nothing leaked into public.
		expect(Object.values(await tableSchemas(db)).flat()).toEqual([
			"memory",
			"memory",
			"memory",
			"memory",
		]);
	});

	test("two schemas hold two separate installations", async () => {
		const db = await createDb();
		const a = client(db, "tenant_a");
		const b = client(db, "tenant_b");
		await migrate({ memory: a });
		await migrate({ memory: b });
		await a.add({ scope, content: "only in a" });

		expect((await a.list({ scope })).memories.map((m) => m.content)).toEqual([
			"only in a",
		]);
		expect((await b.list({ scope })).memories).toEqual([]);
	});

	test("a missing schema is the missing-tables error, naming the schema", async () => {
		const db = await createDb();
		const error = await expectMnemocyteError(
			client(db, "nowhere").add({ scope, content: "x" }),
			"MIGRATION",
			"SCHEMA_MISSING",
		);
		expect(error.message).toContain('the "nowhere" schema');
	});

	test("a fresh install refuses while search_path finds an installation elsewhere", async () => {
		const db = await createDb();
		await migrate({ memory: client(db) });
		const memory = client(db, "memory");

		for (const dryRun of [true, false]) {
			const error = await expectMnemocyteError(
				migrate({ memory, dryRun }),
				"CONFIG",
				"INSTALLATION_ELSEWHERE",
			);
			expect(error.message).toContain('"public"');
		}
		expect(await tableSchemas(db)).toEqual({
			mnemocyte_events: ["public"],
			mnemocyte_memories: ["public"],
			mnemocyte_meta: ["public"],
			mnemocyte_migrations: ["public"],
		});
		const { rows } = await db.query(
			"SELECT 1 FROM pg_namespace WHERE nspname = 'memory'",
		);
		expect(rows).toEqual([]);

		// Naming public itself is the same installation, not another one.
		await expect(migrate({ memory: client(db, "public") })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
			schemaCreated: false,
		});
	});

	test("an installation moved with SET SCHEMA keeps working, links and all", async () => {
		const db = await createDb();
		const before = client(db);
		await migrate({ memory: before });
		const kept = await before.add({ scope, content: "survivor" });
		const merged = await before.add({ scope, content: "merged" });
		await before.consolidate({
			scope,
			survivorId: kept.id,
			supersededIds: [merged.id],
		});

		// The recipe in docs/guide/postgres.md, "Move an existing installation".
		await db.exec(`BEGIN;
			SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY});
			CREATE SCHEMA memory;
			ALTER TABLE public.mnemocyte_memories SET SCHEMA memory;
			ALTER TABLE public.mnemocyte_events SET SCHEMA memory;
			ALTER TABLE public.mnemocyte_meta SET SCHEMA memory;
			ALTER TABLE public.mnemocyte_migrations SET SCHEMA memory;
			COMMIT;`);

		const after = client(db, "memory");
		await expect(migrate({ memory: after })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
			schemaCreated: false,
		});
		expect(await selfReference(db, "memory")).toBe("memory.mnemocyte_memories");
		const all = await after.list({ scope, includeSuperseded: true });
		expect(all.memories.map((m) => m.content).sort()).toEqual([
			"merged",
			"survivor",
		]);
		await expectMnemocyteError(
			after.delete({ scope, id: kept.id }),
			"CONFLICT",
			"HAS_DEPENDENTS",
		);
		// A client still without schemaName finds nothing in public.
		await expectMnemocyteError(
			before.list({ scope }),
			"MIGRATION",
			"SCHEMA_MISSING",
		);
	});

	test("migrations after a fresh install run inside the schema", async () => {
		const db = await createDb();
		// A 0003-level installation in "memory", untracked: adoption records
		// 0000 to 0003, then 0004 runs with "memory" first on search_path.
		await db.exec("CREATE SCHEMA memory; SET search_path TO memory, public;");
		for (const migration of MIGRATIONS.slice(0, 4)) {
			await db.exec(
				migration.sql.replaceAll(
					'"public"."mnemocyte_memories"',
					'"memory"."mnemocyte_memories"',
				),
			);
		}
		await db.exec("RESET search_path;");

		// 0000 fixed 1536 dimensions, so no dimensions are passed.
		const store = postgresStore({ client: db, schemaName: "memory" });
		await expect(migrate({ store })).resolves.toEqual({
			applied: [NAMES[4]],
			adopted: NAMES.slice(0, 4),
			extensionCreated: false,
			schemaCreated: false,
		});
		const { rows } = await db.query<{ found: string | null }>(
			"SELECT to_regclass('memory.mnemocyte_events_memory_idx')::text AS found",
		);
		expect(rows[0]?.found).toBe("memory.mnemocyte_events_memory_idx");
		expect(await tableSchemas(db)).toEqual({
			mnemocyte_events: ["memory"],
			mnemocyte_memories: ["memory"],
			mnemocyte_meta: ["memory"],
			mnemocyte_migrations: ["memory"],
		});
	});

	test("inspection reads the schema, not search_path", async () => {
		const db = await createDb();
		await migrate({ memory: client(db) });
		const executor = toSqlExecutor(db);

		const empty = await inspectPostgresInstallation(
			executor,
			{},
			postgresTables("memory"),
		);
		expect(empty).toMatchObject({
			schema: "memory",
			migrations: { state: "none" },
			column: null,
		});

		await db.exec(
			"DROP TABLE public.mnemocyte_memories, public.mnemocyte_events, public.mnemocyte_meta, public.mnemocyte_migrations;",
		);
		await migrate({ memory: client(db, "memory") });
		await expect(
			inspectPostgresInstallation(executor, {}, postgresTables("memory")),
		).resolves.toMatchObject({
			schema: "memory",
			migrations: { state: "tracked", applied: NAMES, pending: [] },
			column: { dimensions: 3, vectorType: "vector" },
			meta: { dimensions: 3, vectorType: "vector" },
			textSearchConfig: "english",
		});
	});
});

describe("schemaName validation", () => {
	test.each([
		"",
		"Memory",
		"1memory",
		"pg_memory",
		"my-schema",
		'a"b',
		"a".repeat(64),
	])("rejects %j", (schemaName) => {
		expect(() => postgresStore({ client: {} as never, schemaName })).toThrow(
			expect.objectContaining({ code: "CONFIG", reason: "INVALID_OPTION" }),
		);
	});

	test("accepts names that work unquoted, keywords included", async () => {
		const db = await createDb();
		for (const schemaName of ["memory", "_m", "user", "a".repeat(63)]) {
			const memory = client(db, schemaName);
			await migrate({ memory });
			await memory.add({ scope, content: schemaName });
			expect((await memory.list({ scope })).memories).toHaveLength(1);
		}
	});
});
