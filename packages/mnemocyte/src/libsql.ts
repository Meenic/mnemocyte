import { createLibsqlExecutor } from "./db/libsql/executor.js";
import { MnemocyteError } from "./errors.js";
import { createLibsqlStore } from "./memory/libsql.js";
import { createMnemocyteStoreConfig } from "./memory/store-config.js";
import { assertKnownKeys } from "./options.js";
import { detectLibsqlClient, type LibsqlClient } from "./sql/detect.js";
import type { MnemocyteStoreConfig } from "./types.js";

export type { LibsqlClient, LibsqlDriverClient } from "./sql/detect.js";

/** Options for {@link libsqlStore}. */
export interface LibsqlStoreOptions {
	/**
	 * The caller-owned libSQL client: an `@libsql/client` `Client` from any
	 * of its entry points and URLs (`file:`, `libsql:`, `http:`, `ws:`), or a
	 * Drizzle instance over one (`drizzle-orm/libsql`).
	 */
	client: LibsqlClient;
}

/**
 * Create a libSQL / Turso storage adapter for {@link MemoryConfig.store}.
 *
 * The client is recognised by its shape (`execute`, `batch`,
 * `transaction`, `executeMultiple` and `protocol`, or a Drizzle instance's
 * `$client`), without importing `@libsql/client`. The tables must already
 * exist, through `migrate()` or `mnemocyte migrate`. Vector search is an
 * exact cosine scan of the scope's memories; keyword search uses FTS5 and
 * `bm25`. Mnemocyte never closes `client`.
 *
 * `createMemory({ store: client })` takes the client directly too; this
 * function is for code that builds the store apart from the client.
 *
 * @example
 * ```ts
 * import { createClient } from "@libsql/client";
 * import { libsqlStore } from "mnemocyte/libsql";
 *
 * const client = createClient({ url: "file:memory.db" });
 * const store = libsqlStore({ client });
 * ```
 *
 * @throws {MnemocyteError} `"CONFIG"` when `client` is not a libSQL client.
 */
export function libsqlStore(options: LibsqlStoreOptions): MnemocyteStoreConfig {
	assertKnownKeys("libsqlStore", options, ["client"]);
	const client = detectLibsqlClient(options.client);
	if (client === undefined) {
		throw new MnemocyteError({
			message:
				"client must be an @libsql/client Client or a Drizzle instance over one (drizzle-orm/libsql).",
			code: "CONFIG",
			reason: "INVALID_OPTION",
		});
	}
	return createMnemocyteStoreConfig(
		createLibsqlStore(createLibsqlExecutor(client)),
	);
}
