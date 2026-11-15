import {
	type BoundMemoryClient,
	createMemory,
	type Embedder,
	type MemoryScope,
	type MnemocyteObservation,
	type MnemocyteOperation,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

const embedder: Embedder = {
	model: "observability-scope-fields",
	dimensions: 2,
	async embed(texts) {
		return texts.map((text) => [text.length, 1]);
	},
};

function recordingConfig(events: MnemocyteObservation[]) {
	return {
		embedder,
		audit: { enabled: true },
		retrieval: { trackAccess: true },
		observability: {
			onEvent(event: MnemocyteObservation) {
				events.push(event);
			},
		},
	};
}

function recordingClient() {
	const events: MnemocyteObservation[] = [];
	return { memory: createMemory(recordingConfig(events)), events };
}

/** A client created with a default namespace. */
function recordingDefaultedClient(namespace: string) {
	const events: MnemocyteObservation[] = [];
	const memory = createMemory({ ...recordingConfig(events), namespace });
	return { memory, events };
}

const everyScopedOperation: MnemocyteOperation[] = [
	"add",
	"addMany",
	"search",
	"get",
	"list",
	"update",
	"delete",
	"deleteScope",
	"context",
	"contextWithMemories",
	"prune",
	"findDuplicates",
	"findDuplicatesPage",
	"listAuditLog",
	"pruneAuditLog",
	"consolidate",
	"stats",
	"trackAccess",
];

/** Runs every scoped operation once through a bound client. */
async function exercise(bound: BoundMemoryClient): Promise<void> {
	const first = await bound.add({ content: "Prefers green tea." });
	const [second, third] = await bound.addMany({
		memories: [{ content: "Prefers green tea!" }, { content: "Likes cats." }],
	});
	if (second === undefined || third === undefined) {
		throw new Error("addMany returned too few memories");
	}
	await bound.search({ query: "green tea" });
	// The access write starts before search resolves; let it settle.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await bound.get({ id: first.id });
	await bound.list();
	await bound.update({ id: third.id, importance: "high" });
	await bound.context({ query: "tea" });
	await bound.experimental.contextWithMemories({ query: "tea" });
	await bound.findDuplicates();
	await bound.experimental.findDuplicatesPage();
	await bound.consolidate({ survivorId: first.id, supersededIds: [second.id] });
	await bound.prune({ expired: true, dryRun: true });
	await bound.listAuditLog();
	await bound.pruneAuditLog({ before: new Date(0), dryRun: true });
	await bound.stats();
	await bound.delete({ id: third.id });
	await bound.deleteScope();
}

function scopeFields(event: MnemocyteObservation) {
	return {
		namespace: event.namespace,
		entityId: event.entityId,
		agentId: event.agentId,
		sessionId: event.sessionId,
	};
}

function expectEveryEvent(
	events: readonly MnemocyteObservation[],
	expected: ReturnType<typeof scopeFields>,
): void {
	expect(new Set(events.map((event) => event.operation))).toEqual(
		new Set(everyScopedOperation),
	);
	for (const event of events) {
		expect({ operation: event.operation, ...scopeFields(event) }).toEqual({
			operation: event.operation,
			...expected,
		});
	}
}

describe("scope fields on observability events", () => {
	const full: MemoryScope = {
		namespace: "app",
		entityId: "alice",
		agentId: "planner",
		sessionId: "chat-1",
	};

	test("every operation reports agentId and sessionId with the scope", async () => {
		const { memory, events } = recordingClient();
		await exercise(memory.for(full));
		// The bound client calls the core with its scope, so these are the
		// core's events, read from the input's scope.
		expectEveryEvent(events, {
			namespace: "app",
			entityId: "alice",
			agentId: "planner",
			sessionId: "chat-1",
		});
	});

	test("the default-namespace client reports the filled-in namespace", async () => {
		const { memory, events } = recordingDefaultedClient("tenant");
		await exercise(
			memory.for({ entityId: "alice", agentId: "planner", sessionId: "s" }),
		);
		expectEveryEvent(events, {
			namespace: "tenant",
			entityId: "alice",
			agentId: "planner",
			sessionId: "s",
		});

		events.length = 0;
		await memory.add({
			scope: { entityId: "bob", agentId: "writer" },
			content: "Unbound call.",
		});
		expect(events.map(scopeFields)).toEqual([
			{
				namespace: "tenant",
				entityId: "bob",
				agentId: "writer",
				sessionId: undefined,
			},
			{
				namespace: "tenant",
				entityId: "bob",
				agentId: "writer",
				sessionId: undefined,
			},
		]);
	});

	test("a scope without agent or session leaves both fields out", async () => {
		const { memory, events } = recordingClient();
		await exercise(memory.for({ namespace: "app", entityId: "alice" }));
		expectEveryEvent(events, {
			namespace: "app",
			entityId: "alice",
			agentId: undefined,
			sessionId: undefined,
		});
		// Absent, not undefined or null: trackAccess reads a stored scope
		// whose agent and session are null.
		for (const event of events) {
			expect(Object.keys(event)).not.toContain("agentId");
			expect(Object.keys(event)).not.toContain("sessionId");
		}
	});

	test("unbound calls report the scope they name", async () => {
		const { memory, events } = recordingClient();
		const added = await memory.add({ scope: full, content: "Unbound." });
		await memory.get({ scope: full, id: added.id });
		await memory.stats({
			scope: { namespace: "app", sessionId: "chat-1" },
		});
		await memory.prune({
			scope: { namespace: "app", entityId: "alice", agentId: "planner" },
			expired: true,
			dryRun: true,
		});
		expect(
			events.map((event) => [
				event.operation,
				...Object.values(scopeFields(event)),
			]),
		).toEqual([
			["add", "app", "alice", "planner", "chat-1"],
			["add", "app", "alice", "planner", "chat-1"],
			["get", "app", "alice", "planner", "chat-1"],
			["get", "app", "alice", "planner", "chat-1"],
			["stats", "app", undefined, undefined, "chat-1"],
			["stats", "app", undefined, undefined, "chat-1"],
			["prune", "app", "alice", "planner", undefined],
			["prune", "app", "alice", "planner", undefined],
		]);
	});

	test("calls across namespaces report no scope", async () => {
		const { memory, events } = recordingClient();
		await memory.stats({ allNamespaces: true });
		await memory.pruneAuditLog({
			allNamespaces: true,
			before: new Date(0),
			dryRun: true,
		});
		expect(events).toHaveLength(4);
		for (const event of events) {
			expect(scopeFields(event)).toEqual({
				namespace: undefined,
				entityId: undefined,
				agentId: undefined,
				sessionId: undefined,
			});
		}
	});

	test("failed calls still report agentId and sessionId", async () => {
		const { memory, events } = recordingClient();
		await expectMnemocyteError(
			memory.add({ scope: full, content: "" }),
			"VALIDATION",
		);
		// A malformed scope reports the fields that are strings.
		await expectMnemocyteError(
			memory.search({
				scope: { ...full, entityId: 42, sessionId: null },
				query: "x",
			} as never),
			"VALIDATION",
		);
		// A bound client rejects a scope field before calling the core.
		await expectMnemocyteError(
			memory.for(full).list({ scope: full } as never),
			"VALIDATION",
		);
		expect(
			events.map((event) => [
				event.operation,
				event.phase,
				...Object.values(scopeFields(event)),
			]),
		).toEqual([
			["add", "start", "app", "alice", "planner", "chat-1"],
			["add", "error", "app", "alice", "planner", "chat-1"],
			["search", "start", "app", undefined, "planner", undefined],
			["search", "error", "app", undefined, "planner", undefined],
			["list", "start", "app", "alice", "planner", "chat-1"],
			["list", "error", "app", "alice", "planner", "chat-1"],
		]);
	});
});
