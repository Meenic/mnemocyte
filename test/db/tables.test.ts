import { describe, expect, test } from "vitest";
import { MIGRATIONS } from "../../src/db/migrations/bundled.js";
import {
	qualifySelfReference,
	renderInitialSchema,
} from "../../src/db/migrations/runner.js";
import {
	assertSchemaName,
	DEFAULT_TABLES,
	postgresTables,
	quoteIdentifier,
	regclass,
} from "../../src/db/tables.js";
import { changeTextSearchStatements } from "../../src/db/text-search.js";
import { expectMnemocyteError } from "../helpers.js";

describe("table names", () => {
	test("are bare without a schema, as before schemaName", () => {
		expect(DEFAULT_TABLES).toEqual({
			schema: null,
			memories: "mnemocyte_memories",
			events: "mnemocyte_events",
			meta: "mnemocyte_meta",
			migrations: "mnemocyte_migrations",
		});
		expect(regclass(DEFAULT_TABLES.memories)).toBe(
			"to_regclass('mnemocyte_memories')",
		);
	});

	test("are qualified with the quoted schema", () => {
		expect(postgresTables("user")).toEqual({
			schema: "user",
			memories: '"user".mnemocyte_memories',
			events: '"user".mnemocyte_events',
			meta: '"user".mnemocyte_meta',
			migrations: '"user".mnemocyte_migrations',
		});
		expect(regclass(postgresTables("memory").events)).toBe(
			`to_regclass('"memory".mnemocyte_events')`,
		);
	});

	test("quoteIdentifier doubles double quotes", () => {
		expect(quoteIdentifier("memory")).toBe('"memory"');
		expect(quoteIdentifier('a"b')).toBe('"a""b"');
	});
});

describe("assertSchemaName", () => {
	test.each([
		["memory"],
		["_private"],
		["tenant_42"],
		["user"],
		["a".repeat(63)],
	])("accepts %j", (name) => {
		expect(() => assertSchemaName(name, "schemaName")).not.toThrow();
	});

	test.each([
		[42, "must be a string"],
		["", "lower case letters"],
		["Memory", "lower case letters"],
		["9lives", "lower case letters"],
		["my-schema", "lower case letters"],
		["my schema", "lower case letters"],
		['a"b', "lower case letters"],
		["a".repeat(64), "at most 63 characters"],
		["pg_memory", "must not start with pg_"],
	])("rejects %j", async (name, message) => {
		const error = await expectMnemocyteError(
			Promise.resolve().then(() => assertSchemaName(name, "schemaName")),
			"CONFIG",
			"INVALID_OPTION",
		);
		expect(error.message).toContain("schemaName");
		expect(error.message).toContain(message);
	});
});

describe("SQL for a named schema", () => {
	const SELF_REFERENCE = '"public"."mnemocyte_memories"';

	test("only 0000 and 0003 name public, once each, in the self foreign key", () => {
		expect(
			MIGRATIONS.map((migration) => migration.sql.split("public").length - 1),
		).toEqual([1, 0, 0, 1, 0]);
		for (const migration of MIGRATIONS) {
			expect(qualifySelfReference(migration.sql, null)).toBe(migration.sql);
			expect(qualifySelfReference(migration.sql, "memory")).toBe(
				migration.sql.replaceAll(
					SELF_REFERENCE,
					'"memory"."mnemocyte_memories"',
				),
			);
		}
	});

	test("the fresh install differs only in the foreign key's target", () => {
		const plain = renderInitialSchema(1536);
		const named = renderInitialSchema(1536, "english", "memory");
		expect(plain).toContain(SELF_REFERENCE);
		expect(named).not.toContain("public");
		expect(named).toBe(
			plain.replace(SELF_REFERENCE, '"memory"."mnemocyte_memories"'),
		);
		expect(renderInitialSchema(1536, "english", null)).toBe(plain);
	});

	test("the text search change names the schema's table", () => {
		const tables = postgresTables("memory");
		expect(changeTextSearchStatements("simple", 170000, tables)).toEqual([
			`ALTER TABLE "memory".mnemocyte_memories ALTER COLUMN "content_tsv" SET EXPRESSION AS (to_tsvector('simple'::regconfig, "content"))`,
			`ANALYZE "memory".mnemocyte_memories ("content_tsv")`,
		]);
		expect(changeTextSearchStatements("simple", 160000, tables)).toEqual([
			`ALTER TABLE "memory".mnemocyte_memories DROP COLUMN "content_tsv", ADD COLUMN "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, "content")) STORED`,
			`CREATE INDEX "mnemocyte_memories_content_tsv_idx" ON "memory".mnemocyte_memories USING gin ("content_tsv")`,
			`ANALYZE "memory".mnemocyte_memories ("content_tsv")`,
		]);
	});
});
