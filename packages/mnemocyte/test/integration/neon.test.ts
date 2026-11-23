import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { createMemory, migrate, setTextSearchConfig } from "mnemocyte";
import { beforeAll, describe, expect, test } from "vitest";
import { inspectPostgresInstallation } from "../../src/db/migrations/inspect.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import {
	createContractEmbedder,
	uniqueNamespace,
} from "../../src/store-test/contract.js";
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
