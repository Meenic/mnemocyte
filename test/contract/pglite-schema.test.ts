import { openPGlite } from "./pglite.js";
import { describeStoreContract } from "./suite.js";

// Every query must name the schema: "mnemocyte_test" is not on search_path,
// so a bare table name fails with 42P01.
describeStoreContract(
	"PGlite, tables in a schema",
	async () => {
		const db = await openPGlite({ pgvector: true });
		return { client: db, close: () => db.close() };
	},
	{ schemaName: "mnemocyte_test" },
);
