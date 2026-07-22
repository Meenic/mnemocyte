import { parsePostgresDatabaseUrl } from "./database-url.js";
import { MnemocyteError } from "./errors.js";
import { createMemoryClient } from "./memory/client-core.js";
import { createInMemoryClient } from "./memory/in-memory.js";
import { createLazyPostgresStore } from "./memory/lazy-postgres.js";
import { unwrapMnemocyteStoreConfig } from "./memory/store-config.js";
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
 * When {@link MnemocyteConfig.store} is provided, that adapter is used. When
 * {@link MnemocyteConfig.databaseUrl} is provided, a URL-owned Postgres client
 * is used (requires the `pgvector` extension and the bundled migrations).
 * When neither is supplied, an in-memory client is returned for tests, demos,
 * and short-lived processes.
 *
 * Call {@link MnemocyteClient.close} when finished. URL-created database
 * resources are owned and closed by Mnemocyte; resources behind a supplied
 * store retain the ownership policy documented by that adapter.
 *
 * @param config - Client configuration. {@link MnemocyteConfig.embedder} is required.
 * @returns A {@link MnemocyteClient} instance.
 * @throws {MnemocyteError} With code `"CONFIG"` if `embedder`, retrieval
 * tuning, provider resilience, or the database URL is malformed or does not
 * use the `postgres:` / `postgresql:` protocol, or if `databaseUrl` and
 * `store` are both provided; or `"VALIDATION"` if `databaseUrl` is explicitly
 * empty.
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
	if (config.databaseUrl !== undefined && config.store !== undefined) {
		throw new MnemocyteError(
			"databaseUrl and store cannot be provided together.",
			"CONFIG",
		);
	}
	if (config.databaseUrl !== undefined) {
		assertNonEmptyString(config.databaseUrl, "databaseUrl");
		parsePostgresDatabaseUrl(config.databaseUrl);
		return createMemoryClient(
			config,
			createLazyPostgresStore(config.databaseUrl),
		);
	}
	if (config.store !== undefined) {
		return createMemoryClient(config, unwrapMnemocyteStoreConfig(config.store));
	}
	return createInMemoryClient(config);
}
