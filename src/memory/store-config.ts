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

function hasEnvelope(value: unknown): value is MemoryStoreConfigEnvelope {
	return (
		typeof value === "object" && value !== null && MEMORY_STORE_CONFIG in value
	);
}

/**
 * True for a value from `createMnemocyteStoreConfig`, from any copy of the
 * package (the key is a `Symbol.for`).
 */
export function isMnemocyteStoreConfig(
	value: unknown,
): value is MnemocyteStoreConfig {
	return hasEnvelope(value);
}

export function unwrapMnemocyteStoreConfig(
	config: MnemocyteStoreConfig,
): MemoryStore {
	const candidate: unknown = config;
	if (!hasEnvelope(candidate)) {
		throw new MnemocyteError(
			"store must be created by a supported Mnemocyte store adapter.",
			"CONFIG",
		);
	}

	return candidate[MEMORY_STORE_CONFIG];
}
