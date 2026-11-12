import { createMemoryClient } from "./memory/client-core.js";
import { createInMemoryStore } from "./memory/in-memory.js";
import { createScopedClient } from "./memory/scope-binding.js";
import { unwrapMnemocyteStoreConfig } from "./memory/store-config.js";
import {
	assertEmbedder,
	validateDefaultNamespace,
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
 * With {@link MemoryConfig.namespace}, scopes may omit `namespace`, and
 * `memory.for(scope)` returns a client bound to one scope.
 *
 * @param config - Client configuration. {@link MemoryConfig.embedder} is required.
 * @returns A {@link MemoryClient}; `MemoryClient<true>` when `config` has a
 * `namespace`.
 * @throws {MnemocyteError} With code `"CONFIG"` if `embedder`, `namespace`,
 * retrieval tuning, provider resilience, or `store` is malformed.
 *
 * @example Postgres-backed client bound to a user
 * ```ts
 * import postgres from "postgres";
 * import { postgresStore } from "mnemocyte/postgres";
 *
 * const sql = postgres(process.env.DATABASE_URL);
 * const memory = createMemory({
 *   namespace: "my-app",
 *   store: postgresStore({ client: sql }),
 *   embedder, // embedder.dimensions must match the installation
 * });
 * const userMemory = memory.for({ entityId: user.id });
 * await userMemory.add({ content: "Prefers short, direct answers." });
 * ```
 */
export function createMemory(
	config: MemoryConfig & { namespace: string },
): MemoryClient<true>;
export function createMemory(config: MemoryConfig): MemoryClient;
export function createMemory(config: MemoryConfig): MemoryClient<boolean> {
	assertEmbedder(config.embedder);
	const namespace = validateDefaultNamespace(config.namespace);
	validateRetrievalConfig(config.retrieval);
	validateProviderResilienceConfig(config.provider);
	const store =
		config.store === undefined
			? createInMemoryStore()
			: unwrapMnemocyteStoreConfig(config.store);
	return createScopedClient(createMemoryClient(config, store), {
		config,
		backend: store.backend,
		namespace,
		internals: { store, embedder: config.embedder },
	});
}
