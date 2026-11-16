import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePostgresJs } from "drizzle-orm/postgres-js";
import pg from "pg";
import postgres from "postgres";
import {
	renderInitialSchema,
	splitStatements,
} from "../../src/db/migrations/runner.js";
import {
	CONTRACT_DIMENSIONS,
	describeStoreContract,
} from "../contract/suite.js";

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

const CONTRACT_SCHEMA = "mnemocyte_contract";

// The tables in a schema off search_path: every query must name it. Public
// already holds the other files' installation, which migrate() refuses to
// install next to, so the schema is created from the printed SQL first and
// migrate() adopts it.
describeStoreContract(
	"postgres.js, tables in a schema",
	async () => {
		const sql = postgresJsClient();
		await sql.begin(async (tx) => {
			await tx.unsafe(`DROP SCHEMA IF EXISTS ${CONTRACT_SCHEMA} CASCADE`);
			await tx.unsafe(`CREATE SCHEMA ${CONTRACT_SCHEMA}`);
			await tx.unsafe(`SET LOCAL search_path TO ${CONTRACT_SCHEMA}, public`);
			for (const statement of splitStatements(
				renderInitialSchema(CONTRACT_DIMENSIONS, "english", CONTRACT_SCHEMA),
			)) {
				await tx.unsafe(statement);
			}
		});
		return {
			client: sql,
			async close() {
				await sql.unsafe(`DROP SCHEMA IF EXISTS ${CONTRACT_SCHEMA} CASCADE`);
				await sql.end();
			},
		};
	},
	{ skip, schemaName: CONTRACT_SCHEMA },
);
