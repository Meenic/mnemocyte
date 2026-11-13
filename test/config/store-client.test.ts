import {
	createMemory,
	type MnemocyteObservation,
	type MnemocyteStoreConfig,
	migrate,
} from "mnemocyte";
import { postgresStore, type SqlExecutor } from "mnemocyte/postgres";
import { describe, expect, test, vi } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

const embedder = {
	model: "store-client",
	dimensions: 2,
	async embed(texts: readonly string[]) {
		return texts.map((text) => [text.length, 1]);
	},
};

/** A function with postgres.js's `unsafe` and `begin`, nothing else. */
function fakePostgresJs() {
	const unsafe = vi.fn(() => {
		const pending = Promise.resolve([]);
		return Object.assign(pending, {
			cancel() {},
			execute: () => pending,
		});
	});
	return {
		client: Object.assign(() => undefined, { unsafe, begin: vi.fn() }),
		calls: unsafe,
	};
}

function fakePGlite() {
	const query = vi.fn(async () => ({ rows: [], fields: [] }));
	return {
		client: { query, exec: vi.fn(async () => []), transaction: vi.fn() },
		calls: query,
	};
}

function fakePool() {
	const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
	return {
		client: { query, connect: vi.fn(), totalCount: 0 },
		calls: query,
	};
}

function fakeExecutor() {
	const query = vi.fn(async () => []);
	const client: SqlExecutor = {
		query,
		transaction: async (fn) => fn(client),
	};
	return { client, calls: query };
}

function configError(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		expect(error).toMatchObject({ name: "MnemocyteError", code: "CONFIG" });
		return error as Error;
	}
	throw new Error("Expected a synchronous CONFIG error.");
}

describe("createMemory({ store: client })", () => {
	test.each([
		["postgres.js", fakePostgresJs],
		["PGlite", fakePGlite],
		["a pg Pool", fakePool],
		["a SqlExecutor", fakeExecutor],
		[
			"Drizzle over a pg Pool",
			() => {
				const pool = fakePool();
				return {
					client: { $client: pool.client, select: vi.fn() },
					calls: pool.calls,
				};
			},
		],
	])(
		"runs on %s without postgresStore, querying only on first use",
		async (_name, fake) => {
			const { client, calls } = fake();
			const events: MnemocyteObservation[] = [];
			const memory = createMemory({
				store: client as never,
				embedder,
				observability: { onEvent: (event) => void events.push(event) },
			});
			expect(calls).not.toHaveBeenCalled();

			await expect(
				memory.get({ scope: testScope("store_client"), key: "missing" }),
			).resolves.toBeNull();
			expect(calls).toHaveBeenCalledTimes(1);
			expect(
				String((calls.mock.calls[0] as unknown[] | undefined)?.[0]),
			).toMatch(/mnemocyte_memories/);
			expect(events.map((event) => event.backend)).toContain("postgres");
		},
	);

	test("prefers a store config from postgresStore over client detection", async () => {
		const { client, calls } = fakeExecutor();
		const memory = createMemory({
			store: postgresStore({ client }),
			embedder,
		});
		await memory.get({ scope: testScope("store_config"), key: "missing" });
		expect(calls).toHaveBeenCalledTimes(1);
	});

	test("rejects a node-postgres Client synchronously and asks for a Pool", () => {
		const pgClient = { query: vi.fn(), connect: vi.fn(), end: vi.fn() };
		for (const store of [pgClient, { $client: pgClient }]) {
			const error = configError(() =>
				createMemory({ store: store as never, embedder }),
			);
			expect(error.message).toMatch(/^store looks like a node-postgres Client/);
			expect(error.message).toMatch(/Pool/);
		}
		expect(pgClient.query).not.toHaveBeenCalled();
	});

	test("rejects an unrecognised value synchronously, naming store configs and clients", () => {
		for (const store of [
			{},
			{ query: async () => [] },
			"postgres://localhost/app",
			42,
			{} as MnemocyteStoreConfig,
		]) {
			const error = configError(() =>
				createMemory({ store: store as never, embedder }),
			);
			expect(error.message).toMatch(/postgresStore\(\)/);
			expect(error.message).toMatch(/SqlExecutor/);
		}
	});

	test("rejects a Drizzle instance over an unsupported driver synchronously", () => {
		const error = configError(() =>
			createMemory({
				store: { $client: Object.assign(() => undefined, {}) } as never,
				embedder,
			}),
		);
		expect(error.message).toMatch(/^store is a Drizzle instance/);
	});
});

describe("migrate({ store: client })", () => {
	test("rejects a value that is neither a store config nor a client", async () => {
		await expectMnemocyteError(
			migrate({ store: {} as never, dimensions: 2 }),
			"CONFIG",
		);
		await expectMnemocyteError(
			migrate({
				store: { query: vi.fn(), connect: vi.fn() } as never,
				dimensions: 2,
			}),
			"CONFIG",
		);
	});

	test("runs on a client without postgresStore", async () => {
		const { client, calls } = fakeExecutor();
		// The fake answers every catalog query with no rows, which the runner
		// rejects; getting that far means the client's backend was loaded and
		// queried rather than refused as configuration.
		await expect(
			migrate({ store: client, dimensions: 2 }),
		).rejects.not.toMatchObject({ code: "CONFIG" });
		expect(calls).toHaveBeenCalled();
	});
});
