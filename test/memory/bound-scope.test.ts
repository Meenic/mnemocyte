import {
	createMemory,
	type Embedder,
	type MemoryConfig,
	type MnemocyteObservation,
	migrate,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { createMnemocyteStoreConfig } from "../../src/memory/store-config.js";
import { verifyBoundScope } from "../fixtures/bound-scope.js";
import { expectMnemocyteError } from "../helpers.js";

const embedder: Embedder = {
	model: "bound-scope-test",
	dimensions: 3,
	async embed(texts) {
		return texts.map((text) => [text.length, 1, text.charCodeAt(0)]);
	},
};

function recordingClient(namespace = "app") {
	const events: MnemocyteObservation[] = [];
	const memory = createMemory({
		namespace,
		embedder,
		observability: {
			onEvent(event) {
				events.push(event);
			},
		},
	});
	return { memory, events };
}

describe("bound scopes (in-memory)", () => {
	test("default namespace and bound clients", async () => {
		const store = createMnemocyteStoreConfig(createInMemoryStore());
		await verifyBoundScope({
			memory: createMemory({ store, embedder }),
			defaulted: createMemory({
				namespace: "bound",
				store,
				embedder,
				audit: { enabled: true },
			}),
			namespace: "bound",
		});
	});

	test("createMemory rejects a malformed namespace with CONFIG", () => {
		for (const namespace of ["", "   ", "x".repeat(257), 42, null]) {
			expect(() =>
				createMemory({ namespace, embedder } as unknown as MemoryConfig),
			).toThrow(expect.objectContaining({ code: "CONFIG" }));
		}
		expect(() =>
			createMemory({ namespace: "x".repeat(256), embedder }),
		).not.toThrow();
	});

	test("a scope without namespace fails without a default", async () => {
		const memory = createMemory({ embedder });
		await expectMnemocyteError(
			memory.add({ scope: { entityId: "alice" }, content: "x" } as never),
			"VALIDATION",
		);
	});

	test("an explicitly undefined namespace takes the default", async () => {
		const { memory } = recordingClient();
		const added = await memory.add({
			scope: { namespace: undefined, entityId: "alice" } as never,
			content: "Prefers tea.",
		});
		expect(added.scope.namespace).toBe("app");
	});

	test("the caller's input and scope objects are left unchanged", async () => {
		const { memory } = recordingClient();
		const scope = { entityId: "alice" };
		const input = { scope, content: "Prefers tea." };
		await memory.add(input);
		expect(input).toEqual({
			scope: { entityId: "alice" },
			content: "Prefers tea.",
		});
		expect(scope).toEqual({ entityId: "alice" });

		const bound = memory.for(scope);
		const boundInput = { content: "Prefers coffee." };
		await bound.add(boundInput);
		expect(boundInput).toEqual({ content: "Prefers coffee." });
	});

	test("events carry the default namespace and the bound scope", async () => {
		const { memory, events } = recordingClient();
		await memory.add({ scope: { entityId: "alice" }, content: "Prefers tea." });
		const bound = memory.for({ entityId: "bob" });
		await bound.search({ query: "tea" });
		await expectMnemocyteError(
			bound.list({ scope: { entityId: "alice" } } as never),
			"VALIDATION",
		);

		const summary = events
			.filter((event) => event.operation !== "trackAccess")
			.map((event) => [
				event.operation,
				event.phase,
				event.namespace,
				event.entityId,
			]);
		expect(summary).toEqual([
			["add", "start", "app", "alice"],
			["add", "success", "app", "alice"],
			["search", "start", "app", "bob"],
			["search", "success", "app", "bob"],
			["list", "start", "app", "bob"],
			["list", "error", "app", "bob"],
		]);
	});

	test("for() snapshots the scope it was given", async () => {
		const { memory } = recordingClient();
		const scope = { entityId: "alice", agentId: "agent-a" };
		const bound = memory.for(scope);
		scope.entityId = "bob";
		const added = await bound.add({ content: "Prefers tea." });
		expect(added.scope).toMatchObject({
			entityId: "alice",
			agentId: "agent-a",
		});
		expect(bound.scope).toEqual({
			namespace: "app",
			entityId: "alice",
			agentId: "agent-a",
		});
	});

	test("consolidate runs at the bound scope", async () => {
		const { memory } = recordingClient();
		const alice = memory.for({ entityId: "alice" });
		const bob = memory.for({ entityId: "bob" });
		const survivor = await alice.add({ content: "Prefers tea.", tags: ["a"] });
		const duplicate = await alice.add({ content: "Likes tea.", tags: ["b"] });

		await expectMnemocyteError(
			bob.consolidate({
				survivorId: survivor.id,
				supersededIds: [duplicate.id],
			}),
			"NOT_FOUND",
		);
		await expect(
			alice.consolidate({
				survivorId: survivor.id,
				supersededIds: [duplicate.id],
			}),
		).resolves.toMatchObject({ supersededCount: 1 });
		await expect(alice.get({ id: survivor.id })).resolves.toMatchObject({
			tags: ["a", "b"],
		});
	});

	test("bound clients keep the store out of their own keys", async () => {
		const { memory } = recordingClient();
		const bound = memory.for({ entityId: "alice" });
		expect(Object.keys(bound).sort()).toEqual(
			[
				"add",
				"addMany",
				"consolidate",
				"context",
				"delete",
				"deleteScope",
				"experimental",
				"findDuplicates",
				"get",
				"list",
				"listAuditLog",
				"prune",
				"pruneAuditLog",
				"scope",
				"search",
				"stats",
				"update",
			].sort(),
		);
		expect("for" in bound).toBe(false);
		await expect(migrate({ memory: bound })).resolves.toEqual({
			applied: [],
			adopted: [],
			extensionCreated: false,
		});
	});
});
