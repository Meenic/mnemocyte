// Loaded with a dynamic `import()` from `store-input.ts`, so the Postgres
// backend (queries, migrations, driver adapters) stays out of the root
// entry's static graph and in-memory users never load it.

import { executorFor } from "../sql/clients.js";
import type { DetectedClient } from "../sql/detect.js";
import { createPostgresStore } from "./postgres.js";
import type { MemoryStore } from "./store.js";

/** The Postgres store for a client `createMemory` or `migrate` recognised. */
export function createClientStore(detected: DetectedClient): MemoryStore {
	return createPostgresStore(executorFor(detected));
}
