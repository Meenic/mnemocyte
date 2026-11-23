import { neon, neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { migrate, setTextSearchConfig } from "mnemocyte";
import { beforeAll, describe, expect, test } from "vitest";
import { inspectPostgresInstallation } from "../../src/db/migrations/inspect.js";
import { toSqlExecutor } from "../../src/sql/clients.js";
import {
	CONTRACT_DIMENSIONS,
	type ContractTarget,
	describeStoreContract,
} from "../contract/suite.js";
import { expectMnemocyteError } from "../helpers.js";

/**
 * The Postgres contract over Neon's serverless driver: the `neon()` HTTP
 * function, Drizzle over it (`drizzle-orm/neon-http`) and the WebSocket
 * `Pool`, which Mnemocyte detects as a node-postgres pool. The HTTP
 * clients have no interactive transactions, so their suites migrate
 * through a `Pool` on the same database.
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

/** An HTTP client, with a Pool to migrate through. */
async function overHttp(
	client: (sql: ReturnType<typeof neon>) => ContractTarget["client"],
): Promise<ContractTarget> {
	const migrator = pool();
	return {
		client: client(neon(url)),
		migrator,
		close: () => migrator.end(),
	};
}

describeStoreContract("Neon HTTP", () => overHttp((sql) => sql), {
	skip,
	directClient: true,
});

describeStoreContract(
	"Drizzle over Neon HTTP",
	() => overHttp((sql) => drizzleNeonHttp({ client: sql })),
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

describe.skipIf(skip)("Neon HTTP without interactive transactions", () => {
	beforeAll(async () => {
		const migrator = pool();
		try {
			await migrate({ store: migrator, dimensions: CONTRACT_DIMENSIONS });
		} finally {
			await migrator.end();
		}
	}, 120_000);

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
