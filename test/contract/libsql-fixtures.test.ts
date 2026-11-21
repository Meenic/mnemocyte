import {
	createMemory,
	type Embedder,
	type MemoryConfig,
	migrate,
} from "mnemocyte";
import { libsqlStore } from "mnemocyte/libsql";
import { afterEach, describe, test } from "vitest";
import { createLibsqlExecutor } from "../../src/db/libsql/executor.js";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createLibsqlStore } from "../../src/memory/libsql.js";
import {
	type AccessTrackingHarness,
	verifyAccessTracking,
	verifyAccessTrackingSkipsDeletedRows,
	verifyNotAccessedSinceUsesCreatedAt,
} from "../fixtures/access-tracking.js";
import { exerciseConsolidationDeletePolicy } from "../fixtures/consolidation-delete-policy.js";
import { exerciseConsolidationDuplicateIdPolicy } from "../fixtures/consolidation-duplicate-ids.js";
import {
	createPausingConsolidationStore,
	exerciseConsolidationSurvivorRaces,
} from "../fixtures/consolidation-survivor-races.js";
import { exerciseConsolidationTargetPolicy } from "../fixtures/consolidation-target-policy.js";
import { verifyMetadataTraversalCounts } from "../fixtures/metadata-traversals.js";
import { verifyNamespacePruneAudit } from "../fixtures/prune-audit.js";
import {
	createGatedEmbedder,
	verifyRememberInputSnapshots,
} from "../fixtures/remember-input-snapshot.js";
import {
	createCountingEmbedder,
	verifyRememberInputValidation,
} from "../fixtures/remember-input-validation.js";
import { verifyStoreInsertContract } from "../fixtures/store-insert-contract.js";
import { type LibsqlDatabase, openLibsql } from "./libsql.js";

/**
 * The shared fixtures the Postgres side runs in `integration`
 * (test/integration/*.test.ts) rather than in the shared contract, on
 * libSQL: consolidation policies and races, access tracking, prune audit,
 * input snapshots and validation, metadata traversals and the insert
 * contract. Each test gets a database of its own.
 */

const DIMENSIONS = 1536;
const MODEL = "mnemocyte-integration-test";

/** The integration files' embedding: character counts, sparse. */
function createEmbedding(seed: string): number[] {
	const values = Array.from({ length: DIMENSIONS }, () => 0);
	for (const char of seed) {
		const index = char.charCodeAt(0) % values.length;
		values[index] = (values[index] ?? 0) + 1;
	}
	return values;
}

const embedder: Embedder = {
	model: MODEL,
	dimensions: DIMENSIONS,
	async embed(texts) {
		return texts.map(createEmbedding);
	},
};

const opened: LibsqlDatabase[] = [];

/** A migrated, empty database. */
async function open(): Promise<LibsqlDatabase> {
	const database = await openLibsql();
	opened.push(database);
	await migrate({ store: database.client, dimensions: DIMENSIONS });
	return database;
}

afterEach(async () => {
	for (const database of opened.splice(0)) {
		await database.close();
	}
});

function prefix(label: string): string {
	return `${label}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

describe("libSQL shared fixtures", () => {
	test("consolidation delete, target and duplicate-id policies", async () => {
		const database = await open();
		const client = createMemory({
			store: libsqlStore({ client: database.client }),
			embedder,
			audit: { enabled: true },
		});
		const entityPrefix = prefix("policy");
		await exerciseConsolidationDeletePolicy(client, entityPrefix);
		await exerciseConsolidationTargetPolicy(client, entityPrefix);
		await exerciseConsolidationDuplicateIdPolicy({ client, entityPrefix });
	});

	test("consolidation protects the survivor and current tags against races", async () => {
		const database = await open();
		const config: MemoryConfig = { embedder, audit: { enabled: true } };
		const baseStore = createLibsqlStore(createLibsqlExecutor(database.client));
		const pausing = createPausingConsolidationStore(baseStore);
		await exerciseConsolidationSurvivorRaces({
			client: createMemoryClient(config, pausing.store),
			mutator: createMemoryClient(config, baseStore),
			pauseNext: pausing.pauseNext,
			entityPrefix: prefix("race"),
		});
	});

	describe("access tracking", () => {
		async function harness(): Promise<AccessTrackingHarness> {
			const database = await open();
			return {
				store: createLibsqlStore(createLibsqlExecutor(database.client)),
				embedder,
				entityId: prefix("access"),
				async readStoredState(ids) {
					const result = await database.client.execute({
						sql: `SELECT id, access_count, last_accessed_at, updated_at
							FROM mnemocyte_memories
							WHERE id IN (${ids.map((_, index) => `?${index + 1}`).join(", ")})
							ORDER BY id`,
						args: [...ids],
					});
					return result.rows.map((row) => ({
						id: String(row.id),
						accessCount: Number(row.access_count),
						lastAccessedAt:
							row.last_accessed_at === null
								? null
								: new Date(Number(row.last_accessed_at)),
						updatedAt: new Date(Number(row.updated_at)),
					}));
				},
			};
		}

		test("is opt-in, deferred and leaves updated_at alone", async () => {
			await verifyAccessTracking(await harness());
		});

		test("skips rows deleted before the write", async () => {
			await verifyAccessTrackingSkipsDeletedRows(await harness());
		});

		test("prunes never-accessed rows by created_at", async () => {
			await verifyNotAccessedSinceUsesCreatedAt(await harness());
		});
	});

	test("a namespace prune is audited once per affected entity", async () => {
		const database = await open();
		await verifyNamespacePruneAudit(
			createMemory({
				store: database.client,
				embedder,
				audit: { enabled: true },
			}),
			prefix("prune_audit"),
		);
	});

	test("owns mutable single and batch inputs before awaiting", async () => {
		const database = await open();
		const gate = createGatedEmbedder(MODEL, DIMENSIONS);
		await verifyRememberInputSnapshots(
			createMemory({ store: database.client, embedder: gate.embedder }),
			gate.nextCall,
			prefix("snapshot"),
		);
	});

	test("rejects malformed runtime values before embedding or storage", async () => {
		const database = await open();
		const counter = createCountingEmbedder(MODEL, DIMENSIONS);
		await verifyRememberInputValidation(
			createMemory({ store: database.client, embedder: counter.embedder }),
			counter.getCalls,
			prefix("validation"),
		);
	});

	test("validates metadata once at ingress and clones once at egress", async () => {
		const database = await open();
		const counter = createCountingEmbedder(MODEL, DIMENSIONS);
		await verifyMetadataTraversalCounts(
			createMemory({
				store: database.client,
				embedder: counter.embedder,
				audit: { enabled: true },
			}),
			prefix("traversal"),
		);
	});

	test("addMany keeps input order and cardinality", async () => {
		const database = await open();
		await verifyStoreInsertContract(
			createMemory({ store: database.client, embedder }),
			prefix("insert"),
		);
	});
});
