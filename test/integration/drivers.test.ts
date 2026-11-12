import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";
import { describeStoreContract } from "../contract/suite.js";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const skip = !databaseUrl;

function postgresJsClient() {
	return postgres(databaseUrl ?? "", { max: 5, onnotice: () => {} });
}

function nodePostgresPool() {
	return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

describeStoreContract(
	"postgres.js",
	async () => {
		const sql = postgresJsClient();
		return { client: sql, close: () => sql.end() };
	},
	{ skip },
);

describeStoreContract(
	"node-postgres Pool",
	async () => {
		const pool = nodePostgresPool();
		return { client: pool, close: () => pool.end() };
	},
	{ skip },
);

describeStoreContract(
	"Drizzle over postgres.js",
	async () => {
		const sql = postgresJsClient();
		return {
			client: drizzlePostgresJs({ client: sql }),
			close: () => sql.end(),
		};
	},
	{ skip },
);

describeStoreContract(
	"Drizzle over a node-postgres Pool",
	async () => {
		const pool = nodePostgresPool();
		return {
			client: drizzleNodePostgres({ client: pool }),
			close: () => pool.end(),
		};
	},
	{ skip },
);
