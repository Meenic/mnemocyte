import type { PGlite } from "@electric-sql/pglite";
import { createMemory, type Embedder, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations/bundled.js";
import { expectMnemocyteError } from "../helpers.js";
import { openPGlite } from "./pglite.js";
import { describeStoreContract } from "./suite.js";

// The other PGlite runs of the contract are in pglite-*.test.ts, one per
// file, so Vitest runs them on separate workers.
describeStoreContract("PGlite", async () => {
	const db = await openPGlite({ pgvector: true });
	return { client: db, close: () => db.close() };
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
		const db = await openPGlite({ pgvector: false });
		try {
			const memory = createMemory({
				store: postgresStore({ client: db }),
				embedder,
			});
			const empty = { vector: false, memories: false, tracking: false };

			await expectMnemocyteError(
				migrate({ memory, dryRun: true }),
				"MIGRATION",
				"PGVECTOR_UNAVAILABLE",
			);
			await expect(
				migrate({ memory, dryRun: true, createExtension: true }),
			).resolves.toEqual({
				applied: names,
				adopted: [],
				extensionCreated: true,
				schemaCreated: false,
			});
			expect(await catalog(db)).toEqual(empty);

			await expect(migrate({ memory, createExtension: true })).resolves.toEqual(
				{
					applied: names,
					adopted: [],
					extensionCreated: true,
					schemaCreated: false,
				},
			);
			expect(await catalog(db)).toEqual({
				vector: true,
				memories: true,
				tracking: true,
			});

			const current = {
				applied: [],
				adopted: [],
				extensionCreated: false,
				schemaCreated: false,
			};
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
