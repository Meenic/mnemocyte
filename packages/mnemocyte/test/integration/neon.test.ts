import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { createMemory, migrate, setTextSearchConfig } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { main } from "../../src/cli/main.js";
import { inspectPostgresInstallation } from "../../src/db/migrations/inspect.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import {
	createContractEmbedder,
	uniqueNamespace,
} from "../../src/store-test/contract.js";
import { createTestIo, type TestIo } from "../cli/io.js";
import {
	CONTRACT_DIMENSIONS,
	type ContractTarget,
	describeStoreContract,
} from "../contract/suite.js";
import { expectMnemocyteError } from "../helpers.js";

/**
 * The Postgres contract over Neon's serverless driver: the `neon()` HTTP
 * function and the WebSocket `Pool`, which Mnemocyte detects as a
 * node-postgres pool. `neon()` has no interactive transactions, so its
 * suite migrates through a `Pool` on the same database. Drizzle over
 * `neon()` (`drizzle-orm/neon-http`) gets a smoke test only: Mnemocyte runs
 * on its `$client`, the same function through the same adapter, so a
 * second full run over HTTP would repeat the first.
 *
 * Reads only variables set explicitly, never `.env`:
 *
 * - `NEON_DATABASE_URL`: the connection string. Skipped without it.
 * - `NEON_FETCH_ENDPOINT`: the HTTP endpoint, such as
 *   `http://db.localtest.me:4444/sql` for the local Neon proxy
 *   (`ghcr.io/timowilhelm/local-neon-http-proxy`). Omitted for Neon itself.
 * - `NEON_WS_PROXY`: the WebSocket proxy, such as `db.localtest.me:4444/v2`
 *   for the local proxy, which speaks plain `ws:`. Omitted for Neon itself.
 *
 * CI runs it in the `Neon HTTP integration` job
 * (`pnpm test:integration:neon`). The database must be disposable.
 */
const url = process.env.NEON_DATABASE_URL ?? "";
const skip = url === "";

const fetchEndpoint = process.env.NEON_FETCH_ENDPOINT;
if (fetchEndpoint !== undefined && fetchEndpoint !== "") {
	neonConfig.fetchEndpoint = fetchEndpoint;
}
const wsProxy = process.env.NEON_WS_PROXY;
if (wsProxy !== undefined && wsProxy !== "") {
	neonConfig.wsProxy = wsProxy;
	neonConfig.useSecureWebSocket = false;
}

function pool(): Pool {
	return new Pool({ connectionString: url, max: 5 });
}

describeStoreContract(
	"Neon HTTP",
	async (): Promise<ContractTarget> => {
		const migrator = pool();
		return { client: neon(url), migrator, close: () => migrator.end() };
	},
	{ skip, directClient: true },
);

describeStoreContract(
	"Neon Pool",
	async () => {
		const client = pool();
		return { client, close: () => client.end() };
	},
	{ skip, directClient: true },
);

describe.skipIf(skip)("Neon HTTP outside the contract", () => {
	beforeAll(async () => {
		const migrator = pool();
		try {
			await migrate({ store: migrator, dimensions: CONTRACT_DIMENSIONS });
		} finally {
			await migrator.end();
		}
	}, 120_000);

	test("a Drizzle neon-http db saves and finds memories through $client", async () => {
		const memory = createMemory({
			store: drizzleNeonHttp({ client: neon(url) }),
			embedder: createContractEmbedder(),
		});
		const user = memory.for({
			namespace: uniqueNamespace("drizzle_neon"),
			entityId: "alice",
		});
		try {
			// add is one statement (query); search sends its settings and the
			// vector query together (batch).
			const added = await user.add({ content: "Prefers green tea." });
			const found = await user.search({ query: "green tea", limit: 5 });
			expect(found.map((item) => item.id)).toContain(added.id);
		} finally {
			await user.deleteScope();
		}
	});

	test("migrate and setTextSearchConfig throw CONFIG and name the workarounds", async () => {
		const sql = neon(url);
		for (const run of [
			() => migrate({ store: sql, dimensions: CONTRACT_DIMENSIONS }),
			() =>
				migrate({ store: sql, dimensions: CONTRACT_DIMENSIONS, dryRun: true }),
			() => setTextSearchConfig({ store: sql, textSearchConfig: "simple" }),
			() =>
				setTextSearchConfig({
					store: sql,
					textSearchConfig: "simple",
					dryRun: true,
				}),
		]) {
			const error = await expectMnemocyteError(run(), "CONFIG");
			expect(error.message).toMatch(/neon\(\)/);
			expect(error.message).toMatch(/Pool/);
		}
	});

	test("the installation check runs over HTTP", async () => {
		const report = await inspectPostgresInstallation(toSqlExecutor(neon(url)));
		expect(report).toMatchObject({
			schema: null,
			migrations: { state: "tracked", pending: [] },
			column: { dimensions: CONTRACT_DIMENSIONS },
		});
		expect(report.pgvectorVersion).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

/**
 * `mnemocyte migrate`, `check` and `text-search` through `main` with a
 * memory file whose store is `neon()`: the CLI opens Neon's `Pool` on
 * `DATABASE_URL_UNPOOLED`, or `DATABASE_URL` without it (ARCHITECTURE
 * decision 77). The file takes its client from `globalThis`, so it imports
 * nothing. The CLI imports the same `@neondatabase/serverless` copy as this
 * file, so its `Pool` gets the `neonConfig` set above. Everything goes into
 * a schema of its own, dropped at the end.
 */
describe.skipIf(skip)("CLI with a neon() memory file", () => {
	const schemaName = "mnemocyte_cli_neon";
	const key = "__mnemocyteCliNeonMemory";
	const saved = {
		DATABASE_URL: process.env.DATABASE_URL,
		DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED,
	};
	let cwd: string;

	async function dropSchema(): Promise<void> {
		const admin = pool();
		try {
			await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
		} finally {
			await admin.end();
		}
	}

	beforeAll(async () => {
		await dropSchema();
		// A schemaName install refuses while public holds one, which the
		// suites above leave. The database is disposable and this runs last.
		const admin = pool();
		try {
			await admin.query(
				'DROP TABLE IF EXISTS public."mnemocyte_migrations", public."mnemocyte_events", public."mnemocyte_memories", public."mnemocyte_meta" CASCADE',
			);
		} finally {
			await admin.end();
		}
		cwd = await mkdtemp(join(tmpdir(), "mnemocyte-cli-neon-"));
		await writeFile(
			join(cwd, "memory.mjs"),
			`export const memory = globalThis.${key};\n`,
		);
		(globalThis as Record<string, unknown>)[key] = createMemory({
			store: postgresStore({ client: neon(url), schemaName }),
			embedder: createContractEmbedder(),
		});
	});

	afterAll(async () => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		delete (globalThis as Record<string, unknown>)[key];
		await rm(cwd, { recursive: true, force: true });
		await dropSchema();
	});

	async function run(argv: string[]): Promise<{ code: number; io: TestIo }> {
		const io = createTestIo(cwd);
		const code = await main(argv, io, "0.0.0-test");
		// The connection string, password included, is never printed.
		expect(io.stdout()).not.toContain(url);
		expect(io.stderr()).not.toContain(url);
		return { code, io };
	}

	test("migrate, check and text-search over DATABASE_URL_UNPOOLED", async () => {
		process.env.DATABASE_URL_UNPOOLED = url;
		delete process.env.DATABASE_URL;

		const migrated = await run(["migrate", "--yes"]);
		expect(migrated.io.stderr()).toBe("");
		expect(migrated.code).toBe(0);
		expect(migrated.io.stdout()).toContain(
			"Connecting with Neon's Pool on DATABASE_URL_UNPOOLED: The store in memory.mjs uses Neon's HTTP driver",
		);
		expect(migrated.io.stdout()).toContain(`Created the schema ${schemaName}.`);

		// check reads over HTTP, through the memory file's own client.
		const checked = await run(["check", "--json"]);
		expect(checked.code).toBe(0);
		expect(JSON.parse(checked.io.stdout())).toMatchObject({
			installation: {
				schema: schemaName,
				migrations: { state: "tracked", pending: [] },
				dimensions: CONTRACT_DIMENSIONS,
			},
		});

		const changed = await run(["text-search", "simple", "--yes"]);
		expect(changed.io.stderr()).toBe("");
		expect(changed.code).toBe(0);
		expect(changed.io.stdout()).toContain(
			'Changed keyword search from "english" to "simple".',
		);
	}, 120_000);

	test("without DATABASE_URL_UNPOOLED it falls back to DATABASE_URL", async () => {
		delete process.env.DATABASE_URL_UNPOOLED;
		process.env.DATABASE_URL = url;
		const planned = await run(["migrate", "--dry-run"]);
		expect(planned.io.stderr()).toBe("");
		expect(planned.code).toBe(0);
		expect(planned.io.stdout()).toContain(
			"Connecting with Neon's Pool on DATABASE_URL (DATABASE_URL_UNPOOLED is not set): ",
		);
		expect(planned.io.stdout()).toContain("The schema is up to date.");

		const json = await run(["migrate", "--dry-run", "--json"]);
		expect(JSON.parse(json.io.stdout())).toMatchObject({
			connection: "DATABASE_URL",
			upToDate: true,
		});
	}, 60_000);
});
