import { createDatabase } from "./db/index.js";
import { createInMemoryClient } from "./memory/in-memory.js";
import { createPostgresClient } from "./memory/postgres.js";
import { assertEmbedder, assertNonEmptyString } from "./memory/shared.js";
import type { MnemocyteClient, MnemocyteConfig } from "./types.js";

export function createMnemocyte(config: MnemocyteConfig): MnemocyteClient {
	assertEmbedder(config.embedder);
	if (config.databaseUrl) {
		assertNonEmptyString(config.databaseUrl, "databaseUrl");
		return createPostgresClient(config, createDatabase(config.databaseUrl));
	}
	return createInMemoryClient(config);
}
