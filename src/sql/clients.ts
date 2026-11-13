import type { Sql } from "postgres";
import { MnemocyteError } from "../errors.js";
import {
	type DetectedClient,
	detectClient,
	SUPPORTED_CLIENTS,
} from "./detect.js";
import type { SqlExecutor } from "./executor.js";
import { nodePostgresExecutor } from "./node-postgres.js";
import { pgliteExecutor } from "./pglite.js";
import { postgresJs } from "./postgres-js.js";

export type {
	DrizzleClient,
	PostgresClient,
	PostgresJsClient,
} from "./detect.js";

/** Wrap a recognised client in its adapter. */
export function executorFor(detected: DetectedClient): SqlExecutor {
	switch (detected.driver) {
		case "postgres-js":
			// Matched by shape; postgresJs only calls unsafe, begin and
			// savepoint.
			return postgresJs(detected.client as Sql);
		case "pglite":
			return pgliteExecutor(detected.client);
		case "node-postgres":
			return nodePostgresExecutor(detected.client);
		case "executor":
			return detected.client;
	}
}

/**
 * Turn any supported client into a {@link SqlExecutor}, with the checks of
 * {@link detectClient}.
 *
 * @throws {MnemocyteError} `"CONFIG"` for anything else, including a
 * node-postgres `Client`.
 */
export function toSqlExecutor(client: unknown): SqlExecutor {
	const detected = detectClient(client, "client");
	if (!detected) {
		throw new MnemocyteError(`client must be ${SUPPORTED_CLIENTS}.`, "CONFIG");
	}
	return executorFor(detected);
}
