import { MnemocyteError } from "../errors.js";
import type { Embedder } from "../types.js";
import type { MemoryStore } from "./store.js";

// `Symbol.for`, so a client from one copy of the package still works with
// `migrate` from another, as with the store config envelope.
const MEMORY_CLIENT_INTERNALS = Symbol.for("mnemocyte.memory-client");

/** What `migrate({ memory })` reads from a client. */
export interface MemoryClientInternals {
	readonly store: MemoryStore;
	readonly embedder: Embedder;
}

/**
 * Attach the client's store and embedder under a non-enumerable symbol key,
 * so they stay out of `Object.keys`, spreads and `JSON.stringify`.
 */
export function attachMemoryClientInternals<Client extends object>(
	client: Client,
	internals: MemoryClientInternals,
): Client {
	Object.defineProperty(client, MEMORY_CLIENT_INTERNALS, {
		value: Object.freeze({ ...internals }),
		enumerable: false,
		writable: false,
		configurable: false,
	});
	return client;
}

export function readMemoryClientInternals(
	client: unknown,
): MemoryClientInternals {
	const candidate = client;
	if (
		typeof candidate !== "object" ||
		candidate === null ||
		!(MEMORY_CLIENT_INTERNALS in candidate)
	) {
		throw new MnemocyteError(
			"memory must be a client from createMemory() or memory.for().",
			"CONFIG",
		);
	}
	return (candidate as Record<typeof MEMORY_CLIENT_INTERNALS, unknown>)[
		MEMORY_CLIENT_INTERNALS
	] as MemoryClientInternals;
}
