import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { type MnemocyteStoreConfig, migrate } from "mnemocyte";
import { postgresStore, type SqlExecutor } from "mnemocyte/postgres";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations/bundled.js";
import {
	MIGRATION_LOCK_KEY,
	renderInitialSchema,
	splitStatements,
} from "../../src/db/migrations/runner.js";
import { expectMnemocyteError } from "../helpers.js";

const execFileAsync = promisify(execFile);
const MIGRATION_NAMES = MIGRATIONS.map((migration) => migration.name);

interface FakeDatabaseState {
	/** Newest migration whose objects exist: -1 for none. */
	schemaLevel: number;
	/** Rows of mnemocyte_migrations, or null when the table does not exist. */
	tracked: number[] | null;
	dimensions: number;
	pgvector: boolean;
	/** Catalog flags to report instead of the ones `schemaLevel` implies. */
	catalog?: Record<string, boolean>;
	/** A statement containing this text throws a driver error. */
	failOn?: string;
}

/**
 * A SqlExecutor that answers the runner's catalog and tracking queries from
 * `state`, logs every statement and rolls state back when a transaction
 * throws.
 */
function fakeDatabase(initial: Partial<FakeDatabaseState> = {}) {
	let state: FakeDatabaseState = {
		schemaLevel: -1,
		tracked: null,
		dimensions: 1536,
		pgvector: true,
		...initial,
	};
	const log: string[] = [];
	const executed: string[] = [];

	const executor: SqlExecutor = {
		async query<Row>(sql: string, params: readonly unknown[]) {
			log.push(sql);
			const rows = (value: unknown[]): Row[] => value as Row[];
			if (state.failOn !== undefined && sql.includes(state.failOn)) {
				throw Object.assign(new Error("syntax error"), { code: "42601" });
			}
			if (sql.includes("pg_advisory_xact_lock")) {
				return rows([{ pg_advisory_xact_lock: "" }]);
			}
			if (sql.includes("atttypmod")) {
				return rows(
					state.schemaLevel >= 0 ? [{ dimensions: state.dimensions }] : [],
				);
			}
			if (sql.includes("to_regclass('mnemocyte_migrations')")) {
				return rows([{ exists: state.tracked !== null }]);
			}
			if (sql.startsWith("SELECT version FROM mnemocyte_migrations")) {
				return rows((state.tracked ?? []).map((version) => ({ version })));
			}
			if (sql.startsWith("CREATE TABLE mnemocyte_migrations")) {
				state.tracked = [];
				return rows([]);
			}
			if (sql.includes('AS "scoped"')) {
				const level = state.schemaLevel;
				return rows([
					state.catalog ?? {
						memories: level >= 0,
						events: level >= 0,
						meta: level >= 1,
						metaModel: level >= 2,
						scoped: level >= 3,
					},
				]);
			}
			if (sql.includes("pg_extension")) {
				return rows(state.pgvector ? [{ "?column?": 1 }] : []);
			}
			if (sql.startsWith("INSERT INTO mnemocyte_migrations")) {
				state.tracked?.push(Number(params[0]));
				return rows([]);
			}
			executed.push(sql);
			if (sql.startsWith('CREATE TABLE "mnemocyte_memories"')) {
				state.schemaLevel = MIGRATIONS.length - 1;
			}
			return rows([]);
		},
		async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
			const snapshot = structuredClone(state);
			log.push("BEGIN");
			try {
				const result = await fn(executor);
				log.push("COMMIT");
				return result;
			} catch (error) {
				state = snapshot;
				log.push("ROLLBACK");
				throw error;
			}
		},
	};

	return {
		store: postgresStore({ client: executor }),
		log,
		executed,
		get state() {
			return state;
		},
	};
}

function transactions(log: readonly string[]): string[][] {
	const result: string[][] = [];
	let current: string[] | null = null;
	for (const entry of log) {
		if (entry === "BEGIN") {
			current = [];
		} else if (entry === "COMMIT" || entry === "ROLLBACK") {
			if (current) result.push(current);
			current = null;
		} else {
			current?.push(entry);
		}
	}
	return result;
}

describe("migrate", () => {
	test("installs the final schema on an empty database in one transaction", async () => {
		const db = fakeDatabase();

		const result = await migrate({ store: db.store, dimensions: 768 });

		expect(result).toEqual({ applied: MIGRATION_NAMES, adopted: [] });
		expect(db.state.tracked).toEqual([0, 1, 2, 3]);
		expect(db.log.filter((entry) => entry === "BEGIN")).toHaveLength(1);
		expect(db.executed).toEqual(splitStatements(renderInitialSchema(768)));
		expect(db.executed.join("\n")).toContain('"embedding" vector(768)');
	});

	test("takes the advisory lock before any other statement in every transaction", async () => {
		const db = fakeDatabase({ schemaLevel: 1 });

		await migrate({ store: db.store });

		const steps = transactions(db.log);
		expect(steps.length).toBeGreaterThan(1);
		for (const statements of steps) {
			expect(statements[0]).toBe(
				`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`,
			);
		}
	});

	test("uses halfvec above 2,000 dimensions", async () => {
		const db = fakeDatabase();

		await migrate({ store: db.store, dimensions: 3072 });

		const schema = db.executed.join("\n");
		expect(schema).toContain('"embedding" halfvec(3072)');
		expect(schema).toContain("halfvec_cosine_ops");
		expect(schema).toContain("VALUES ('installation', 3072, 'halfvec')");
	});

	test("requires dimensions for a fresh install and rolls back", async () => {
		const db = fakeDatabase();

		await expectMnemocyteError(migrate({ store: db.store }), "VALIDATION");

		expect(db.state.tracked).toBeNull();
		expect(db.executed).toEqual([]);
	});

	test("rejects a fresh install without pgvector", async () => {
		const db = fakeDatabase({ pgvector: false });

		await expectMnemocyteError(
			migrate({ store: db.store, dimensions: 1536 }),
			"MIGRATION",
		);
		expect(db.executed).toEqual([]);
	});

	test.each([
		[0, ["0000_initial"]],
		[1, ["0000_initial", "0001_add_mnemocyte_meta"]],
		[
			2,
			["0000_initial", "0001_add_mnemocyte_meta", "0002_add_embedding_model"],
		],
		[3, MIGRATION_NAMES],
	])(
		"adopts an untracked schema at migration %i and applies the rest",
		async (level, adopted) => {
			const db = fakeDatabase({ schemaLevel: level });

			const result = await migrate({ store: db.store });

			expect(result).toEqual({
				adopted,
				applied: MIGRATION_NAMES.slice(adopted.length),
			});
			expect(db.state.tracked).toEqual([0, 1, 2, 3]);
			// One transaction to adopt, then one per applied migration.
			expect(transactions(db.log)).toHaveLength(
				1 + MIGRATION_NAMES.length - adopted.length,
			);
		},
	);

	test("runs each pending migration's statements in its own transaction", async () => {
		const db = fakeDatabase({ schemaLevel: 2, tracked: [0, 1, 2] });

		const result = await migrate({ store: db.store });

		expect(result).toEqual({ applied: ["0003_schema_v2"], adopted: [] });
		const steps = transactions(db.log);
		expect(steps).toHaveLength(1);
		const migration = MIGRATIONS[3];
		expect(migration).toBeDefined();
		expect(db.executed).toEqual(splitStatements(migration?.sql ?? ""));
	});

	test("does nothing when every migration is recorded", async () => {
		const db = fakeDatabase({ schemaLevel: 3, tracked: [0, 1, 2, 3] });

		await expect(migrate({ store: db.store })).resolves.toEqual({
			applied: [],
			adopted: [],
		});
		expect(db.executed).toEqual([]);
	});

	test("rolls back a failing migration and reports it", async () => {
		const db = fakeDatabase({
			schemaLevel: 2,
			tracked: [0, 1, 2],
			failOn: 'RENAME COLUMN "type" TO "kind"',
		});

		const error = await expectMnemocyteError(
			migrate({ store: db.store }),
			"MIGRATION",
		);

		expect(error.message).toContain("0003_schema_v2");
		expect(error.cause).toMatchObject({ code: "42601" });
		expect(db.state.tracked).toEqual([0, 1, 2]);
		expect(db.log.at(-1)).toBe("ROLLBACK");
	});

	test("rejects dimensions that differ from the installation", async () => {
		const db = fakeDatabase({ schemaLevel: 3, dimensions: 1536 });

		await expectMnemocyteError(
			migrate({ store: db.store, dimensions: 768 }),
			"CONFIG",
		);
		expect(db.state.tracked).toBeNull();
	});

	test("accepts matching dimensions on an existing installation", async () => {
		const db = fakeDatabase({ schemaLevel: 3, tracked: [0, 1, 2, 3] });

		await expect(
			migrate({ store: db.store, dimensions: 1536 }),
		).resolves.toEqual({ applied: [], adopted: [] });
	});

	test("rejects a schema that matches no migration", async () => {
		const db = fakeDatabase({
			schemaLevel: 1,
			catalog: {
				memories: true,
				events: false,
				meta: true,
				metaModel: false,
				scoped: false,
			},
		});

		await expectMnemocyteError(migrate({ store: db.store }), "MIGRATION");
		expect(db.state.tracked).toBeNull();
	});

	test("rejects tracking rows with gaps", async () => {
		const db = fakeDatabase({ schemaLevel: 3, tracked: [0, 2, 3] });

		await expectMnemocyteError(migrate({ store: db.store }), "MIGRATION");
	});

	test("rejects a database migrated by a newer version", async () => {
		const db = fakeDatabase({ schemaLevel: 3, tracked: [0, 1, 2, 3, 4] });

		const error = await expectMnemocyteError(
			migrate({ store: db.store }),
			"MIGRATION",
		);
		expect(error.message).toContain("newer");
	});

	test("rejects with ABORTED before any statement when the signal is aborted", async () => {
		const db = fakeDatabase();
		const controller = new AbortController();
		controller.abort();

		await expectMnemocyteError(
			migrate({
				store: db.store,
				dimensions: 1536,
				signal: controller.signal,
			}),
			"ABORTED",
		);
		expect(db.log).toEqual([]);
	});

	test("maps other driver errors to DB", async () => {
		const db = fakeDatabase({ failOn: "pg_advisory_xact_lock" });

		await expectMnemocyteError(
			migrate({ store: db.store, dimensions: 1536 }),
			"DB",
		);
	});

	test.each([0, -1, 1.5, 4001, Number.NaN])(
		"rejects dimensions %s",
		async (dimensions) => {
			const db = fakeDatabase();

			await expectMnemocyteError(
				migrate({ store: db.store, dimensions }),
				"VALIDATION",
			);
			expect(db.log).toEqual([]);
		},
	);

	test("rejects a store that no adapter created", async () => {
		await expectMnemocyteError(
			migrate({ store: {} as MnemocyteStoreConfig }),
			"CONFIG",
		);
	});
});

describe("bundled migrations", () => {
	test("match the SQL files and the Drizzle journal", async () => {
		const journal = JSON.parse(
			await readFile("migrations/meta/_journal.json", "utf8"),
		) as { entries: { idx: number; tag: string }[] };

		expect(
			MIGRATIONS.map(({ version, name }) => ({ idx: version, tag: name })),
		).toEqual(journal.entries.map(({ idx, tag }) => ({ idx, tag })));
		for (const migration of MIGRATIONS) {
			expect(migration.sql).toBe(
				await readFile(`migrations/${migration.name}.sql`, "utf8"),
			);
		}
	});

	test("are what the bundling script generates", async () => {
		const { stdout } = await execFileAsync("node", [
			"scripts/bundle-migrations.mjs",
			"--stdout",
		]);

		expect(await readFile("src/db/migrations/bundled.ts", "utf8")).toBe(stdout);
	});

	test("render the checked-in fresh install at 1536 dimensions", async () => {
		expect(renderInitialSchema(1536)).toBe(
			await readFile("migrations/fresh-install.sql", "utf8"),
		);
	});

	test("split into statements at the Drizzle breakpoints", () => {
		const initial = MIGRATIONS[0];
		const schemaV2 = MIGRATIONS[3];

		// Two tables, the self foreign key and four indexes.
		expect(splitStatements(initial?.sql ?? "")).toHaveLength(7);
		const doBlock = splitStatements(schemaV2?.sql ?? "").find((statement) =>
			statement.startsWith("DO $$"),
		);
		expect(doBlock).toMatch(/^DO \$\$[\s\S]*END\n\$\$;$/);
	});
});
