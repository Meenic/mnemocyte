import { createDatabase } from "../db/index.js";
import { createPostgresStore } from "./postgres.js";
import type { MemoryStore } from "./store.js";

export function createPostgresStoreFromUrl(databaseUrl: string): MemoryStore {
	return createPostgresStore(createDatabase(databaseUrl));
}
