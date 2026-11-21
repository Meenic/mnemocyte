import { MnemocyteError } from "../errors.js";
import type { MnemocyteStoreConfig } from "../types.js";
import type { MemoryStore } from "./store.js";
import type { MemoryStoreV1 } from "./store-v1.js";
import { fromMemoryStoreV1 } from "./store-v1-adapter.js";

/** A first-party store: this copy's internal {@link MemoryStore}. */
const MEMORY_STORE_CONFIG = Symbol.for("mnemocyte.memory-store-config");
/**
 * A public {@link MemoryStoreV1} from `defineMemoryStore`. A key of its own,
 * so a copy of the package built before the public contract does not take it
 * for an internal store and fails with its usual `"CONFIG"` instead.
 */
const MEMORY_STORE_V1_CONFIG = Symbol.for("mnemocyte.memory-store-v1-config");

interface MemoryStoreConfigEnvelope {
	readonly [MEMORY_STORE_CONFIG]: MemoryStore;
}

interface MemoryStoreV1ConfigEnvelope {
	readonly [MEMORY_STORE_V1_CONFIG]: MemoryStoreV1;
}

export function createMnemocyteStoreConfig(
	store: MemoryStore,
): MnemocyteStoreConfig {
	return Object.freeze({
		[MEMORY_STORE_CONFIG]: store,
	}) as unknown as MnemocyteStoreConfig;
}

/**
 * The config for a public store. It carries the store itself, not an
 * adapted one, so the copy of the package that resolves it adapts it with
 * its own {@link fromMemoryStoreV1}.
 */
export function createMemoryStoreV1Config(
	store: MemoryStoreV1,
): MnemocyteStoreConfig {
	return Object.freeze({
		[MEMORY_STORE_V1_CONFIG]: store,
	}) as unknown as MnemocyteStoreConfig;
}

function hasEnvelope(value: unknown): value is MemoryStoreConfigEnvelope {
	return (
		typeof value === "object" && value !== null && MEMORY_STORE_CONFIG in value
	);
}

function hasV1Envelope(value: unknown): value is MemoryStoreV1ConfigEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		MEMORY_STORE_V1_CONFIG in value
	);
}

/**
 * True for a value from `createMnemocyteStoreConfig` or
 * `createMemoryStoreV1Config`, from any copy of the package (the keys are
 * `Symbol.for`s).
 */
export function isMnemocyteStoreConfig(
	value: unknown,
): value is MnemocyteStoreConfig {
	return hasEnvelope(value) || hasV1Envelope(value);
}

/**
 * The store a config holds; a public store is checked and adapted here.
 *
 * @throws {MnemocyteError} `"CONFIG"` for a value that is no store config,
 * or a public store this copy does not accept.
 */
export function unwrapMnemocyteStoreConfig(
	config: MnemocyteStoreConfig,
): MemoryStore {
	const candidate: unknown = config;
	if (hasV1Envelope(candidate)) {
		return fromMemoryStoreV1(candidate[MEMORY_STORE_V1_CONFIG]);
	}
	if (!hasEnvelope(candidate)) {
		throw new MnemocyteError({
			message: "store must be created by a supported Mnemocyte store adapter.",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}

	return candidate[MEMORY_STORE_CONFIG];
}
