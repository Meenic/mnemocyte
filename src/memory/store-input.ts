import { MnemocyteError } from "../errors.js";
import { detectClient, SUPPORTED_CLIENTS } from "../sql/detect.js";
import { createLazyStore } from "./lazy-store.js";
import type { PostgresStoreSettings } from "./postgres.js";
import type { MemoryStore } from "./store.js";
import {
	isMnemocyteStoreConfig,
	unwrapMnemocyteStoreConfig,
} from "./store-config.js";

/**
 * Resolve the `store` of `createMemory` or `migrate`: a store config from
 * `postgresStore()` first, then a database client
 * recognised by shape (ARCHITECTURE decisions 21 and 23).
 *
 * A client gets a lazy Postgres store whose backend is imported on its
 * first call; a dynamic `import()` keeps the backend out of the root entry,
 * where top-level `await` would break `require()`. Detection runs here, so
 * an unrecognised value still throws synchronously.
 *
 * `settings` apply to a client only; the CLI passes its `--schema` there.
 *
 * @throws {MnemocyteError} `"CONFIG"` when `value` is neither.
 */
export function resolveStore(
	value: unknown,
	settings: PostgresStoreSettings = {},
): MemoryStore {
	if (isMnemocyteStoreConfig(value)) {
		return unwrapMnemocyteStoreConfig(value);
	}
	const detected = detectClient(value, "store");
	if (!detected) {
		throw new MnemocyteError({
			message: `store must come from postgresStore() or be a database client: ${SUPPORTED_CLIENTS}.`,
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
	return createLazyStore({
		backend: "postgres",
		...(settings.schemaName === undefined
			? {}
			: { schemaName: settings.schemaName }),
		load: async () =>
			(await import("./postgres-backend.js")).createClientStore(
				detected,
				settings,
			),
	});
}
