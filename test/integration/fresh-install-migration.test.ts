import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";
import { describe, expect, test } from "vitest";

const envPath = resolve(".env");
if (!process.env.DATABASE_URL && existsSync(envPath)) {
	process.loadEnvFile(envPath);
}

const databaseUrl = process.env.DATABASE_URL;
const sequentialMigrations = [
	"0000_initial.sql",
	"0001_add_mnemocyte_meta.sql",
	"0002_add_embedding_model.sql",
] as const;

interface TableDefinition {
	tableName: string;
}

interface ColumnDefinition {
	tableName: string;
	position: number;
	columnName: string;
	dataType: string;
	notNull: boolean;
	defaultExpression: string | null;
}

interface ConstraintDefinition {
	tableName: string;
	constraintName: string;
	constraintType: string;
	definition: string;
}

interface IndexDefinition {
	tableName: string;
	indexName: string;
	definition: string;
}

interface InstallationMetadata {
	key: string;
	embeddingDimensions: number;
	embeddingModel: string | null;
}

async function readSchemaSnapshot(sql: ReturnType<typeof postgres>) {
	const tables = await sql<TableDefinition[]>`
		SELECT class.relname AS "tableName"
		FROM pg_catalog.pg_class AS class
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = class.relnamespace
		WHERE namespace.nspname = 'public'
			AND class.relkind = 'r'
			AND class.relname LIKE 'mnemocyte\_%' ESCAPE '\'
		ORDER BY class.relname
	`;
	const columns = await sql<ColumnDefinition[]>`
		SELECT
			class.relname AS "tableName",
			attribute.attnum AS "position",
			attribute.attname AS "columnName",
			pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS "dataType",
			attribute.attnotnull AS "notNull",
			pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS "defaultExpression"
		FROM pg_catalog.pg_attribute AS attribute
		JOIN pg_catalog.pg_class AS class
			ON class.oid = attribute.attrelid
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = class.relnamespace
		LEFT JOIN pg_catalog.pg_attrdef AS default_value
			ON default_value.adrelid = attribute.attrelid
			AND default_value.adnum = attribute.attnum
		WHERE namespace.nspname = 'public'
			AND class.relname LIKE 'mnemocyte\_%' ESCAPE '\'
			AND class.relkind = 'r'
			AND attribute.attnum > 0
			AND NOT attribute.attisdropped
		ORDER BY class.relname, attribute.attnum
	`;
	const constraints = await sql<ConstraintDefinition[]>`
		SELECT
			class.relname AS "tableName",
			constraint_definition.conname AS "constraintName",
			constraint_definition.contype::text AS "constraintType",
			pg_catalog.pg_get_constraintdef(constraint_definition.oid, true) AS "definition"
		FROM pg_catalog.pg_constraint AS constraint_definition
		JOIN pg_catalog.pg_class AS class
			ON class.oid = constraint_definition.conrelid
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = class.relnamespace
		WHERE namespace.nspname = 'public'
			AND class.relname LIKE 'mnemocyte\_%' ESCAPE '\'
		ORDER BY class.relname, constraint_definition.conname
	`;
	const indexes = await sql<IndexDefinition[]>`
		SELECT
			table_class.relname AS "tableName",
			index_class.relname AS "indexName",
			pg_catalog.pg_get_indexdef(index_definition.indexrelid) AS "definition"
		FROM pg_catalog.pg_index AS index_definition
		JOIN pg_catalog.pg_class AS table_class
			ON table_class.oid = index_definition.indrelid
		JOIN pg_catalog.pg_class AS index_class
			ON index_class.oid = index_definition.indexrelid
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = table_class.relnamespace
		WHERE namespace.nspname = 'public'
			AND table_class.relname LIKE 'mnemocyte\_%' ESCAPE '\'
		ORDER BY table_class.relname, index_class.relname
	`;
	const metadata = await sql<InstallationMetadata[]>`
		SELECT
			"key",
			"embedding_dimensions" AS "embeddingDimensions",
			"embedding_model" AS "embeddingModel"
		FROM "mnemocyte_meta"
		ORDER BY "key"
	`;

	return {
		tables: tables.map((table) => ({ ...table })),
		columns: columns.map((column) => ({ ...column })),
		constraints: constraints.map((constraint) => ({ ...constraint })),
		indexes: indexes.map((index) => ({ ...index })),
		metadata: metadata.map((entry) => ({ ...entry })),
	};
}

async function snapshotCleanInstall(
	sql: ReturnType<typeof postgres>,
	migrationFiles: readonly string[],
) {
	await sql.unsafe("BEGIN");
	try {
		await sql.unsafe(
			'DROP TABLE IF EXISTS "mnemocyte_events", "mnemocyte_memories", "mnemocyte_meta" CASCADE',
		);
		for (const file of migrationFiles) {
			await sql.unsafe(await readFile(resolve("migrations", file), "utf8"));
		}
		return await readSchemaSnapshot(sql);
	} finally {
		await sql.unsafe("ROLLBACK");
	}
}

describe("default fresh-install migration", () => {
	test.skipIf(!databaseUrl)(
		"matches the sequential migrations on an equally clean database",
		async () => {
			const sql = postgres(databaseUrl ?? "", { max: 1 });

			try {
				await sql`CREATE EXTENSION IF NOT EXISTS vector`;
				const sequential = await snapshotCleanInstall(
					sql,
					sequentialMigrations,
				);
				const consolidated = await snapshotCleanInstall(sql, [
					"fresh-install.sql",
				]);

				expect(consolidated.tables).toEqual([
					{ tableName: "mnemocyte_events" },
					{ tableName: "mnemocyte_memories" },
					{ tableName: "mnemocyte_meta" },
				]);
				expect(consolidated.metadata).toEqual([
					{
						key: "installation",
						embeddingDimensions: 1536,
						embeddingModel: null,
					},
				]);
				expect(consolidated).toEqual(sequential);
			} finally {
				await sql.end();
			}
		},
		60_000,
	);
});
