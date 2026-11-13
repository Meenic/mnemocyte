import { MnemocyteError } from "../errors.js";
import { detectClient, SUPPORTED_CLIENTS } from "../sql/detect.js";
import { createLazyStore } from "./lazy-store.js";
import type { MemoryStore } from "./store.js";
import {
	isMnemocyteStoreConfig,
	unwrapMnemocyteStoreConfig,
} from "./store-config.js";

/**
 * Resolve the `store` of `createMemory` or `migrate`: a store config from
 * `postgresStore()` or `drizzleStore()` first, then a database client
 * recognised by shape (ARCHITECTURE decisions 21 and 23).
 *
 * A client gets a lazy Postgres store whose backend is imported on its
 * first call; a dynamic `import()` keeps the backend out of the root entry,
 * where top-level `await` would break `require()`. Detection runs here, so
 * an unrecognised value still throws synchronously.
 *
 * @throws {MnemocyteError} `"CONFIG"` when `value` is neither.
 */
export function resolveStore(value: unknown): MemoryStore {
	if (isMnemocyteStoreConfig(value)) {
		return unwrapMnemocyteStoreConfig(value);
	}
	const detected = detectClient(value, "store");
	if (!detected) {
		throw new MnemocyteError(
			`store must come from postgresStore() or drizzleStore(), or be a database client: ${SUPPORTED_CLIENTS}.`,
			"CONFIG",
		);
	}
	return createLazyStore({
		backend: "postgres",
		load: async () =>
			(await import("./postgres-backend.js")).createClientStore(detected),
	});
}
