import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type MnemocyteDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseHandle {
	db: MnemocyteDatabase;
	close(): Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
	const client = postgres(databaseUrl, {
		max: 10,
		idle_timeout: 20,
		connect_timeout: 10,
	});

	return {
		db: drizzle(client, { schema }),
		async close() {
			await client.end();
		},
	};
}
