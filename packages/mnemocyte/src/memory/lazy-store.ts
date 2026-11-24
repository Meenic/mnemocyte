import { MnemocyteError } from "../errors.js";
import type { DirectConnection } from "../sql/detect.js";
import type { MnemocyteBackend } from "../types.js";
import type { MemoryStore, StoreCapabilities } from "./store.js";

/** Input for {@link createLazyStore}. */
export interface LazyStoreInput {
	/** Known before loading, because the client says which backend it is. */
	readonly backend: MnemocyteBackend;
	/** {@link MemoryStore.capabilities}, known before loading. */
	readonly capabilities: StoreCapabilities;
	/** {@link MemoryStore.schemaName}, known before loading. */
	readonly schemaName?: string;
	/** {@link MemoryStore.directConnection}, known before loading. */
	readonly directConnection?: DirectConnection;
	/** Loads the backend, typically with a dynamic `import()`. */
	readonly load: () => Promise<MemoryStore>;
}

/**
 * A {@link MemoryStore} that loads the real one on its first method call.
 *
 * Every store method is async, so the client stays synchronous to create
 * while the backend's code is fetched only when a query is about to run.
 * Concurrent first calls share one load. A failed load is not cached: the
 * next call tries again, so a transient chunk-loading failure does not
 * break the client for good.
 */
export function createLazyStore(input: LazyStoreInput): MemoryStore {
	let pending: Promise<MemoryStore> | undefined;
	const load = (): Promise<MemoryStore> => {
		pending ??= input.load().catch((error: unknown) => {
			pending = undefined;
			throw new MnemocyteError({
				message: `Could not load the ${input.backend} backend.`,
				code: "CONFIG",
				reason: "INVALID_OPTION",
				cause: error,
			});
		});
		return pending;
	};

	return {
		backend: input.backend,
		capabilities: input.capabilities,
		...(input.schemaName === undefined ? {} : { schemaName: input.schemaName }),
		...(input.directConnection === undefined
			? {}
			: { directConnection: input.directConnection }),
		migrate: async (value) => (await load()).migrate(value),
		setTextSearchConfig: async (value) =>
			(await load()).setTextSearchConfig(value),
		inspectInstallation: async (value) =>
			(await load()).inspectInstallation(value),
		ensureEmbeddingCompatibility: async (value) =>
			(await load()).ensureEmbeddingCompatibility(value),
		insert: async (value) => (await load()).insert(value),
		searchCandidates: async (value) => (await load()).searchCandidates(value),
		get: async (value) => (await load()).get(value),
		list: async (value) => (await load()).list(value),
		update: async (value) => (await load()).update(value),
		markAccessed: async (value) => (await load()).markAccessed(value),
		delete: async (value) => (await load()).delete(value),
		consolidate: async (value) => (await load()).consolidate(value),
		findDuplicates: async (value) => (await load()).findDuplicates(value),
		listAudit: async (value) => (await load()).listAudit(value),
		pruneAudit: async (value) => (await load()).pruneAudit(value),
		stats: async (value) => (await load()).stats(value),
	};
}
