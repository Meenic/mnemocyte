import {
	createMemory,
	type Embedder,
	type MemoryClient,
	type MemoryScope,
	migrate,
} from "mnemocyte";
import { type PostgresClient, postgresStore } from "mnemocyte/postgres";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { toSqlExecutor } from "../../src/sql/clients.js";
import type { SqlExecutor } from "../../src/sql/executor.js";
import {
	verifyGetAndScopeValidation,
	verifyKeyedAdd,
	verifyListPaging,
	verifyScopeVisibility,
	verifyUpdate,
} from "../fixtures/scoped-api.js";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

/**
 * The shared Postgres contract: the same checks on every driver Mnemocyte
 * accepts, run on PGlite in the `contract` project and on real Postgres in
 * `integration`. Each run works in its own namespaces and removes them
 * afterwards, so it can share a database with other test files.
 */

export const CONTRACT_DIMENSIONS = 1536;

/** A connected driver client and how to release it. */
export interface ContractTarget {
	client: PostgresClient;
	close(): Promise<void>;
}

function hashWord(word: string): number {
	let hash = 2166136261;
	for (const char of word) {
		hash ^= char.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

/** A dense pseudo-random vector in [-1, 1] seeded by the word (mulberry32). */
function wordVector(word: string): number[] {
	let state = hashWord(word);
	return Array.from({ length: CONTRACT_DIMENSIONS }, () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
	});
}

/**
 * The sum of one dense random vector per word: texts that share words point
 * the same way and identical texts get identical vectors. Dense vectors keep
 * the HNSW graph navigable; sparse hand-made ones leave many rows at the same
 * distance, and parts of the graph unreachable (see features/postgres.md).
 */
export function embedText(text: string): number[] {
	const values = new Array<number>(CONTRACT_DIMENSIONS).fill(0);
	for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? ["empty"]) {
		const vector = wordVector(word);
		for (let index = 0; index < CONTRACT_DIMENSIONS; index += 1) {
			values[index] = (values[index] ?? 0) + (vector[index] ?? 0);
		}
	}
	return values;
}

function createContractEmbedder(): Embedder & { calls: () => number } {
	let calls = 0;
	return {
		// The model the other integration files record, so the suite can share
		// their database.
		model: "mnemocyte-integration-test",
		dimensions: CONTRACT_DIMENSIONS,
		async embed(texts) {
			calls += 1;
			return texts.map(embedText);
		},
		calls: () => calls,
	};
}

let runCounter = 0;

function uniqueNamespace(label: string): string {
	runCounter += 1;
	return `contract_${label}_${Date.now()}_${runCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

async function sortedIds(
	memories: Promise<readonly { id: string }[]>,
): Promise<string[]> {
	return (await memories).map((memory) => memory.id).sort();
}

/**
 * Register the contract for one driver. `connect` runs once per file; the
 * suite migrates the database (adopting a schema installed another way) and
 * then works only in namespaces it created.
 */
export function describeStoreContract(
	name: string,
	connect: () => Promise<ContractTarget>,
	options: { skip?: boolean } = {},
): void {
	describe.skipIf(options.skip ?? false)(`Postgres contract (${name})`, () => {
		let target: ContractTarget | undefined;
		let executor: SqlExecutor | undefined;
		const namespaces: string[] = [];

		function db(): SqlExecutor {
			return expectDefined(executor, "contract target is not connected");
		}

		function client(
			label: string,
			options: { audit?: boolean } = {},
		): {
			memory: MemoryClient;
			namespace: string;
			embedCalls: () => number;
		} {
			const namespace = uniqueNamespace(label);
			namespaces.push(namespace);
			const embedder = createContractEmbedder();
			const memory = createMemory({
				store: postgresStore({
					client: expectDefined(target, "not connected").client,
				}),
				embedder,
				...(options.audit ? { audit: { enabled: true } } : {}),
			});
			return { memory, namespace, embedCalls: embedder.calls };
		}

		beforeAll(async () => {
			target = await connect();
			executor = toSqlExecutor(target.client);
			const store = postgresStore({ client: target.client });
			await migrate({ store, dimensions: CONTRACT_DIMENSIONS });
		}, 120_000);

		afterAll(async () => {
			if (!target) {
				return;
			}
			try {
				for (const namespace of namespaces) {
					// One statement per table, so consolidation links between
					// deleted rows never block the delete.
					await db().query(
						"DELETE FROM mnemocyte_memories WHERE namespace LIKE $1",
						[`${namespace}%`],
					);
					await db().query(
						"DELETE FROM mnemocyte_events WHERE namespace LIKE $1",
						[`${namespace}%`],
					);
				}
			} finally {
				await target.close();
			}
		}, 120_000);

		test("migrate is a no-op once the schema is current", async () => {
			const store = postgresStore({
				client: expectDefined(target).client,
			});
			await expect(
				migrate({ store, dimensions: CONTRACT_DIMENSIONS }),
			).resolves.toEqual({ applied: [], adopted: [] });
		});

		test("transactions commit, roll back and nest as savepoints", async () => {
			const { namespace } = client("tx");
			const transaction = expectDefined(
				db().transaction?.bind(db()),
				"every built-in adapter has transaction",
			);
			const insertEvent = (tx: SqlExecutor, description: string) =>
				tx.query(
					`INSERT INTO mnemocyte_events (id, namespace, entity_id, description, metadata)
					 VALUES (gen_random_uuid(), $1, 'tx', $2, '{}'::jsonb)`,
					[namespace, description],
				);
			const descriptions = async () =>
				(
					await db().query<{ description: string }>(
						"SELECT description FROM mnemocyte_events WHERE namespace = $1 ORDER BY description",
						[namespace],
					)
				).map((row) => row.description);

			await transaction(async (tx) => {
				await insertEvent(tx, "committed");
			});
			await expect(
				transaction(async (tx) => {
					await insertEvent(tx, "rolled back");
					throw new Error("roll back");
				}),
			).rejects.toThrow("roll back");
			await transaction(async (tx) => {
				await insertEvent(tx, "outer");
				const nested = expectDefined(tx.transaction?.bind(tx));
				await expect(
					nested(async (inner) => {
						await insertEvent(inner, "savepoint rolled back");
						throw new Error("inner");
					}),
				).rejects.toThrow("inner");
				await nested(async (inner) => {
					await insertEvent(inner, "savepoint released");
				});
			});
			expect(await descriptions()).toEqual([
				"committed",
				"outer",
				"savepoint released",
			]);

			// A failed statement aborts the transaction; the adapter rolls back
			// and the connection stays usable.
			await expect(
				transaction(async (tx) => {
					await tx.query("SELECT 1 / 0", []);
				}),
			).rejects.toThrow();
			await expect(db().query("SELECT 1 AS one", [])).resolves.toEqual([
				{ one: 1 },
			]);
		});

		test("an aborted signal stops a statement before it is sent", async () => {
			const controller = new AbortController();
			controller.abort();
			await expectMnemocyteError(
				db().query("SELECT 1", [], { signal: controller.signal }),
				"ABORTED",
			);
		});

		test("values round-trip with their JavaScript types", async () => {
			const { memory, namespace } = client("types");
			const scope: MemoryScope = { namespace, entityId: "alice" };
			const expiresAt = new Date(Date.now() + 3_600_000);
			const added = await memory.add({
				scope,
				content: "Prefers tea over coffee.",
				kind: "preference",
				importance: "high",
				tags: ["drinks", "morning"],
				source: "chat:1",
				confidence: 0.75,
				metadata: { nested: { list: [1, "two", null, true] }, n: 1.5 },
				expiresAt,
			});
			const read = expectDefined(await memory.get({ scope, id: added.id }));
			expect(read).toEqual(added);
			expect(read.createdAt).toBeInstanceOf(Date);
			expect(read.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
			expect(read.tags).toEqual(["drinks", "morning"]);
			expect(read.confidence).toBe(0.75);
			expect(read.metadata).toEqual({
				nested: { list: [1, "two", null, true] },
				n: 1.5,
			});
			expect(read.embeddingDimensions).toBe(CONTRACT_DIMENSIONS);
			expect(read.accessCount).toBe(0);
		});

		test("addMany writes more than one insert chunk", async () => {
			const { memory, namespace } = client("chunks");
			const scope: MemoryScope = { namespace, entityId: "alice" };
			const added = await memory.addMany({
				scope,
				memories: Array.from({ length: 260 }, (_, index) => ({
					content: `memory number ${index}`,
				})),
			});
			expect(added).toHaveLength(260);
			const stats = await memory.stats({ scope });
			expect(stats.memoryCount).toBe(260);
		});

		test("search and context find the matching memory", async () => {
			const { memory, namespace } = client("search");
			const scope: MemoryScope = { namespace, entityId: "alice" };
			const tea = await memory.add({
				scope,
				content: "Alice drinks green tea every morning.",
			});
			await memory.addMany({
				scope,
				memories: [
					{ content: "Alice works as a structural engineer." },
					{ content: "Alice has a dog named Biscuit." },
				],
			});
			const results = await memory.search({
				scope,
				query: "green tea morning",
				limit: 2,
			});
			expect(results.map((result) => result.id)).toContain(tea.id);
			const context = await memory.context({
				scope,
				query: "green tea morning",
			});
			expect(context).toContain("green tea");
		});

		test("scope visibility", async () => {
			const { memory, namespace } = client("visibility");
			await verifyScopeVisibility(memory, namespace);
		});

		test("keyed add", async () => {
			const { memory, namespace } = client("keys");
			await verifyKeyedAdd(memory, namespace);
		});

		test("list paging", async () => {
			const { memory, namespace } = client("paging");
			await verifyListPaging(memory, namespace);
		});

		test("update", async () => {
			const { memory, namespace, embedCalls } = client("update");
			await verifyUpdate(memory, namespace, embedCalls);
		});

		test("get and scope validation", async () => {
			const { memory, namespace } = client("get");
			await verifyGetAndScopeValidation(memory, namespace);
		});

		describe("cross-scope isolation", () => {
			/**
			 * The same content in the scope under test and in three neighbours:
			 * another entity, another agent of the entity, and another
			 * namespace.
			 */
			async function seedNeighbours(label: string, contents: string[]) {
				const { memory, namespace } = client(label);
				const own: MemoryScope = { namespace, entityId: "alice" };
				const scopes = {
					own,
					otherEntity: { namespace, entityId: "bob" },
					otherAgent: { ...own, agentId: "agent-b" },
					otherNamespace: {
						namespace: `${namespace}_other`,
						entityId: "alice",
					},
				} satisfies Record<string, MemoryScope>;
				const ids: Record<keyof typeof scopes, string[]> = {
					own: [],
					otherEntity: [],
					otherAgent: [],
					otherNamespace: [],
				};
				for (const key of Object.keys(scopes) as (keyof typeof scopes)[]) {
					const added = await memory.addMany({
						scope: scopes[key],
						memories: contents.map((content) => ({
							content,
							tags: ["isolation"],
						})),
					});
					ids[key] = added.map((item) => item.id);
				}
				return { memory, namespace, scopes, ids };
			}

			test("search returns only the scope's memories", async () => {
				const { memory, scopes, ids } = await seedNeighbours("iso_search", [
					"Isolation probe about sailing boats.",
				]);
				const found = await sortedIds(
					memory.search({
						scope: scopes.own,
						query: "sailing boats",
						limit: 50,
					}),
				);
				expect(found).toEqual([...ids.own].sort());
				const asAgentB = await sortedIds(
					memory.search({
						scope: scopes.otherAgent,
						query: "sailing boats",
						limit: 50,
						exactAgent: true,
					}),
				);
				expect(asAgentB).toEqual([...ids.otherAgent].sort());
			});

			test("get, update and delete cannot reach another scope", async () => {
				const { memory, scopes, ids } = await seedNeighbours("iso_ids", [
					"Isolation probe about mountain hikes.",
				]);
				const foreign = expectDefined(ids.otherNamespace[0]);
				await expect(
					memory.get({ scope: scopes.own, id: foreign }),
				).resolves.toBeNull();
				await expectMnemocyteError(
					memory.update({ scope: scopes.own, id: foreign, importance: "low" }),
					"NOT_FOUND",
				);
				await expectMnemocyteError(
					memory.delete({ scope: scopes.own, id: foreign }),
					"NOT_FOUND",
				);
				await expect(
					memory.get({ scope: scopes.otherNamespace, id: foreign }),
				).resolves.toMatchObject({ id: foreign, importance: "normal" });
			});

			test("prune deletes only inside its selector", async () => {
				const { memory, namespace, scopes, ids } = await seedNeighbours(
					"iso_prune",
					["Isolation probe one.", "Isolation probe two."],
				);
				await expect(
					memory.prune({
						scope: { namespace, entityId: "alice", agentId: "agent-b" },
						tags: ["isolation"],
					}),
				).resolves.toEqual({ matchedCount: 2, deletedCount: 2, dryRun: false });
				await expect(
					memory.prune({
						scope: { namespace, entityId: "bob" },
						tags: ["isolation"],
					}),
				).resolves.toEqual({ matchedCount: 2, deletedCount: 2, dryRun: false });
				// The scope's own memories and the other namespace's are untouched.
				expect(
					await sortedIds(
						memory.list({ scope: scopes.own }).then((page) => page.memories),
					),
				).toEqual([...ids.own].sort());
				expect(
					await sortedIds(
						memory
							.list({ scope: scopes.otherNamespace })
							.then((page) => page.memories),
					),
				).toEqual([...ids.otherNamespace].sort());
				// A namespace-wide prune stays inside its namespace.
				await expect(
					memory.prune({ scope: { namespace }, tags: ["isolation"] }),
				).resolves.toMatchObject({ deletedCount: 2 });
				await expect(
					memory.stats({ scope: scopes.otherNamespace }),
				).resolves.toMatchObject({ memoryCount: 2 });
			});

			test("findDuplicates pairs only memories of the scope", async () => {
				const { memory, scopes, ids } = await seedNeighbours("iso_dups", [
					"Isolation probe about chess openings.",
					"Isolation probe about chess openings.",
				]);
				const pairs = await memory.findDuplicates({
					scope: scopes.own,
					threshold: 0.99,
				});
				expect(pairs).toHaveLength(1);
				const pair = expectDefined(pairs[0]);
				expect([pair.a.id, pair.b.id].sort()).toEqual([...ids.own].sort());
				expect(pair.similarity).toBeCloseTo(1, 5);
			});

			test("consolidate rejects ids from another scope and changes nothing", async () => {
				const { memory, scopes, ids } = await seedNeighbours(
					"iso_consolidate",
					["Isolation probe about rivers.", "Isolation probe about lakes."],
				);
				const [survivor, local] = ids.own;
				for (const foreign of [
					ids.otherEntity[0],
					ids.otherAgent[0],
					ids.otherNamespace[0],
				]) {
					await expectMnemocyteError(
						memory.experimental.consolidate({
							scope: scopes.own,
							survivorId: expectDefined(survivor),
							supersededIds: [expectDefined(local), expectDefined(foreign)],
						}),
						"NOT_FOUND",
					);
				}
				const own = await memory.list({ scope: scopes.own });
				expect(own.memories.every((item) => item.supersededBy === null)).toBe(
					true,
				);
				await expect(
					memory.experimental.consolidate({
						scope: scopes.own,
						survivorId: expectDefined(survivor),
						supersededIds: [expectDefined(local)],
					}),
				).resolves.toMatchObject({ supersededCount: 1 });
				for (const scope of [
					scopes.otherEntity,
					scopes.otherAgent,
					scopes.otherNamespace,
				]) {
					const page = await memory.list({ scope, exactAgent: true });
					expect(
						page.memories.every((item) => item.supersededBy === null),
					).toBe(true);
				}
			});

			test("deleteScope and stats select only their scope", async () => {
				const { memory, namespace, scopes } = await seedNeighbours(
					"iso_erase",
					["Isolation probe about kites."],
				);
				await expect(
					memory.stats({ scope: { namespace, entityId: "alice" } }),
				).resolves.toMatchObject({ memoryCount: 2 });
				await expect(
					memory.deleteScope({ scope: { namespace, entityId: "alice" } }),
				).resolves.toEqual({ deletedCount: 2 });
				await expect(
					memory.stats({ scope: scopes.otherEntity }),
				).resolves.toMatchObject({ memoryCount: 1 });
				await expect(
					memory.stats({ scope: scopes.otherNamespace }),
				).resolves.toMatchObject({ memoryCount: 1 });
			});
		});
	});
}
