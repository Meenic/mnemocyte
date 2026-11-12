import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { describeStoreContract } from "./suite.js";

/** An in-process Postgres 18 with pgvector, gone when it is closed. */
async function createPGlite(): Promise<PGlite> {
	const db = await PGlite.create({ extensions: { vector } });
	await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");
	return db;
}

describeStoreContract("PGlite", async () => {
	const db = await createPGlite();
	return { client: db, close: () => db.close() };
});

describeStoreContract("Drizzle over PGlite", async () => {
	const db = await createPGlite();
	return { client: drizzle({ client: db }), close: () => db.close() };
});
