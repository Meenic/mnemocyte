import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { createMemory, type Embedder } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { CliArgs } from "../../src/cli/args.js";
import { chooseDirectUrl, type DirectTarget } from "../../src/cli/direct.js";
import { main } from "../../src/cli/main.js";
import { migrateTarget } from "../../src/cli/migrate.js";
import { textSearchTarget } from "../../src/cli/text-search.js";
import { readMemoryClientInternals } from "../../src/memory/client-internals.js";
import { createMnemocyteStoreConfig } from "../../src/memory/store-config.js";
import { resolveStore } from "../../src/memory/store-input.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import { pgliteExecutor } from "../../src/sql/pglite.js";
import { createTestIo } from "../cli/io.js";
import { expectMnemocyteError } from "../helpers.js";
import { openPGlite } from "./pglite.js";

const ALL_MIGRATIONS =
	"0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2, 0004_audit_memory_id";

const embedder: Embedder = {
	model: "cli-direct",
	dimensions: 8,
	async embed(texts) {
		return texts.map(() =>
			Array.from({ length: 8 }, (_, index) => (index === 0 ? 1 : 0)),
		);
	},
};

/** PGlite without `transaction`, as a stateless HTTP driver is. */
function batchOnly(db: PGlite): SqlExecutor {
	const inner = pgliteExecutor(db);
	return {
		query: (text, params, options) => inner.query(text, params, options),
		async batch(statements, options) {
			const transaction = inner.transaction?.bind(inner);
			if (transaction === undefined) {
				throw new Error("PGlite has transactions");
			}
			return transaction(async (tx) => {
				const results: Record<string, unknown>[][] = [];
				for (const statement of statements) {
					results.push(
						await tx.query(statement.sql, statement.params, options),
					);
				}
				return results;
			});
		},
	};
}

/** A function shaped like Neon's `neon()`; never called. */
function neonShaped(): unknown {
	return Object.assign(() => undefined, {
		query: () => undefined,
		transaction: () => undefined,
	});
}

function args(overrides: Partial<CliArgs> = {}): CliArgs {
	return {
		command: "migrate",
		yes: true,
		dryRun: false,
		json: false,
		...overrides,
	};
}

describe("directConnection on stores without interactive transactions", () => {
	function storeOf(store: unknown) {
		return readMemoryClientInternals(
			createMemory({ store: store as SqlExecutor, embedder }),
		).store;
	}

	test("Neon's neon() and Drizzle over it are neon, a batch-only executor postgres", () => {
		expect(storeOf(neonShaped()).directConnection).toBe("neon");
		expect(storeOf({ $client: neonShaped() }).directConnection).toBe("neon");
		expect(
			storeOf(postgresStore({ client: neonShaped() as SqlExecutor }))
				.directConnection,
		).toBe("neon");
		const executor: SqlExecutor = {
			query: async () => [],
			batch: async () => [],
		};
		expect(storeOf(executor).directConnection).toBe("postgres");
		expect(storeOf(postgresStore({ client: executor })).directConnection).toBe(
			"postgres",
		);
	});

	test("a client with transactions has none", () => {
		const executor: SqlExecutor = {
			query: async () => [],
			transaction: async (fn) => fn(executor),
		};
		expect(storeOf(executor).directConnection).toBeUndefined();
		expect(
			storeOf(postgresStore({ client: executor })).directConnection,
		).toBeUndefined();
	});
});

describe("chooseDirectUrl", () => {
	test("a Neon store prefers DATABASE_URL_UNPOOLED and falls back to DATABASE_URL", () => {
		expect(
			chooseDirectUrl("neon", {
				DATABASE_URL: "pooled",
				DATABASE_URL_UNPOOLED: "direct",
			}),
		).toEqual({ variable: "DATABASE_URL_UNPOOLED", url: "direct" });
		expect(
			chooseDirectUrl("neon", {
				DATABASE_URL: "pooled",
				DATABASE_URL_UNPOOLED: "",
			}),
		).toEqual({ variable: "DATABASE_URL", url: "pooled" });
		expect(chooseDirectUrl("neon", {})).toBeNull();
	});

	test("another store reads DATABASE_URL only", () => {
		expect(
			chooseDirectUrl("postgres", { DATABASE_URL_UNPOOLED: "direct" }),
		).toBeNull();
		expect(chooseDirectUrl("postgres", { DATABASE_URL: "url" })).toEqual({
			variable: "DATABASE_URL",
			url: "url",
		});
	});
});

/**
 * `migrate` and `text-search` over a direct target on PGlite: the app's
 * store is a batch-only executor over one database, and the CLI's own
 * connection is that database or, for the mismatch checks, another one.
 * Opening the connection on a URL is covered by the integration tests.
 */
describe("CLI over its own connection (PGlite)", () => {
	let app: PGlite;
	let other: PGlite;

	beforeEach(async () => {
		[app, other] = await Promise.all([
			openPGlite({ pgvector: true }),
			openPGlite({ pgvector: true }),
		]);
	});

	afterEach(async () => {
		await Promise.all([app.close(), other.close()]);
	});

	function appStore(schemaName?: string) {
		const memory = createMemory({
			store: postgresStore({
				client: batchOnly(app),
				...(schemaName === undefined ? {} : { schemaName }),
			}),
			embedder,
		});
		return readMemoryClientInternals(memory).store;
	}

	function direct(
		db: PGlite,
		options: { schemaName?: string; variable?: DirectTarget["variable"] } = {},
	): DirectTarget {
		const store = resolveStore(
			db,
			options.schemaName === undefined
				? {}
				: { schemaName: options.schemaName },
		);
		return {
			kind: "direct",
			label: "memory.ts",
			store,
			storeConfig: createMnemocyteStoreConfig(store),
			appStore: appStore(options.schemaName),
			embedder,
			connection: "neon",
			variable: options.variable ?? "DATABASE_URL_UNPOOLED",
			async close() {},
		};
	}

	test("migrate installs with the memory file's dimensions and names the variable", async () => {
		const io = createTestIo(".");
		expect(await migrateTarget(direct(app), args(), io)).toBe(0);
		expect(io.stderr()).toBe("");
		expect(io.stdout()).toBe(
			`Using memory.ts\nConnecting with Neon's Pool on DATABASE_URL_UNPOOLED: The store in memory.ts uses Neon's HTTP driver, which cannot run migrations: they need a transaction on one connection.\nApplied: ${ALL_MIGRATIONS}\n`,
		);
		const report = await appStore().inspectInstallation();
		expect(report?.column).toEqual({ dimensions: 8, vectorType: "vector" });
		expect(report?.migrations.state).toBe("tracked");
	});

	test("the fallback to DATABASE_URL says UNPOOLED is not set", async () => {
		const io = createTestIo(".");
		await migrateTarget(direct(app, { variable: "DATABASE_URL" }), args(), io);
		expect(io.stdout()).toContain(
			"Connecting with Neon's Pool on DATABASE_URL (DATABASE_URL_UNPOOLED is not set): ",
		);
	});

	test("the memory file's schemaName is where it installs", async () => {
		const target = direct(app, { schemaName: "memory" });
		const io = createTestIo(".");
		expect(await migrateTarget(target, args(), io)).toBe(0);
		expect(io.stdout()).toContain("Created the schema memory.");
		const report = await appStore("memory").inspectInstallation();
		expect(report?.schema).toBe("memory");
		expect(report?.migrations.state).toBe("tracked");
	});

	test("--dimensions that differs from the embedder fails before any change", async () => {
		await expectMnemocyteError(
			migrateTarget(direct(app), args({ dimensions: 16 }), createTestIo(".")),
			"CONFIG",
		);
		expect((await appStore().inspectInstallation())?.migrations.state).toBe(
			"none",
		);
	});

	test("--dry-run --json carries the variable as connection", async () => {
		const io = createTestIo(".");
		expect(
			await migrateTarget(direct(app), args({ dryRun: true, json: true }), io),
		).toBe(0);
		expect(JSON.parse(io.stdout())).toMatchObject({
			command: "migrate",
			target: "memory.ts",
			connection: "DATABASE_URL_UNPOOLED",
			applied: ALL_MIGRATIONS.split(", "),
		});
	});

	test("different installations stop it before anything changes, exit 2", async () => {
		await migrateTarget(direct(app), args(), createTestIo("."));
		const error = await migrateTarget(
			direct(other),
			args(),
			createTestIo("."),
		).catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			exitCode: 2,
			message: expect.stringContaining(
				"DATABASE_URL_UNPOOLED and the client in memory.ts see different installations, so they point at different databases. Nothing changed.",
			),
		});
		expect(
			(await resolveStore(other).inspectInstallation())?.migrations.state,
		).toBe("none");
	});

	test("two identical fresh databases pass the first read; the second one fails with exit 1", async () => {
		const io = createTestIo(".");
		expect(await migrateTarget(direct(other), args(), io)).toBe(1);
		expect(io.stdout()).toContain(`Applied: ${ALL_MIGRATIONS}`);
		expect(io.stderr()).toContain(
			"Migrated the database at DATABASE_URL_UNPOOLED, but the client in memory.ts does not see it, so they are different databases.",
		);
	});

	test("text-search changes the configuration and the app's client sees it", async () => {
		await migrateTarget(direct(app), args(), createTestIo("."));
		const plan = createTestIo(".");
		expect(
			await textSearchTarget(
				direct(app),
				args({
					command: "text-search",
					textSearchConfig: "simple",
					dryRun: true,
					json: true,
				}),
				plan,
			),
		).toBe(0);
		expect(JSON.parse(plan.stdout())).toMatchObject({
			command: "text-search",
			connection: "DATABASE_URL_UNPOOLED",
			previous: "english",
			current: "simple",
			changed: true,
		});

		const io = createTestIo(".");
		expect(
			await textSearchTarget(
				direct(app),
				args({ command: "text-search", textSearchConfig: "simple" }),
				io,
			),
		).toBe(0);
		expect(io.stderr()).toBe("");
		expect(io.stdout()).toContain(
			'Changed keyword search from "english" to "simple".',
		);
		expect((await appStore().inspectInstallation())?.textSearchConfig).toBe(
			"simple",
		);
	});
});

/**
 * `resolveTarget` through `main` with a memory file whose store is
 * batch-only. The file takes its client from `globalThis`, so it imports
 * nothing. No URL variable is set, so nothing connects.
 */
describe("CLI with a batch-only memory file and no URL", () => {
	let cwd: string;
	const saved = {
		DATABASE_URL: process.env.DATABASE_URL,
		DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
	};
	const key = "__mnemocyteCliDirectMemory";

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-direct-"));
		await writeFile(
			join(cwd, "memory.mjs"),
			`export const memory = globalThis.${key};\n`,
		);
		delete process.env.DATABASE_URL;
		delete process.env.DATABASE_URL_UNPOOLED;
	});

	afterEach(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		delete (globalThis as Record<string, unknown>)[key];
		await rm(cwd, { recursive: true, force: true });
	});

	function setMemory(store: unknown): void {
		(globalThis as Record<string, unknown>)[key] = createMemory({
			store: store as SqlExecutor,
			embedder,
		});
	}

	test("a Neon store names both variables, exit 2", async () => {
		setMemory(neonShaped());
		for (const command of ["migrate", "text-search"]) {
			const io = createTestIo(cwd);
			const argv =
				command === "migrate" ? ["migrate"] : ["text-search", "simple"];
			expect(await main(argv, io, "0.0.0-test")).toBe(2);
			expect(io.stderr()).toContain(
				"The store in memory.mjs uses Neon's HTTP driver, which cannot run migrations: they need a transaction on one connection. Set DATABASE_URL_UNPOOLED (or DATABASE_URL) to the same database's direct connection string, then run the command again.",
			);
		}
	});

	test("another batch-only store names DATABASE_URL, exit 2, also with --json", async () => {
		setMemory({ query: async () => [], batch: async () => [] });
		const io = createTestIo(cwd);
		expect(
			await main(["migrate", "--dry-run", "--json"], io, "0.0.0-test"),
		).toBe(2);
		expect(JSON.parse(io.stdout())).toMatchObject({
			command: "migrate",
			ok: false,
			error: {
				message: expect.stringContaining(
					"has no interactive transactions (SqlExecutor.transaction), which migrations need. Set DATABASE_URL to the same database's connection string",
				),
			},
		});
	});

	test("check reads through the memory file's client and opens nothing", async () => {
		const db = await openPGlite({ pgvector: true });
		try {
			setMemory(batchOnly(db));
			const io = createTestIo(cwd);
			// No tables yet: a problem (1), not a missing URL (2).
			expect(await main(["check"], io, "0.0.0-test")).toBe(1);
			expect(io.stdout()).toContain("Using memory.mjs");
		} finally {
			await db.close();
		}
	});
});
