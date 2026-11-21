import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createMemory, type Embedder, migrate } from "mnemocyte";
import { libsqlStore } from "mnemocyte/libsql";
import { describe, expect, test, vi } from "vitest";
import {
	LIBSQL_INITIAL_MIGRATION_NAME,
	LIBSQL_MIGRATIONS,
	LIBSQL_SCHEMA_TEMPLATE,
} from "../../src/db/libsql/bundled.js";
import { renderLibsqlSchema } from "../../src/db/libsql/migrations.js";
import { ftsQuery, MAX_LEXICAL_TERMS } from "../../src/db/libsql/queries.js";
import {
	positionMillis,
	positionTimestamp,
	sqlUuidV7,
} from "../../src/db/libsql/sql.js";
import { LIBSQL_CAPABILITIES } from "../../src/memory/capabilities.js";
import { resolveStore } from "../../src/memory/store-input.js";
import { detectLibsqlClient } from "../../src/sql/detect.js";
import { expectMnemocyteError } from "../helpers.js";

const execFileAsync = promisify(execFile);

const embedder: Embedder = {
	model: "libsql-unit",
	dimensions: 2,
	async embed(texts) {
		return texts.map((text) => [text.length, 1]);
	},
};

/** The members detection reads, as on an `@libsql/client` `Client`. */
function fakeLibsqlClient(protocol = "file") {
	return {
		protocol,
		closed: false,
		execute: vi.fn(),
		batch: vi.fn(),
		transaction: vi.fn(),
		executeMultiple: vi.fn(),
		migrate: vi.fn(),
		sync: vi.fn(),
		close: vi.fn(),
	};
}

describe("ftsQuery", () => {
	test("quotes every term and joins them with OR", () => {
		expect(ftsQuery("green tea  morning")).toBe(
			'"green" OR "tea" OR "morning"',
		);
	});

	test("doubles double quotes, so operators and syntax stay words", () => {
		expect(ftsQuery('say "hi" NOT col:x NEAR( a* ^b')).toBe(
			'"say" OR """hi""" OR "NOT" OR "col:x" OR "NEAR(" OR "a*" OR "^b"',
		);
	});

	test("drops repeated terms and keeps the first 64", () => {
		expect(ftsQuery("tea tea TEA")).toBe('"tea" OR "TEA"');
		const many = Array.from({ length: 70 }, (_, index) => `w${index}`);
		expect(ftsQuery(many.join(" "))?.split(" OR ")).toHaveLength(
			MAX_LEXICAL_TERMS,
		);
	});

	test("is null for text with no terms", () => {
		expect(ftsQuery(" \t\n")).toBeNull();
	});
});

describe("libSQL client detection", () => {
	test("recognises a client and a Drizzle instance's $client", () => {
		const client = fakeLibsqlClient();
		expect(detectLibsqlClient(client)).toBe(client);
		expect(detectLibsqlClient({ $client: client })).toBe(client);
		for (const protocol of ["http", "ws"]) {
			expect(detectLibsqlClient(fakeLibsqlClient(protocol))).toBeDefined();
		}
	});

	test("ignores Postgres clients and incomplete shapes", () => {
		const executor = { query: vi.fn(), transaction: vi.fn() };
		expect(detectLibsqlClient(executor)).toBeUndefined();
		expect(detectLibsqlClient({ $client: executor })).toBeUndefined();
		const { protocol: _protocol, ...noProtocol } = fakeLibsqlClient();
		expect(detectLibsqlClient(noProtocol)).toBeUndefined();
		const { executeMultiple: _missing, ...noMultiple } = fakeLibsqlClient();
		expect(detectLibsqlClient(noMultiple)).toBeUndefined();
		expect(detectLibsqlClient(null)).toBeUndefined();
	});

	test("createMemory and resolveStore give a lazy libSQL store without calling the client", () => {
		const client = fakeLibsqlClient();
		const store = resolveStore(client);
		expect(store.backend).toBe("libsql");
		expect(store.capabilities).toEqual(LIBSQL_CAPABILITIES);
		createMemory({ store: client, embedder });
		createMemory({ store: libsqlStore({ client }), embedder });
		expect(client.execute).not.toHaveBeenCalled();
		expect(client.batch).not.toHaveBeenCalled();
	});

	test("a libSQL client passed to postgresStore names libsqlStore", async () => {
		const { postgresStore } = await import("mnemocyte/postgres");
		expect(() =>
			postgresStore({ client: { $client: fakeLibsqlClient() } as never }),
		).toThrow(/libsqlStore/);
	});

	test("migrate checks dimensions against the libSQL store's limit", async () => {
		const client = fakeLibsqlClient();
		await expectMnemocyteError(
			migrate({ store: client, dimensions: 65_537 }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			migrate({ store: client, dimensions: 0 }),
			"VALIDATION",
		);
		expect(client.execute).not.toHaveBeenCalled();
	});
});

describe("libSQL migrations", () => {
	test("are what the bundling script generates", async () => {
		const { stdout } = await execFileAsync("node", [
			"scripts/bundle-libsql-migrations.mjs",
			"--stdout",
		]);
		expect(await readFile("src/db/libsql/bundled.ts", "utf8")).toBe(stdout);
	});

	test("0000 is the template and nothing follows it yet", async () => {
		expect(LIBSQL_INITIAL_MIGRATION_NAME).toBe("0000_initial");
		expect(LIBSQL_MIGRATIONS).toEqual([]);
		const template = (
			await readFile("migrations/libsql/0000_initial.sql.template", "utf8")
		).replaceAll("\r\n", "\n");
		expect(LIBSQL_SCHEMA_TEMPLATE).toBe(template);
	});

	test("render the dimensions and the tokenizer", () => {
		const sql = renderLibsqlSchema(1536, "unicode61").join("\n");
		expect(sql).toContain('"embedding" F32_BLOB(1536)');
		expect(sql).toContain("tokenize='unicode61 remove_diacritics 2'");
		expect(sql).toContain("VALUES ('installation', 1536, 'F32_BLOB')");
		expect(sql).not.toContain("{{");
		expect(renderLibsqlSchema(3, "porter").join("\n")).toContain(
			"tokenize='porter unicode61 remove_diacritics 2'",
		);
	});
});

describe("libSQL values", () => {
	test("audit positions carry six fraction digits and round-trip", () => {
		const millis = Date.UTC(2026, 10, 14, 9, 30, 0, 123);
		expect(positionTimestamp(millis)).toBe("2026-11-14T09:30:00.123000Z");
		expect(positionMillis("2026-11-14T09:30:00.123000Z")).toBe(millis);
	});

	test("SQL-built ids embed the milliseconds and the version", () => {
		expect(sqlUuidV7("?1")).toContain("printf('%012x', ?1)");
		expect(sqlUuidV7("?1")).toContain("'-7'");
	});
});
