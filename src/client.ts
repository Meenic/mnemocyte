import { createMemoryClient } from "./memory/client-core.js";
import { createInMemoryClient } from "./memory/in-memory.js";
import { unwrapMnemocyteStoreConfig } from "./memory/store-config.js";
import {
	assertEmbedder,
	validateProviderResilienceConfig,
	validateRetrievalConfig,
} from "./memory/validation.js";
import type { MnemocyteClient, MnemocyteConfig } from "./types.js";

/**
 * Create a Mnemocyte client.
 *
 * When {@link MnemocyteConfig.store} is provided, that adapter is used. When it
 * is omitted, an in-memory client is returned for tests, demos, and
 * short-lived processes.
 *
 * Call {@link MnemocyteClient.close} when finished. Database clients behind a
 * supplied store stay owned by the caller: closing the Mnemocyte client never
 * ends them.
 *
 * @param config - Client configuration. {@link MnemocyteConfig.embedder} is required.
 * @returns A {@link MnemocyteClient} instance.
 * @throws {MnemocyteError} With code `"CONFIG"` if `embedder`, retrieval
 * tuning, provider resilience, or `store` is malformed.
 *
 * @example Postgres-backed client
 * ```ts
 * import postgres from "postgres";
 * import { postgresJs, postgresStore } from "mnemocyte/postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL);
 * const client = createMnemocyte({
 *   store: postgresStore({ client: postgresJs(sql) }),
 *   embedder, // embedder.dimensions must match mnemocyte_meta
 * });
 * ```
 */
export function createMnemocyte(config: MnemocyteConfig): MnemocyteClient {
	assertEmbedder(config.embedder);
	validateRetrievalConfig(config.retrieval);
	validateProviderResilienceConfig(config.provider);
	if (config.store !== undefined) {
		return createMemoryClient(config, unwrapMnemocyteStoreConfig(config.store));
	}
	return createInMemoryClient(config);
}
