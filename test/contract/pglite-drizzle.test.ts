import { drizzle } from "drizzle-orm/pglite";
import { openPGlite } from "./pglite.js";
import { describeStoreContract } from "./suite.js";

describeStoreContract("Drizzle over PGlite", async () => {
	const db = await openPGlite({ pgvector: true });
	return { client: drizzle({ client: db }), close: () => db.close() };
});
