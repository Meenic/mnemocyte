import { MnemocyteError } from "../errors.js";
import type { MnemocyteStoreConfig } from "../types.js";
import type { MemoryStore } from "./store.js";

const MEMORY_STORE_CONFIG = Symbol.for("mnemocyte.memory-store-config");

interface MemoryStoreConfigEnvelope {
	readonly [MEMORY_STORE_CONFIG]: MemoryStore;
}

export function createMnemocyteStoreConfig(
	store: MemoryStore,
): MnemocyteStoreConfig {
	return Object.freeze({
		[MEMORY_STORE_CONFIG]: store,
	}) as unknown as MnemocyteStoreConfig;
}

export function unwrapMnemocyteStoreConfig(
	config: MnemocyteStoreConfig,
): MemoryStore {
	const candidate: unknown = config;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		!(MEMORY_STORE_CONFIG in candidate)
	) {
		throw new MnemocyteError(
			"store must be created by a supported Mnemocyte store adapter.",
			"CONFIG",
		);
	}

	return (candidate as MemoryStoreConfigEnvelope)[MEMORY_STORE_CONFIG];
}
