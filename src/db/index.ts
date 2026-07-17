import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { MnemocyteError } from "../errors.js";
import * as schema from "./schema.js";

export type MnemocyteDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
	db: MnemocyteDatabase;
	close(): Promise<void>;
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
	let url: URL;
	try {
		url = new URL(databaseUrl);
	} catch (error) {
		throw new MnemocyteError(
			"databaseUrl must be a valid Postgres connection URL.",
			"CONFIG",
			error,
		);
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new MnemocyteError(
			"databaseUrl must use the postgres: or postgresql: protocol.",
			"CONFIG",
		);
	}
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
