/**
 * `mnemocyte/store`: the public store contract, for packages that add a
 * storage backend. An app passes such a store to `createMemory` the way it
 * passes `postgresStore()`; the contract suite at `mnemocyte/store/test`
 * checks that a store behaves like the first-party ones.
 *
 * @packageDocumentation
 */

import { createMemoryStoreV1Config } from "./memory/store-config.js";
import type { MemoryStoreV1 } from "./memory/store-v1.js";
import { assertMemoryStoreV1 } from "./memory/store-v1-adapter.js";
import { assertKnownKeys } from "./options.js";
import type { MnemocyteStoreConfig } from "./types.js";

export type {
	MemoryStoreV1,
	MemoryStoreV1AuditLogEntry,
	MemoryStoreV1AuditLogInput,
	MemoryStoreV1AuditPosition,
	MemoryStoreV1AuditPruneInput,
	MemoryStoreV1CallOptions,
	MemoryStoreV1Capabilities,
	MemoryStoreV1ConsolidateInput,
	MemoryStoreV1ConsolidateResult,
	MemoryStoreV1DeletedMemory,
	MemoryStoreV1DeleteFilterInput,
	MemoryStoreV1DeleteInput,
	MemoryStoreV1DeleteMemoryInput,
	MemoryStoreV1DeleteResult,
	MemoryStoreV1DeleteScopeInput,
	MemoryStoreV1DuplicateFilter,
	MemoryStoreV1DuplicateInput,
	MemoryStoreV1DuplicatePage,
	MemoryStoreV1DuplicatePageInput,
	MemoryStoreV1DuplicatePair,
	MemoryStoreV1DuplicateResult,
	MemoryStoreV1DuplicateTop,
	MemoryStoreV1DuplicateTopInput,
	MemoryStoreV1EmbedderInput,
	MemoryStoreV1EntitySelector,
	MemoryStoreV1Filter,
	MemoryStoreV1GetByIdsInput,
	MemoryStoreV1GetByKeyInput,
	MemoryStoreV1GetInput,
	MemoryStoreV1InsertInput,
	MemoryStoreV1LexicalCandidate,
	MemoryStoreV1LexicalQuery,
	MemoryStoreV1ListInput,
	MemoryStoreV1ListPosition,
	MemoryStoreV1MarkAccessedInput,
	MemoryStoreV1MigrateInput,
	MemoryStoreV1Patch,
	MemoryStoreV1PruneFilter,
	MemoryStoreV1Row,
	MemoryStoreV1SearchCandidates,
	MemoryStoreV1SearchInput,
	MemoryStoreV1Selector,
	MemoryStoreV1StatsInput,
	MemoryStoreV1UpdateInput,
	MemoryStoreV1VectorCandidate,
	MemoryStoreV1VectorQuery,
	MemoryStoreV1Visibility,
} from "./memory/store-v1.js";

/** Options for {@link defineMemoryStore}. */
export interface DefineMemoryStoreOptions {
	/** The backend, implementing {@link MemoryStoreV1}. */
	store: MemoryStoreV1;
}

/**
 * Wrap a {@link MemoryStoreV1} as the `store` that `createMemory` and
 * `migrate` take. The store's version, name, capabilities and methods are
 * checked here, so a malformed store fails when the app starts rather than on
 * its first query. Mnemocyte reports its backend as `"custom"`.
 *
 * A backend package calls this in its own factory and returns the result,
 * as `postgresStore()` does.
 *
 * @example
 * ```ts
 * import { createMemory } from "mnemocyte";
 * import { defineMemoryStore } from "mnemocyte/store";
 *
 * // kvStore implements MemoryStoreV1.
 * const memory = createMemory({
 *   store: defineMemoryStore({ store: kvStore }),
 *   embedder,
 * });
 * ```
 *
 * @throws {MnemocyteError} `"CONFIG"` (`"INVALID_OPTION"`) when `store` is
 * not a V1 store, or declares a `specificationVersion` this version of
 * mnemocyte does not support.
 */
export function defineMemoryStore(
	options: DefineMemoryStoreOptions,
): MnemocyteStoreConfig {
	assertKnownKeys("defineMemoryStore", options, ["store"]);
	// From JavaScript, `options` may be anything; the check names the
	// missing store.
	const store: unknown = (options as Partial<DefineMemoryStoreOptions> | null)
		?.store;
	assertMemoryStoreV1(store);
	return createMemoryStoreV1Config(store);
}
