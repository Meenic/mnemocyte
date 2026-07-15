import { describe, expect, test } from "vitest";
import type { DatabaseHandle, MnemocyteDatabase } from "../../src/db/index.js";
import { createPostgresClient } from "../../src/memory/postgres.js";
import type { MnemocyteConfig } from "../../src/types.js";
import { expectMnemocyteError } from "../helpers.js";

interface FakeHandle {
	handle: DatabaseHandle;
	getSelectCount(): number;
}

interface FakeSelectChain {
	from(table: unknown): FakeSelectChain;
	where(condition: unknown): FakeSelectChain;
	limit(limit: number): Promise<unknown[]>;
}

function createFakeHandle(options: {
	rows?: unknown[];
	error?: unknown;
	executeError?: unknown;
}): FakeHandle {
	let selectCount = 0;
	const chain: FakeSelectChain = {
		from() {
			return chain;
		},
		where() {
			return chain;
		},
		async limit() {
			selectCount += 1;
			if (options.error) {
				throw options.error;
			}
			return options.rows ?? [];
		},
	};
	const db = {
		select() {
			return chain;
		},
		async execute() {
			if (options.executeError) {
				throw options.executeError;
			}
			return [];
		},
	} as unknown as MnemocyteDatabase;
	return {
		handle: {
			db,
			async close() {},
		},
		getSelectCount() {
			return selectCount;
		},
	};
}

function createConfig(
	dimensions: number,
	embedCalls: string[],
): MnemocyteConfig {
	return {
		embedder: {
			model: "metadata-test",
			dimensions,
			async embed(texts) {
				embedCalls.push(...texts);
				return texts.map(() => Array.from({ length: dimensions }, () => 0));
			},
		},
	};
}

describe("Postgres metadata validation", () => {
	test("allows matching metadata and caches the successful check", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			rows: [{ key: "installation", embeddingDimensions: 768 }],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls),
			fake.handle,
		);

		await expect(
			client.recall({ entityId: "alice", query: "hello" }),
		).resolves.toEqual([]);
		expect(embedCalls).toEqual(["hello"]);
		expect(fake.getSelectCount()).toBe(1);

		await expect(
			client.recall({ entityId: "alice", query: "again" }),
		).resolves.toEqual([]);
		expect(embedCalls).toEqual(["hello", "again"]);
		expect(fake.getSelectCount()).toBe(1);
	});

	test("rejects mismatched metadata before remember calls the embedder", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			rows: [{ key: "installation", embeddingDimensions: 1536 }],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls),
			fake.handle,
		);

		const error = await expectMnemocyteError(
			client.remember({ entityId: "alice", content: "hello" }),
			"CONFIG",
		);
		expect(error.message).toContain("768");
		expect(error.message).toContain("1536");
		expect(embedCalls).toEqual([]);
		expect(fake.getSelectCount()).toBe(1);
	});

	test("rejects mismatched metadata before rememberMany calls the embedder", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			rows: [{ key: "installation", embeddingDimensions: 1536 }],
		});
		const client = createPostgresClient(
			createConfig(384, embedCalls),
			fake.handle,
		);

		await expectMnemocyteError(
			client.rememberMany([{ entityId: "alice", content: "hello" }]),
			"CONFIG",
		);
		expect(embedCalls).toEqual([]);
	});

	test("rejects mismatched metadata before recall calls the embedder", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			rows: [{ key: "installation", embeddingDimensions: 1536 }],
		});
		const client = createPostgresClient(
			createConfig(1024, embedCalls),
			fake.handle,
		);

		await expectMnemocyteError(
			client.recall({ entityId: "alice", query: "hello" }),
			"CONFIG",
		);
		expect(embedCalls).toEqual([]);
	});

	test("allows non-embedding operations when metadata dimensions mismatch", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			rows: [{ key: "installation", embeddingDimensions: 1536 }],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls),
			fake.handle,
		);

		await expect(client.stats({ entityId: "alice" })).resolves.toMatchObject({
			entityId: "alice",
			memoryCount: 0,
		});
		expect(embedCalls).toEqual([]);
		expect(fake.getSelectCount()).toBe(0);
	});

	test("reports a missing metadata table as a migration error before embedding", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({ error: { code: "42P01" } });
		const client = createPostgresClient(
			createConfig(1536, embedCalls),
			fake.handle,
		);

		const error = await expectMnemocyteError(
			client.recall({ entityId: "alice", query: "hello" }),
			"MIGRATION",
		);
		expect(error.message).toContain("mnemocyte_meta");
		expect(embedCalls).toEqual([]);
	});

	test("reports a missing installation row as a migration error before embedding", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({ rows: [] });
		const client = createPostgresClient(
			createConfig(1536, embedCalls),
			fake.handle,
		);

		const error = await expectMnemocyteError(
			client.recall({ entityId: "alice", query: "hello" }),
			"MIGRATION",
		);
		expect(error.message).toContain("installation");
		expect(embedCalls).toEqual([]);
	});

	test("wraps expected query failures in MnemocyteError", async () => {
		const embedCalls: string[] = [];
		const migrationFailure = createFakeHandle({
			rows: [{ key: "installation", embeddingDimensions: 1536 }],
			executeError: { code: "42P01" },
		});
		const migrationClient = createPostgresClient(
			createConfig(1536, embedCalls),
			migrationFailure.handle,
		);
		await expectMnemocyteError(
			migrationClient.recall({ entityId: "alice", query: "hello" }),
			"MIGRATION",
		);

		const dbFailure = createFakeHandle({
			rows: [{ key: "installation", embeddingDimensions: 1536 }],
			executeError: { code: "57P01" },
		});
		const dbClient = createPostgresClient(
			createConfig(1536, embedCalls),
			dbFailure.handle,
		);
		await expectMnemocyteError(
			dbClient.recall({ entityId: "alice", query: "hello" }),
			"DB",
		);
	});
});
