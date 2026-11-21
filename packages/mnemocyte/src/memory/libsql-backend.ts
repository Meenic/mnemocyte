// Loaded with a dynamic `import()` from `store-input.ts`, so the libSQL
// backend (queries, migrations, the driver adapter) stays out of the root
// entry's static graph, as the Postgres backend does.

import { createLibsqlExecutor } from "../db/libsql/executor.js";
import type { LibsqlDriverClient } from "../sql/detect.js";
import { createLibsqlStore } from "./libsql.js";
import type { MemoryStore } from "./store.js";

/** The libSQL store for a client `createMemory` or `migrate` recognised. */
export function createLibsqlClientStore(
	client: LibsqlDriverClient,
): MemoryStore {
	return createLibsqlStore(createLibsqlExecutor(client));
}
