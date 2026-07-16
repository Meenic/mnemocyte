import { createDatabase } from "./db/index.js";
import { createInMemoryClient } from "./memory/in-memory.js";
import { createPostgresClient } from "./memory/postgres.js";
import {
	assertEmbedder,
	assertNonEmptyString,
	validateProviderResilienceConfig,
	validateRetrievalConfig,
} from "./memory/validation.js";
import type { MnemocyteClient, MnemocyteConfig } from "./types.js";

/**
 * Create a Mnemocyte client.
 *
 * When {@link MnemocyteConfig.databaseUrl} is provided, a Postgres-backed
 * client is returned (requires the `pgvector` extension and the bundled
 * migration applied). Otherwise an in-memory client is returned, intended
 * for tests, demos, and short-lived processes.
 *
 * The returned client owns any underlying resources (e.g. the Postgres
 * connection pool). Call {@link MnemocyteClient.close} when finished to
 * release them.
 *
 * @param config - Client configuration. {@link MnemocyteConfig.embedder} is required.
 * @returns A {@link MnemocyteClient} instance.
 * @throws {MnemocyteError} With code `"CONFIG"` if `embedder`, retrieval
 * tuning, provider resilience, or the database URL is malformed, or
 * `"VALIDATION"` if
 * `databaseUrl` is explicitly empty.
 *
 * @example Postgres-backed client
 * ```ts
 * const client = createMnemocyte({
 *   databaseUrl: process.env.DATABASE_URL,
 *   embedder, // embedder.dimensions must match mnemocyte_meta
 * });
 * ```
 */
export function createMnemocyte(config: MnemocyteConfig): MnemocyteClient {
	assertEmbedder(config.embedder);
	validateRetrievalConfig(config.retrieval);
	validateProviderResilienceConfig(config.provider);
	if (config.databaseUrl !== undefined) {
		assertNonEmptyString(config.databaseUrl, "databaseUrl");
		return createPostgresClient(config, createDatabase(config.databaseUrl));
	}
	return createInMemoryClient(config);
}
