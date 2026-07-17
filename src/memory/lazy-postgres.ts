import type { MemoryStore } from "./store.js";

export function createLazyPostgresStore(databaseUrl: string): MemoryStore {
	let storePromise: Promise<MemoryStore> | undefined;

	function loadStore(): Promise<MemoryStore> {
		storePromise ??= import("./postgres-runtime.js").then(
			({ createPostgresStoreFromUrl }) =>
				createPostgresStoreFromUrl(databaseUrl),
		);
		return storePromise;
	}

	return {
		backend: "postgres",
		async ensureSchema() {
			return (await loadStore()).ensureSchema();
		},
		async ensureEmbeddingCompatibility(embedder) {
			return (await loadStore()).ensureEmbeddingCompatibility(embedder);
		},
		async insertMemories(memories) {
			return (await loadStore()).insertMemories(memories);
		},
		async vectorSearch(input) {
			return (await loadStore()).vectorSearch(input);
		},
		async lexicalSearch(input) {
			return (await loadStore()).lexicalSearch(input);
		},
		async getMemoryEmbeddings(memoryIds) {
			return (await loadStore()).getMemoryEmbeddings(memoryIds);
		},
		async markMemoriesAccessed(memoryIds) {
			return (await loadStore()).markMemoriesAccessed(memoryIds);
		},
		async deleteMemory(entityId, memoryId) {
			return (await loadStore()).deleteMemory(entityId, memoryId);
		},
		async deleteMemoriesForEntity(entityId) {
			return (await loadStore()).deleteMemoriesForEntity(entityId);
		},
		async prune(input, options) {
			return (await loadStore()).prune(input, options);
		},
		async findDuplicatePairs(input, options) {
			return (await loadStore()).findDuplicatePairs(input, options);
		},
		async addAuditEvents(events) {
			return (await loadStore()).addAuditEvents(events);
		},
		async listAuditLog(input, options) {
			return (await loadStore()).listAuditLog(input, options);
		},
		async getMemory(entityId, memoryId, options) {
			return (await loadStore()).getMemory(entityId, memoryId, options);
		},
		async loadConsolidationTargets(entityId, ids, options) {
			return (await loadStore()).loadConsolidationTargets(
				entityId,
				ids,
				options,
			);
		},
		async consolidate(input, options) {
			return (await loadStore()).consolidate(input, options);
		},
		async stats(input, now) {
			return (await loadStore()).stats(input, now);
		},
		async close() {
			return (await loadStore()).close();
		},
	};
}
