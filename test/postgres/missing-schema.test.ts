import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory, type Embedder, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { afterEach, describe, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations/bundled.js";
import type { MnemocyteError } from "../../src/errors.js";
import { expectMnemocyteError } from "../helpers.js";

const INSTALL_GUIDE =
	"https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md#install-the-schema";
const INSTALLATION_GUIDE =
	"https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md#one-embedding-model-per-installation";

const scope = { namespace: "setup", entityId: "pglite" };

let db: PGlite | undefined;

afterEach(async () => {
	await db?.close();
	db = undefined;
});

/** A PGlite with pgvector enabled and no Mnemocyte tables. */
async function emptyDatabase(): Promise<PGlite> {
	db = await PGlite.create({ extensions: { vector } });
	await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
	return db;
}

function setup(client: PGlite) {
	const embedded: string[] = [];
	const embedder: Embedder = {
		model: "pglite-hint",
		dimensions: 3,
		async embed(texts) {
			embedded.push(...texts);
			return texts.map((text) => [text.length, 1, 0]);
		},
	};
	const memory = createMemory({
		store: postgresStore({ client }),
		embedder,
	});
	return { memory, embedded };
}

function causeCode(error: MnemocyteError): unknown {
	const { cause } = error;
	return typeof cause === "object" && cause !== null && "code" in cause
		? cause.code
		: undefined;
}

function expectMigrateHint(error: MnemocyteError, sqlstate: string): void {
	expect(error.message).toMatch(
		/^Mnemocyte's tables are missing or out of date in this database \(.+\)\. Run migrate\(\{ memory \}\) to create or upgrade them: /,
	);
	expect(error.message.endsWith(INSTALL_GUIDE)).toBe(true);
	expect(error.message).not.toContain(".sql");
	expect(causeCode(error)).toBe(sqlstate);
}

describe("missing-schema errors on PGlite", () => {
	test("an empty database names migrate({ memory }) and the guide", async () => {
		const { memory, embedded } = setup(await emptyDatabase());

		const added = await expectMnemocyteError(
			memory.add({ scope, content: "Before migrate." }),
			"MIGRATION",
		);
		expectMigrateHint(added, "42P01");
		expect(added.message).toContain("mnemocyte_meta");

		const searched = await expectMnemocyteError(
			memory.search({ scope, query: "Before" }),
			"MIGRATION",
		);
		expectMigrateHint(searched, "42P01");

		const listed = await expectMnemocyteError(
			memory.list({ scope }),
			"MIGRATION",
		);
		expectMigrateHint(listed, "42P01");
		expect(listed.message).toContain("mnemocyte_memories");

		// The metadata check fails before the embedder is called.
		expect(embedded).toEqual([]);
	});

	test("a 0.5 schema (0000 to 0002) names the same fix for a missing column", async () => {
		const client = await emptyDatabase();
		for (const migration of MIGRATIONS.slice(0, 3)) {
			await client.exec(migration.sql);
		}
		const { memory, embedded } = setup(client);

		const listed = await expectMnemocyteError(
			memory.list({ scope }),
			"MIGRATION",
		);
		expectMigrateHint(listed, "42703");

		const added = await expectMnemocyteError(
			memory.add({ scope, content: "On an old schema." }),
			"MIGRATION",
		);
		expectMigrateHint(added, "42703");
		expect(added.message).toContain("vector_type");
		expect(embedded).toEqual([]);
	});

	test("a deleted installation row is not sent to migrate", async () => {
		const client = await emptyDatabase();
		const { memory, embedded } = setup(client);
		await migrate({ memory });
		await client.exec("DELETE FROM mnemocyte_meta;");

		// migrate() writes the row only for a fresh install, so it is no fix.
		await expect(migrate({ memory })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
		});

		const error = await expectMnemocyteError(
			memory.search({ scope, query: "anything" }),
			"MIGRATION",
		);
		expect(error.message).toContain('mnemocyte_meta has no "installation" row');
		expect(error.message).toContain(
			"migrate() writes the row only when it creates the schema",
		);
		expect(error.message.endsWith(INSTALLATION_GUIDE)).toBe(true);
		expect(error.message).not.toContain(".sql");
		expect(embedded).toEqual([]);

		// The guide's INSERT restores it; the model is recorded on first use.
		await client.exec(
			"INSERT INTO mnemocyte_meta (key, embedding_dimensions, vector_type) VALUES ('installation', 3, 'vector');",
		);
		await memory.add({ scope, content: "Restored." });
		await expect(
			memory.search({ scope, query: "Restored" }),
		).resolves.toHaveLength(1);
	});
});
