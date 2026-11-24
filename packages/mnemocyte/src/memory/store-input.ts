import { MnemocyteError } from "../errors.js";
import {
	detectClient,
	detectLibsqlClient,
	directConnectionFor,
	SUPPORTED_CLIENTS,
} from "../sql/detect.js";
import { LIBSQL_CAPABILITIES, POSTGRES_CAPABILITIES } from "./capabilities.js";
import { createLazyStore } from "./lazy-store.js";
import type { PostgresStoreSettings } from "./postgres.js";
import type { MemoryStore } from "./store.js";
import {
	isMnemocyteStoreConfig,
	unwrapMnemocyteStoreConfig,
} from "./store-config.js";

/**
 * Resolve the `store` of `createMemory` or `migrate`: a store config from
 * `postgresStore()` or `libsqlStore()` first, then a libSQL client (or a
 * Drizzle instance over one), then a Postgres client, each recognised by
 * shape (ARCHITECTURE decisions 21 and 23).
 *
 * A client gets a lazy store whose backend is imported on its first call;
 * a dynamic `import()` keeps the backend out of the root entry, where
 * top-level `await` would break `require()`. Detection runs here, so
 * an unrecognised value still throws synchronously.
 *
 * `settings` apply to a Postgres client only; the CLI passes its `--schema`
 * there, and rejects it for libSQL before calling this.
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
	const libsql = detectLibsqlClient(value);
	if (libsql !== undefined) {
		return createLazyStore({
			backend: "libsql",
			capabilities: LIBSQL_CAPABILITIES,
			load: async () =>
				(await import("./libsql-backend.js")).createLibsqlClientStore(libsql),
		});
	}
	const detected = detectClient(value, "store");
	if (!detected) {
		throw new MnemocyteError({
			message: `store must come from postgresStore() or libsqlStore(), or be a database client: ${SUPPORTED_CLIENTS}, or an @libsql/client Client (or a Drizzle instance over one).`,
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
	const directConnection = directConnectionFor(detected);
	return createLazyStore({
		backend: "postgres",
		capabilities: POSTGRES_CAPABILITIES,
		...(settings.schemaName === undefined
			? {}
			: { schemaName: settings.schemaName }),
		...(directConnection === undefined ? {} : { directConnection }),
		load: async () =>
			(await import("./postgres-backend.js")).createClientStore(
				detected,
				settings,
			),
	});
}

/**
 * Throws `"CONFIG"` for a store whose methods are not this package's
 * {@link MemoryStore}: one from another installed copy of the package,
 * built before the contract last changed. `migrate` and the CLI use only
 * methods that kept their shape, so they skip this check.
 */
export function assertStoreContract(store: MemoryStore): void {
	const candidate: Partial<MemoryStore> = store;
	if (
		typeof candidate.capabilities !== "object" ||
		typeof candidate.searchCandidates !== "function"
	) {
		throw new MnemocyteError({
			message:
				"store comes from another copy of mnemocyte with a different store contract. Install a single version of mnemocyte (npm ls mnemocyte lists them).",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
}
