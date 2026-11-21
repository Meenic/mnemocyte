import { openPGlite } from "./pglite.js";
import { describeStoreContract } from "./suite.js";

// createMemory({ store: db }) and migrate({ store: db }): detection and the
// lazily imported backend, end to end.
describeStoreContract(
	"PGlite passed as store",
	async () => {
		const db = await openPGlite({ pgvector: true });
		return { client: db, close: () => db.close() };
	},
	{ directClient: true },
);
