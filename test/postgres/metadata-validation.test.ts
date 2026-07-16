import { describe, expect, test } from "vitest";
import type { DatabaseHandle, MnemocyteDatabase } from "../../src/db/index.js";
import { createPostgresClient } from "../../src/memory/postgres.js";
import type { MnemocyteConfig } from "../../src/types.js";
import { expectMnemocyteError } from "../helpers.js";

interface FakeMetaRow {
	key: string;
	embeddingDimensions: number;
	embeddingModel: string | null;
}

interface FakeHandle {
	handle: DatabaseHandle;
	getDistinctSelectCount(): number;
	getExecuteCount(): number;
	getMeta(): FakeMetaRow | null;
	getSelectCount(): number;
	getUpdateCount(): number;
}

interface FakeSelectChain {
	from(table: unknown): FakeSelectChain;
	where(condition: unknown): FakeSelectChain;
	limit(limit: number): Promise<unknown[]>;
}

function createFakeHandle(options: {
	metaRows?: FakeMetaRow[];
	storedModels?: string[];
	error?: unknown;
	executeError?: unknown;
}): FakeHandle {
	const metaRows = options.metaRows?.map((row) => ({ ...row })) ?? [];
	let distinctSelectCount = 0;
	let executeCount = 0;
	let selectCount = 0;
	let updateCount = 0;
	const metaChain: FakeSelectChain = {
		from() {
			return metaChain;
		},
		where() {
			return metaChain;
		},
		async limit() {
			selectCount += 1;
			if (options.error) {
				throw options.error;
			}
			return metaRows.map((row) => ({ ...row }));
		},
	};
	const modelChain: FakeSelectChain = {
		from() {
			return modelChain;
		},
		where() {
			return modelChain;
		},
		async limit(limit) {
			distinctSelectCount += 1;
			return (options.storedModels ?? [])
				.slice(0, limit)
				.map((embeddingModel) => ({ embeddingModel }));
		},
	};
	const db = {
		select() {
			return metaChain;
		},
		selectDistinct() {
			return modelChain;
		},
		update() {
			return {
				set(values: unknown) {
					const embeddingModel =
						typeof values === "object" &&
						values !== null &&
						"embeddingModel" in values &&
						typeof values.embeddingModel === "string"
							? values.embeddingModel
							: null;
					return {
						where() {
							return {
								async returning() {
									updateCount += 1;
									const meta = metaRows.find(
										(row) =>
											row.key === "installation" && row.embeddingModel === null,
									);
									if (!meta || embeddingModel === null) {
										return [];
									}
									meta.embeddingModel = embeddingModel;
									return [{ ...meta }];
								},
							};
						},
					};
				},
			};
		},
		async execute() {
			executeCount += 1;
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
		getDistinctSelectCount() {
			return distinctSelectCount;
		},
		getExecuteCount() {
			return executeCount;
		},
		getMeta() {
			const meta = metaRows[0];
			return meta ? { ...meta } : null;
		},
		getSelectCount() {
			return selectCount;
		},
		getUpdateCount() {
			return updateCount;
		},
	};
}

function createConfig(
	dimensions: number,
	embedCalls: string[],
	model = "metadata-test",
): MnemocyteConfig {
	return {
		embedder: {
			model,
			dimensions,
			async embed(texts) {
				embedCalls.push(...texts);
				return texts.map(() =>
					Array.from({ length: dimensions }, (_value, index) =>
						index === 0 ? 1 : 0,
					),
				);
			},
		},
	};
}

function installationMeta(
	embeddingDimensions: number,
	embeddingModel: string | null = "metadata-test",
): FakeMetaRow {
	return {
		key: "installation",
		embeddingDimensions,
		embeddingModel,
	};
}

describe("Postgres metadata validation", () => {
	test("allows matching metadata and caches the successful check", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768)],
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

	test("rejects mismatched dimensions before remember calls the embedder", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(1536)],
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

	test("rejects a mismatched model before write embedders are called", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768, "recorded-model")],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "configured-model"),
			fake.handle,
		);

		const rememberError = await expectMnemocyteError(
			client.remember({ entityId: "alice", content: "hello" }),
			"CONFIG",
		);
		expect(rememberError.message).toContain("configured-model");
		expect(rememberError.message).toContain("recorded-model");
		await expectMnemocyteError(
			client.rememberMany([{ entityId: "alice", content: "batch" }]),
			"CONFIG",
		);
		expect(embedCalls).toEqual([]);
		expect(fake.getExecuteCount()).toBe(0);
	});

	test("rejects a mismatched model before recall calls the embedder", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768, "recorded-model")],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "configured-model"),
			fake.handle,
		);

		await expectMnemocyteError(
			client.recall({ entityId: "alice", query: "hello" }),
			"CONFIG",
		);
		expect(embedCalls).toEqual([]);
		expect(fake.getExecuteCount()).toBe(0);
	});

	test("rejects a mismatched model before duplicate SQL", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768, "recorded-model")],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "configured-model"),
			fake.handle,
		);

		await expectMnemocyteError(
			client.findDuplicates({ entityId: "alice" }),
			"CONFIG",
		);
		expect(embedCalls).toEqual([]);
		expect(fake.getExecuteCount()).toBe(0);
	});

	test("records the configured model for an empty installation", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768, null)],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "first-model"),
			fake.handle,
		);

		await expect(
			client.recall({ entityId: "alice", query: "hello" }),
		).resolves.toEqual([]);
		expect(fake.getMeta()?.embeddingModel).toBe("first-model");
		expect(fake.getDistinctSelectCount()).toBe(1);
		expect(fake.getUpdateCount()).toBe(1);
		expect(embedCalls).toEqual(["hello"]);
	});

	test("infers and records a single historical model", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768, null)],
			storedModels: ["historical-model"],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "historical-model"),
			fake.handle,
		);

		await expect(
			client.recall({ entityId: "alice", query: "hello" }),
		).resolves.toEqual([]);
		expect(fake.getMeta()?.embeddingModel).toBe("historical-model");
		expect(embedCalls).toEqual(["hello"]);
	});

	test("records one historical model before rejecting a different configured model", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768, null)],
			storedModels: ["historical-model"],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "configured-model"),
			fake.handle,
		);

		await expectMnemocyteError(
			client.recall({ entityId: "alice", query: "hello" }),
			"CONFIG",
		);
		expect(fake.getMeta()?.embeddingModel).toBe("historical-model");
		expect(embedCalls).toEqual([]);
	});

	test("rejects mixed historical models as a migration error", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(768, null)],
			storedModels: ["model-a", "model-b"],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "model-a"),
			fake.handle,
		);

		const error = await expectMnemocyteError(
			client.findDuplicates({ entityId: "alice" }),
			"MIGRATION",
		);
		expect(error.message).toContain("multiple");
		expect(fake.getMeta()?.embeddingModel).toBeNull();
		expect(fake.getUpdateCount()).toBe(0);
		expect(embedCalls).toEqual([]);
		expect(fake.getExecuteCount()).toBe(0);
	});

	test("allows non-embedding operations when metadata is incompatible", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({
			metaRows: [installationMeta(1536, "recorded-model")],
		});
		const client = createPostgresClient(
			createConfig(768, embedCalls, "configured-model"),
			fake.handle,
		);

		await expect(client.stats({ entityId: "alice" })).resolves.toMatchObject({
			entityId: "alice",
			memoryCount: 0,
		});
		expect(embedCalls).toEqual([]);
		expect(fake.getSelectCount()).toBe(0);
	});

	test("reports missing or outdated metadata as a migration error before embedding", async () => {
		for (const code of ["42P01", "42703"]) {
			const embedCalls: string[] = [];
			const fake = createFakeHandle({ error: { code } });
			const client = createPostgresClient(
				createConfig(1536, embedCalls),
				fake.handle,
			);

			const error = await expectMnemocyteError(
				client.recall({ entityId: "alice", query: "hello" }),
				"MIGRATION",
			);
			expect(error.message).toContain("0002_add_embedding_model.sql");
			expect(embedCalls).toEqual([]);
		}
	});

	test("reports a missing installation row as a migration error before embedding", async () => {
		const embedCalls: string[] = [];
		const fake = createFakeHandle({ metaRows: [] });
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
			metaRows: [installationMeta(1536)],
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
			metaRows: [installationMeta(1536)],
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
