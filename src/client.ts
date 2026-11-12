import { createMemoryClient } from "./memory/client-core.js";
import { createInMemoryStore } from "./memory/in-memory.js";
import { unwrapMnemocyteStoreConfig } from "./memory/store-config.js";
import {
	assertEmbedder,
	validateProviderResilienceConfig,
	validateRetrievalConfig,
} from "./memory/validation.js";
import type { MemoryClient, MemoryConfig } from "./types.js";

/**
 * Create a memory client.
 *
 * With {@link MemoryConfig.store}, memories live in that store's database;
 * without it, in process memory, for tests and prototypes. The client holds
 * no connections or timers and needs no shutdown call: the database client
 * behind a store stays owned by the caller.
 *
 * @param config - Client configuration. {@link MemoryConfig.embedder} is required.
 * @returns A {@link MemoryClient}.
 * @throws {MnemocyteError} With code `"CONFIG"` if `embedder`, retrieval
 * tuning, provider resilience, or `store` is malformed.
 *
 * @example Postgres-backed client
 * ```ts
 * import postgres from "postgres";
 * import { postgresJs, postgresStore } from "mnemocyte/postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL);
 * const memory = createMemory({
 *   store: postgresStore({ client: postgresJs(sql) }),
 *   embedder, // embedder.dimensions must match the installation
 * });
 * ```
 */
export function createMemory(config: MemoryConfig): MemoryClient {
	assertEmbedder(config.embedder);
	validateRetrievalConfig(config.retrieval);
	validateProviderResilienceConfig(config.provider);
	const store =
		config.store === undefined
			? createInMemoryStore()
			: unwrapMnemocyteStoreConfig(config.store);
	return createMemoryClient(config, store);
}
