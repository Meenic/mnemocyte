import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { parsePostgresDatabaseUrl } from "../database-url.js";
import * as schema from "./schema.js";

export type MnemocyteDatabase = PostgresJsDatabase<Record<string, unknown>>;

export interface DatabaseHandle {
	db: MnemocyteDatabase;
	close(): Promise<void>;
}

export function createCallerOwnedDatabaseHandle<
	TSchema extends Record<string, unknown>,
>(db: PostgresJsDatabase<TSchema>): DatabaseHandle {
	return {
		db,
		async close() {},
	};
}

type PostgresSslMode =
	| "require"
	| "prefer"
	| "allow"
	| "verify-full"
	| "disable";

type ValidPostgresSsl =
	| "require"
	| "prefer"
	| "allow"
	| "verify-full"
	| boolean
	| { rejectUnauthorized: false };

function parseSslFromUrl(url: URL): ValidPostgresSsl | undefined {
	const mode = url.searchParams.get("sslmode") as PostgresSslMode | null;
	if (!mode || mode === "disable") return undefined;

	if (mode === "require" || mode === "prefer" || mode === "allow") {
		return { rejectUnauthorized: false };
	}

	if (mode === "verify-full") return "verify-full";

	return undefined;
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
	const url = parsePostgresDatabaseUrl(databaseUrl);
	const ssl = parseSslFromUrl(url);

	const isPooler =
		url.port === "6543" || url.searchParams.get("pgbouncer") === "true";

	const client = postgres(databaseUrl, {
		max: 10,
		idle_timeout: 20,
		connect_timeout: 10,
		...(ssl ? { ssl } : {}),
		...(isPooler ? { prepare: false } : {}),
	});

	return {
		db: drizzle(client, { schema }),
		async close() {
			await client.end();
		},
	};
}
