import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { createMemory, type Embedder, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations/bundled.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { expectMnemocyteError } from "../helpers.js";
import { describeStoreContract } from "./suite.js";

/** An in-process Postgres 18 with pgvector, gone when it is closed. */
async function createPGlite(): Promise<PGlite> {
	const db = await PGlite.create({ extensions: { vector } });
	await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
	return db;
}

/**
 * postgres.js 4 sends parameters untyped and lets the server pick each type;
 * 3.x typed a `Date`, boolean, `bigint`, `Buffer` or array from JavaScript.
 * Strings, finite numbers and null are written the same either way, so every
 * statement Mnemocyte sends must stick to them (timestamps as ISO strings
 * with `::timestamptz`, JSON and tags as text).
 */
function assertPortableParams(sql: string, params: readonly unknown[]): void {
	params.forEach((value, index) => {
		if (
			value === null ||
			typeof value === "string" ||
			(typeof value === "number" && Number.isFinite(value))
		) {
			return;
		}
		const kind = Array.isArray(value) ? "array" : typeof value;
		throw new Error(
			`Parameter ${index + 1} is a ${kind}, not a string, number or null: ${sql}`,
		);
	});
}

/** Wraps an executor and checks every statement's parameters first. */
function checkingParams(inner: SqlExecutor): SqlExecutor {
	const executor: SqlExecutor = {
		query(sql, params, options) {
			assertPortableParams(sql, params);
			return inner.query(sql, params, options);
		},
	};
	if (inner.transaction) {
		const transaction = inner.transaction.bind(inner);
		executor.transaction = (fn) => transaction((tx) => fn(checkingParams(tx)));
	}
	if (inner.batch) {
		const batch = inner.batch.bind(inner);
		executor.batch = (statements, options) => {
			for (const statement of statements) {
				assertPortableParams(statement.sql, statement.params);
			}
			return batch(statements, options);
		};
	}
	return executor;
}

describeStoreContract("PGlite", async () => {
	const db = await createPGlite();
	return { client: db, close: () => db.close() };
});

describeStoreContract("Drizzle over PGlite", async () => {
	const db = await createPGlite();
	return { client: drizzle({ client: db }), close: () => db.close() };
});

describeStoreContract("PGlite, parameter types checked", async () => {
	const db = await createPGlite();
	return {
		client: checkingParams(toSqlExecutor(db)),
		close: () => db.close(),
	};
});

describe("migrate on a PGlite without pgvector enabled", () => {
	const names = MIGRATIONS.map((migration) => migration.name);
	const embedder: Embedder = {
		model: "pglite-setup",
		dimensions: 3,
		async embed(texts) {
			return texts.map((text) => [text.length, 1, 0]);
		},
	};

	async function catalog(db: PGlite) {
		const { rows } = await db.query<{
			vector: boolean;
			memories: boolean;
			tracking: boolean;
		}>(`SELECT
			EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS "vector",
			to_regclass('mnemocyte_memories') IS NOT NULL AS "memories",
			to_regclass('mnemocyte_migrations') IS NOT NULL AS "tracking"`);
		return rows[0];
	}

	test("dryRun changes nothing; createExtension enables pgvector and installs", async () => {
		// The extension's files are loaded, but CREATE EXTENSION has not run.
		const db = await PGlite.create({ extensions: { vector } });
		try {
			const memory = createMemory({
				store: postgresStore({ client: db }),
				embedder,
			});
			const empty = { vector: false, memories: false, tracking: false };

			await expectMnemocyteError(
				migrate({ memory, dryRun: true }),
				"MIGRATION",
			);
			await expect(
				migrate({ memory, dryRun: true, createExtension: true }),
			).resolves.toEqual({
				applied: names,
				adopted: [],
				extensionCreated: true,
			});
			expect(await catalog(db)).toEqual(empty);

			await expect(migrate({ memory, createExtension: true })).resolves.toEqual(
				{
					applied: names,
					adopted: [],
					extensionCreated: true,
				},
			);
			expect(await catalog(db)).toEqual({
				vector: true,
				memories: true,
				tracking: true,
			});

			const current = { applied: [], adopted: [], extensionCreated: false };
			await expect(migrate({ memory, createExtension: true })).resolves.toEqual(
				current,
			);
			await expect(migrate({ memory, dryRun: true })).resolves.toEqual(current);

			const scope = { namespace: "setup", entityId: "pglite" };
			await memory.add({ scope, content: "Installed by migrate." });
			await expect(
				memory.search({ scope, query: "Installed" }),
			).resolves.toHaveLength(1);
		} finally {
			await db.close();
		}
	});
});
