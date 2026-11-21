import {
	createMemory,
	type Embedder,
	MnemocyteError,
	type MnemocyteObservation,
	migrate,
	setTextSearchConfig,
} from "mnemocyte";
import { defineMemoryStore, type MemoryStoreV1 } from "mnemocyte/store";
import { describe, expect, test, vi } from "vitest";
import { readMemoryClientInternals } from "../../src/memory/client-internals.js";
import { isMnemocyteStoreConfig } from "../../src/memory/store-config.js";
import { expectMnemocyteError, testScope } from "../helpers.js";
import { inMemoryStoreV1 } from "./in-memory-v1.js";

const embedder: Embedder = {
	model: "define-store",
	dimensions: 2,
	async embed(texts) {
		return texts.map((text) => [text.length % 5, 1]);
	},
};

function expectConfigError(run: () => unknown, message: RegExp): void {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(MnemocyteError);
		expect(error).toMatchObject({ code: "CONFIG", reason: "INVALID_OPTION" });
		expect((error as MnemocyteError).message).toMatch(message);
		return;
	}
	throw new Error("Expected a CONFIG error.");
}

describe("defineMemoryStore", () => {
	test("returns a store config createMemory takes, reported as custom", async () => {
		const events: MnemocyteObservation[] = [];
		const config = defineMemoryStore({ store: inMemoryStoreV1() });
		expect(isMnemocyteStoreConfig(config)).toBe(true);
		const memory = createMemory({
			store: config,
			embedder,
			observability: {
				onEvent: (event) => {
					events.push(event);
				},
			},
		});
		const added = await memory.add({ scope: testScope("a"), content: "hi" });
		await expect(
			memory.get({ scope: testScope("a"), id: added.id }),
		).resolves.toEqual(added);
		expect(events.length).toBeGreaterThan(0);
		expect(events.every((event) => event.backend === "custom")).toBe(true);
		const { store } = readMemoryClientInternals(memory);
		expect(store.backend).toBe("custom");
		expect(store.custom).toEqual({ name: "in-memory-v1", migrates: true });
	});

	test("checks the version", () => {
		const store = { ...inMemoryStoreV1(), specificationVersion: "v2" };
		expectConfigError(
			() => defineMemoryStore({ store: store as unknown as MemoryStoreV1 }),
			/specificationVersion is "v2".*supports "v1"/,
		);
		const { specificationVersion: _, ...unversioned } = inMemoryStoreV1();
		expectConfigError(
			() =>
				defineMemoryStore({ store: unversioned as unknown as MemoryStoreV1 }),
			/specificationVersion must be "v1"/,
		);
	});

	test("checks the name, capabilities and methods", () => {
		const base = inMemoryStoreV1();
		const cases: [Record<string, unknown>, RegExp][] = [
			[{ name: " " }, /store\.name/],
			[{ capabilities: null }, /store\.capabilities must be an object/],
			[
				{ capabilities: { ...base.capabilities, lexicalSearch: "fuzzy" } },
				/capabilities\.lexicalSearch must be one of/,
			],
			[
				{ capabilities: { ...base.capabilities, maxDimensions: 0 } },
				/maxDimensions/,
			],
			[
				{ capabilities: { ...base.capabilities, maxDimensions: 1.5 } },
				/maxDimensions/,
			],
			[{ stats: undefined }, /store\.stats must be a function/],
			[{ migrate: "yes" }, /store\.migrate must be a function when set/],
		];
		for (const [patch, message] of cases) {
			const store = { ...base, ...patch } as unknown as MemoryStoreV1;
			expectConfigError(() => defineMemoryStore({ store }), message);
		}
		expectConfigError(
			() => defineMemoryStore(undefined as unknown as { store: MemoryStoreV1 }),
			/store must be an object/,
		);
		expectConfigError(
			() =>
				defineMemoryStore({ store: base, extra: true } as unknown as {
					store: MemoryStoreV1;
				}),
			/does not accept the option "extra"/,
		);
	});

	test("keeps a class-based store's this", async () => {
		const inner = inMemoryStoreV1();
		class ClassStore implements MemoryStoreV1 {
			readonly specificationVersion = "v1" as const;
			readonly name = "class";
			readonly capabilities = inner.capabilities;
			#inner = inner;
			insert(input: Parameters<MemoryStoreV1["insert"]>[0]) {
				return this.#inner.insert(input);
			}
			searchCandidates(
				input: Parameters<MemoryStoreV1["searchCandidates"]>[0],
			) {
				return this.#inner.searchCandidates(input);
			}
			get(input: Parameters<MemoryStoreV1["get"]>[0]) {
				return this.#inner.get(input);
			}
			list(input: Parameters<MemoryStoreV1["list"]>[0]) {
				return this.#inner.list(input);
			}
			update(input: Parameters<MemoryStoreV1["update"]>[0]) {
				return this.#inner.update(input);
			}
			markAccessed(input: Parameters<MemoryStoreV1["markAccessed"]>[0]) {
				return this.#inner.markAccessed(input);
			}
			delete(input: Parameters<MemoryStoreV1["delete"]>[0]) {
				return this.#inner.delete(input);
			}
			consolidate(input: Parameters<MemoryStoreV1["consolidate"]>[0]) {
				return this.#inner.consolidate(input);
			}
			findDuplicates(input: Parameters<MemoryStoreV1["findDuplicates"]>[0]) {
				return this.#inner.findDuplicates(input);
			}
			listAudit(input: Parameters<MemoryStoreV1["listAudit"]>[0]) {
				return this.#inner.listAudit(input);
			}
			pruneAudit(input: Parameters<MemoryStoreV1["pruneAudit"]>[0]) {
				return this.#inner.pruneAudit(input);
			}
			stats(input: Parameters<MemoryStoreV1["stats"]>[0]) {
				return this.#inner.stats(input);
			}
		}
		const memory = createMemory({
			store: defineMemoryStore({ store: new ClassStore() }),
			embedder,
		});
		await memory.add({ scope: testScope("a"), content: "kept" });
		await expect(
			memory.stats({ scope: testScope("a") }),
		).resolves.toMatchObject({ memoryCount: 1 });
	});
});

describe("the core's answers for a V1 store", () => {
	test("migrate() runs the store's migrate, or applies nothing without one", async () => {
		const store = inMemoryStoreV1();
		const spy = vi.fn(store.migrate);
		const config = defineMemoryStore({ store: { ...store, migrate: spy } });
		await migrate({ store: config, dimensions: 2, dryRun: true });
		expect(spy).toHaveBeenCalledWith({ dimensions: 2, dryRun: true });

		const bare = defineMemoryStore({
			store: inMemoryStoreV1({ withOptionalMethods: false }),
		});
		await expect(migrate({ store: bare, dimensions: 2 })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
			schemaCreated: false,
		});
	});

	test("migrate() checks dimensions against the store's maxDimensions", async () => {
		const store = inMemoryStoreV1();
		const config = defineMemoryStore({
			store: {
				...store,
				capabilities: { ...store.capabilities, maxDimensions: 8 },
			},
		});
		await expectMnemocyteError(
			migrate({ store: config, dimensions: 9 }),
			"VALIDATION",
		);
	});

	test("setTextSearchConfig() changes nothing", async () => {
		const config = defineMemoryStore({ store: inMemoryStoreV1() });
		await expect(
			setTextSearchConfig({ store: config, textSearchConfig: "simple" }),
		).resolves.toEqual({ previous: null, current: null, changed: false });
	});

	test("the store's ensureEmbeddingCompatibility guards embedding calls", async () => {
		const refusal = new MnemocyteError({
			message: "wrong model",
			code: "CONFIG",
			reason: "MODEL_MISMATCH",
		});
		const store = inMemoryStoreV1();
		const memory = createMemory({
			store: defineMemoryStore({
				store: {
					...store,
					ensureEmbeddingCompatibility: async () => {
						throw refusal;
					},
				},
			}),
			embedder,
		});
		await expect(
			memory.add({ scope: testScope("a"), content: "refused" }),
		).rejects.toBe(refusal);
		const bare = createMemory({
			store: defineMemoryStore({
				store: inMemoryStoreV1({ withOptionalMethods: false }),
			}),
			embedder,
		});
		await expect(
			bare.add({ scope: testScope("a"), content: "accepted" }),
		).resolves.toMatchObject({ content: "accepted" });
	});

	test("each client gets frozen capabilities of its own", () => {
		const config = defineMemoryStore({ store: inMemoryStoreV1() });
		const first = readMemoryClientInternals(
			createMemory({ store: config, embedder }),
		).store;
		const second = readMemoryClientInternals(
			createMemory({ store: config, embedder }),
		).store;
		expect(first.capabilities).toEqual(second.capabilities);
		expect(first.capabilities).not.toBe(second.capabilities);
		expect(Object.isFrozen(first.capabilities)).toBe(true);
	});
});
