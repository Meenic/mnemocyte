/**
 * `mnemocyte/store/test`: the contract suite every Mnemocyte backend
 * passes, for a third-party store to run against itself under Vitest. It
 * needs the optional `vitest` peer.
 *
 * @packageDocumentation
 */

import { describe } from "vitest";
import {
	CONTRACT_DIMENSIONS,
	CONTRACT_EMBEDDING_MODEL,
	contractClientFactory,
	registerSharedContract,
} from "./store-test/contract.js";
import type { MnemocyteStoreConfig } from "./types.js";

/**
 * The dimensions of every embedding the suite writes. A store with a fixed
 * vector column needs this many dimensions, and
 * `capabilities.maxDimensions` at least this.
 */
export const STORE_CONTRACT_DIMENSIONS: number = CONTRACT_DIMENSIONS;

/** The embedding model name of every memory the suite writes. */
export const STORE_CONTRACT_EMBEDDING_MODEL: string = CONTRACT_EMBEDDING_MODEL;

/** Input for {@link describeMemoryStoreContract}'s `failAuditWrites`. */
export interface FailAuditWritesInput {
	/** The namespace whose audit event writes should fail or work again. */
	namespace: string;
	/** `true` to make them fail, `false` to undo it. */
	failing: boolean;
}

/** Options for {@link describeMemoryStoreContract}. */
export interface MemoryStoreContractOptions {
	/** Shown in the `describe` title, such as `"acme-kv"`. */
	name: string;
	/**
	 * The store under test as `createMemory` takes it, usually
	 * `defineMemoryStore({ store })`. Called for every client the suite
	 * builds, inside its tests, so a `beforeAll` of the caller has run. It
	 * may return the same value each time. The store must be ready for
	 * memories of {@link STORE_CONTRACT_DIMENSIONS} dimensions; the suite
	 * does not migrate it.
	 */
	store: () => MnemocyteStoreConfig;
	/**
	 * Make the audit event writes of one namespace fail, or work again, so
	 * the suite can check that a failed audit write rolls back the write it
	 * records (a trigger, or a fault switch in the store). Without it that
	 * test is skipped.
	 */
	failAuditWrites?:
		| ((input: FailAuditWritesInput) => Promise<void>)
		| undefined;
}

/**
 * Register the contract suite for a store in a Vitest `describe` named
 * `MemoryStoreV1 contract (<name>)`. Call it at the top level of a test
 * file, or inside a `describe` with the caller's own setup hooks.
 *
 * The suite runs through the public client: values round-trip, keyed adds,
 * list paging, updates, scope visibility and isolation, search with and
 * without filters, context, deletes with consolidation dependents,
 * duplicates, consolidation, audit events, audit pages and retention, and
 * stats. Expectations that differ by backend read the store's
 * `capabilities`. Every test writes in namespaces of its own that start
 * with `contract_`, and nothing is deleted afterwards, so run it on a
 * database kept for tests. One test calls `migrate()` on the ready store
 * and expects nothing applied. A minor release may add tests.
 *
 * @example
 * ```ts
 * import { defineMemoryStore } from "mnemocyte/store";
 * import { describeMemoryStoreContract } from "mnemocyte/store/test";
 *
 * describeMemoryStoreContract({
 *   name: "acme-kv",
 *   store: () => defineMemoryStore({ store: kvStore }),
 * });
 * ```
 */
export function describeMemoryStoreContract(
	options: MemoryStoreContractOptions,
): void {
	const { store, failAuditWrites } = options;
	describe(`MemoryStoreV1 contract (${options.name})`, () => {
		registerSharedContract({
			storeInput: store,
			client: contractClientFactory(store, []),
			...(failAuditWrites === undefined
				? {}
				: {
						failAuditWrites: (namespace, failing) =>
							failAuditWrites({ namespace, failing }),
					}),
		});
	});
}
