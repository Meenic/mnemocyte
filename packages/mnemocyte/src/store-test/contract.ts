import { describe, expect, test } from "vitest";
import {
	createMemory,
	type Embedder,
	type LibsqlClient,
	type MemoryClient,
	type MemoryScope,
	type MnemocyteStoreConfig,
	type PostgresClient,
} from "../index.js";
import { readMemoryClientInternals } from "../memory/client-internals.js";
import { expectDefined, expectMnemocyteError } from "./expect.js";
import {
	verifyAuditFailureRollsBack,
	verifyAuditPayloads,
} from "./fixtures/atomic-audit.js";
import {
	verifyAuditMemoryHistory,
	verifyAuditPages,
} from "./fixtures/audit-cursor.js";
import { verifyAuditRetention } from "./fixtures/audit-retention.js";
import { verifyBoundScope } from "./fixtures/bound-scope.js";
import {
	verifyContextMemories,
	verifyContextTracksRenderedMemories,
} from "./fixtures/context-memories.js";
import { verifyDuplicatePages } from "./fixtures/duplicate-pages.js";
import { verifyKnnDuplicates } from "./fixtures/knn-duplicates.js";
import {
	verifyCreatedFilters,
	verifyGetAndScopeValidation,
	verifyKeyedAdd,
	verifyListPaging,
	verifyScopeVisibility,
	verifyUpdate,
} from "./fixtures/scoped-api.js";
import { verifySurvivorDeletes } from "./fixtures/survivor-deletes.js";

/**
 * The store contract every backend passes, through the public client only:
 * the scoped-API, bound-scope, context, survivor-delete, duplicate and audit
 * fixtures in ./fixtures/ (which the in-memory backend also runs directly in
 * `unit`), value round trips, chunked writes, search and cross-scope
 * isolation. `mnemocyte/store/test` (store-test.ts) ships it as
 * `describeMemoryStoreContract`; `describeStoreContract` (Postgres,
 * test/contract/suite.ts) and `describeLibsqlContract`
 * (test/contract/libsql.ts) register it next to the checks only their own
 * backend has.
 */

/** The dimensions of every embedding the suite writes. */
export const CONTRACT_DIMENSIONS = 1536;

/**
 * The embedding model of every memory the suite writes. The integration
 * files record the same one, so the suite can share their database.
 */
export const CONTRACT_EMBEDDING_MODEL = "mnemocyte-integration-test";

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

export function createContractEmbedder(): Embedder & { calls: () => number } {
	let calls = 0;
	return {
		model: CONTRACT_EMBEDDING_MODEL,
		dimensions: CONTRACT_DIMENSIONS,
		async embed(texts) {
			calls += 1;
			return texts.map(embedText);
		},
		calls: () => calls,
	};
}

let runCounter = 0;

export function uniqueNamespace(label: string): string {
	runCounter += 1;
	return `contract_${label}_${Date.now()}_${runCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function sortedIds(
	memories: Promise<readonly { id: string }[]>,
): Promise<string[]> {
	return (await memories).map((memory) => memory.id).sort();
}

/** What a store value can be: a store config or a client detected by shape. */
export type ContractStoreInput =
	| MnemocyteStoreConfig
	| PostgresClient
	| LibsqlClient;

/** A client in a namespace of its own, which a first-party harness removes afterwards. */
export interface ContractClient {
	memory: MemoryClient;
	namespace: string;
	embedCalls: () => number;
}

/** How a backend's run gives the shared contract its store. */
export interface SharedContractHarness {
	/** The store value `createMemory` takes, built fresh on each call. */
	storeInput(): ContractStoreInput;
	/** A new client in a fresh namespace the harness records for cleanup. */
	client(label: string, options?: { audit?: boolean }): ContractClient;
	/**
	 * Make the audit inserts of `namespace` fail (`true`) or succeed again
	 * (`false`), with a trigger in the backend's own SQL. Without it the
	 * audit rollback test is skipped.
	 */
	failAuditWrites?: (namespace: string, failing: boolean) => Promise<void>;
	/**
	 * `false` when the store's `migrate` throws `"CONFIG"` because its client
	 * has no interactive transactions (Neon's HTTP driver). Default `true`.
	 */
	migrates?: boolean;
}

/**
 * A `client` for {@link SharedContractHarness}: each call records its
 * namespace in `namespaces`.
 */
export function contractClientFactory(
	storeInput: () => ContractStoreInput,
	namespaces: string[],
): SharedContractHarness["client"] {
	return (label, options = {}) => {
		const namespace = uniqueNamespace(label);
		namespaces.push(namespace);
		const embedder = createContractEmbedder();
		const memory = createMemory({
			store: storeInput(),
			embedder,
			...(options.audit ? { audit: { enabled: true } } : {}),
		});
		return { memory, namespace, embedCalls: embedder.calls };
	};
}

/** Register the shared tests in the caller's `describe`. */
export function registerSharedContract(harness: SharedContractHarness): void {
	const { client, storeInput } = harness;

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

	test("a selective filter keeps the vector list full unless the store declares postfilter", async () => {
		const { memory, namespace } = client("filtered");
		const { capabilities } = readMemoryClientInternals(memory).store;
		const scope: MemoryScope = { namespace, entityId: "alice" };
		// One memory in ten passes the filter. The query shares no word with
		// any memory, so the keyword list is empty and every result comes
		// from the vector list.
		await memory.addMany({
			scope,
			memories: Array.from({ length: 40 }, (_, index) => ({
				content: `filtered probe ${index} about harbour cranes`,
				kind: index % 10 === 0 ? "preference" : "fact",
			})),
		});
		const results = await memory.search({
			scope,
			query: "quay gantry",
			kinds: ["preference"],
			limit: 4,
		});
		expect(results.every((result) => result.kind === "preference")).toBe(true);
		if (capabilities.filteredVectorSearch === "postfilter") {
			// The filter runs after an index scan of the whole table.
			expect(results.length).toBeLessThanOrEqual(4);
		} else {
			expect(results).toHaveLength(4);
		}
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

	test("created filters", async () => {
		const { memory, namespace } = client("created");
		await verifyCreatedFilters(memory, namespace);
	});

	test("default namespace and bound clients", async () => {
		const { memory, namespace } = client("bound");
		await verifyBoundScope({
			memory,
			defaulted: createMemory({
				namespace,
				store: storeInput(),
				embedder: createContractEmbedder(),
				audit: { enabled: true },
			}),
			namespace,
			...(harness.migrates === undefined ? {} : { migrates: harness.migrates }),
		});
	});

	test("context with the memories it used", async () => {
		const { memory, namespace } = client("ctxmem");
		await verifyContextMemories({
			memory,
			defaulted: createMemory({
				namespace,
				store: storeInput(),
				embedder: createContractEmbedder(),
			}),
			namespace,
		});
	});

	test("context tracks access only for the memories in the text", async () => {
		// client() registers the namespace for cleanup; the tracked client
		// needs its own config.
		const { namespace } = client("ctxaccess");
		await verifyContextTracksRenderedMemories({
			createTracked: (onEvent) =>
				createMemory({
					store: storeInput(),
					embedder: createContractEmbedder(),
					retrieval: { trackAccess: true },
					observability: { onEvent },
				}),
			namespace,
		});
	});

	test("survivor-aware deletes", async () => {
		const { memory, namespace } = client("survivors");
		await verifySurvivorDeletes(memory, (entityId, extra = {}) => ({
			namespace,
			entityId,
			...extra,
		}));
	});

	test("nearest-neighbor duplicates", async () => {
		const { memory, namespace } = client("knn");
		await verifyKnnDuplicates(memory, (entityId, extra = {}) => ({
			namespace,
			entityId,
			...extra,
		}));
	});

	test("duplicate pages", async () => {
		const { memory, namespace } = client("pages");
		await verifyDuplicatePages(memory, (entityId, extra = {}) => ({
			namespace,
			entityId,
			...extra,
		}));
	});

	test("audit payloads match the in-memory backend", async () => {
		const { memory, namespace } = client("audit", { audit: true });
		await verifyAuditPayloads(memory, (entityId, extra = {}) => ({
			namespace,
			entityId,
			...extra,
		}));
	});

	test("audit pages", async () => {
		const { memory, namespace } = client("pages", { audit: true });
		const other = client("pages_other").namespace;
		await verifyAuditPages({
			client: memory,
			scopeFor: (entityId, extra = {}) => ({ namespace, entityId, ...extra }),
			otherScopeFor: (entityId, extra = {}) => ({
				namespace: other,
				entityId,
				...extra,
			}),
		});
	});

	test("audit history of one memory", async () => {
		const { memory, namespace } = client("history", { audit: true });
		const other = client("history_other").namespace;
		await verifyAuditMemoryHistory({
			client: memory,
			scopeFor: (entityId, extra = {}) => ({ namespace, entityId, ...extra }),
			otherScopeFor: (entityId, extra = {}) => ({
				namespace: other,
				entityId,
				...extra,
			}),
		});
	});

	test("audit retention", async () => {
		const { memory, namespace } = client("retention", { audit: true });
		const other = client("retention_other").namespace;
		await verifyAuditRetention({
			client: memory,
			scopeFor: (entityId, extra = {}) => ({ namespace, entityId, ...extra }),
			otherScopeFor: (entityId, extra = {}) => ({
				namespace: other,
				entityId,
				...extra,
			}),
			// Other suites share this database.
			allNamespaces: false,
		});
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
			const { memory, scopes, ids } = await seedNeighbours("iso_consolidate", [
				"Isolation probe about rivers.",
				"Isolation probe about lakes.",
			]);
			const [survivor, local] = ids.own;
			for (const foreign of [
				ids.otherEntity[0],
				ids.otherAgent[0],
				ids.otherNamespace[0],
			]) {
				await expectMnemocyteError(
					memory.consolidate({
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
				memory.consolidate({
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
				expect(page.memories.every((item) => item.supersededBy === null)).toBe(
					true,
				);
			}
		});

		test("deleteScope and stats select only their scope", async () => {
			const { memory, namespace, scopes } = await seedNeighbours("iso_erase", [
				"Isolation probe about kites.",
			]);
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

	const { failAuditWrites } = harness;
	test.skipIf(failAuditWrites === undefined)(
		"a failed audit write rolls back every write path",
		async () => {
			const fail = expectDefined(failAuditWrites);
			const { memory, namespace } = client("auditfail", { audit: true });
			await verifyAuditFailureRollsBack(
				memory,
				(entityId, extra = {}) => ({ namespace, entityId, ...extra }),
				(failing) => fail(namespace, failing),
			);
		},
	);
}
