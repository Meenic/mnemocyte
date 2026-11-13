import { MnemocyteError } from "../errors.js";
import type { MnemocyteBackend } from "../types.js";
import type { MemoryStore } from "./store.js";

/** Input for {@link createLazyStore}. */
export interface LazyStoreInput {
	/** Known before loading, because the client says which backend it is. */
	readonly backend: MnemocyteBackend;
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
			throw new MnemocyteError(
				`Could not load the ${input.backend} backend.`,
				"CONFIG",
				error,
			);
		});
		return pending;
	};

	return {
		backend: input.backend,
		migrate: async (...args) => (await load()).migrate(...args),
		ensureEmbeddingCompatibility: async (...args) =>
			(await load()).ensureEmbeddingCompatibility(...args),
		insertMemories: async (...args) => (await load()).insertMemories(...args),
		vectorSearch: async (...args) => (await load()).vectorSearch(...args),
		lexicalSearch: async (...args) => (await load()).lexicalSearch(...args),
		listMemories: async (...args) => (await load()).listMemories(...args),
		markMemoriesAccessed: async (...args) =>
			(await load()).markMemoriesAccessed(...args),
		getMemory: async (...args) => (await load()).getMemory(...args),
		getMemoryByKey: async (...args) => (await load()).getMemoryByKey(...args),
		updateMemory: async (...args) => (await load()).updateMemory(...args),
		deleteMemory: async (...args) => (await load()).deleteMemory(...args),
		deleteScope: async (...args) => (await load()).deleteScope(...args),
		prune: async (...args) => (await load()).prune(...args),
		findDuplicatePairs: async (...args) =>
			(await load()).findDuplicatePairs(...args),
		addAuditEvents: async (...args) => (await load()).addAuditEvents(...args),
		listAuditLog: async (...args) => (await load()).listAuditLog(...args),
		loadConsolidationTargets: async (...args) =>
			(await load()).loadConsolidationTargets(...args),
		consolidate: async (...args) => (await load()).consolidate(...args),
		stats: async (...args) => (await load()).stats(...args),
	};
}
