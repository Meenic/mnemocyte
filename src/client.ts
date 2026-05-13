import { createDatabase } from "./db/index.js";
import { MnemocyteError } from "./errors.js";
import { createInMemoryClient } from "./memory/in-memory.js";
import { createPostgresClient } from "./memory/postgres.js";
import { assertEmbedder, assertNonEmptyString } from "./memory/shared.js";
import type { MnemocyteClient, MnemocyteConfig } from "./types.js";

/** Embedding dimensionality pinned by `migrations/0000_initial.sql`. */
const POSTGRES_EMBEDDING_DIMENSIONS = 1536;

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
 * @throws {MnemocyteError} With code `"CONFIG"` if `embedder` is missing or
 * invalid (including when `databaseUrl` is set and `embedder.dimensions`
 * is not 1536 — the dimensionality pinned by the bundled migration), or
 * `"VALIDATION"` if `databaseUrl` is provided but empty.
 *
 * @example Postgres-backed client
 * ```ts
 * const client = createMnemocyte({
 *   databaseUrl: process.env.DATABASE_URL,
 *   embedder, // embedder.dimensions MUST be 1536 for the Postgres backend
 * });
 * ```
 */
export function createMnemocyte(config: MnemocyteConfig): MnemocyteClient {
	assertEmbedder(config.embedder);
	if (config.databaseUrl) {
		assertNonEmptyString(config.databaseUrl, "databaseUrl");
		if (config.embedder.dimensions !== POSTGRES_EMBEDDING_DIMENSIONS) {
			throw new MnemocyteError(
				`embedder.dimensions must be ${POSTGRES_EMBEDDING_DIMENSIONS} for the Postgres backend (got ${config.embedder.dimensions}). The bundled migration pins the vector column to vector(${POSTGRES_EMBEDDING_DIMENSIONS}).`,
				"CONFIG",
			);
		}
		return createPostgresClient(config, createDatabase(config.databaseUrl));
	}
	return createInMemoryClient(config);
}
