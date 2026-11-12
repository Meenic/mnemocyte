import {
	createMemory,
	type MnemocyteObservation,
	type PruneInput,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createMemoryClient } from "../../src/memory/client-core.js";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { expectMnemocyteError, testScope } from "../helpers.js";

describe("prune", () => {
	test("rejects malformed fields before the store can prune", async () => {
		const baseStore = createInMemoryStore();
		let pruneCalls = 0;
		const client = createMemoryClient(
			{
				embedder: {
					model: "prune-validation-test",
					dimensions: 2,
					async embed(texts) {
						return texts.map((text) => [text.length, 1]);
					},
				},
			},
			{
				...baseStore,
				async prune(filter, options) {
					pruneCalls += 1;
					return baseStore.prune(filter, options);
				},
			},
		);
		const alice = testScope("alice");
		const future = new Date(Date.now() + 60_000);
		const malformedInputs: unknown[] = [
			{ expired: true },
			{ scope: alice, allNamespaces: true, expired: true },
			{ allNamespaces: false, expired: true },
			{ scope: {}, expired: true },
			{ scope: { namespace: " " }, expired: true },
			{ scope: { namespace: "test", entityId: "" }, expired: true },
			{ scope: { namespace: "test", agentId: 1 }, expired: true },
			{ scope: alice, createdBefore: new Date("invalid") },
			{ scope: alice, notAccessedSince: new Date("invalid") },
			{ scope: alice, createdBefore: "2026-01-01" },
			{ scope: alice, notAccessedSince: 0 },
			{ scope: alice, maxImportance: "bogus" },
			{ scope: alice, kinds: ["bogus"] },
			{ scope: alice, kinds: "fact" },
			{ scope: alice, tags: [""] },
			{ scope: alice, tags: [1] },
			{ scope: alice, tags: "tag" },
			{ scope: alice, expired: "true" },
			{ scope: alice, superseded: 1 },
			{ scope: alice, createdBefore: future, dryRun: "false" },
			{ scope: alice, createdBefore: future, signal: {} },
			{ scope: alice },
			{ scope: alice, expired: false },
			{ scope: alice, superseded: false },
			{ scope: alice, kinds: [] },
			{ scope: alice, tags: [] },
			{ scope: alice, dryRun: true },
		];

		await client.add({ scope: alice, content: "one" });
		await client.add({ scope: testScope("bob"), content: "two" });

		for (const input of malformedInputs) {
			await expectMnemocyteError(
				client.prune(input as PruneInput),
				"VALIDATION",
			);
			expect(pruneCalls).toBe(0);
			await expect(
				client.stats({ allNamespaces: true }),
			).resolves.toMatchObject({ memoryCount: 2 });
		}
	});

	test("normalizes valid tag selectors before pruning", async () => {
		const client = createMemory({
			embedder: {
				model: "prune-normalization-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) => [text.length, 1]);
				},
			},
		});

		await client.add({
			scope: testScope("alice"),
			content: "tagged",
			tags: ["spam"],
		});
		const result = await client.prune({
			scope: { namespace: "test" },
			tags: [" spam ", "spam"],
			dryRun: true,
		});
		expect(result).toEqual({
			matchedCount: 1,
			deletedCount: 0,
			dryRun: true,
		});
	});

	test("validates and deletes selected memories", async () => {
		function createClient() {
			return createMemory({
				embedder: {
					model: "prune-test",
					dimensions: 2,
					async embed(texts) {
						return texts.map((text) => [text.length % 7, 1]);
					},
				},
			});
		}

		const future = () => new Date(Date.now() + 60_000);

		// 1. Empty input is rejected with VALIDATION.
		{
			const client = createClient();
			await expectMnemocyteError(client.prune({} as PruneInput), "VALIDATION");
		}

		// 2. A scope limits the prune to that entity's memories.
		{
			const client = createClient();
			await client.add({ scope: testScope("alice"), content: "alice-1" });
			await client.add({ scope: testScope("alice"), content: "alice-2" });
			await client.add({ scope: testScope("bob"), content: "bob-1" });
			const result = await client.prune({
				scope: testScope("alice"),
				createdBefore: future(),
			});
			expect(result.dryRun).toBe(false);
			expect(result.matchedCount).toBe(2);
			expect(result.deletedCount).toBe(2);
			const aliceStats = await client.stats({ scope: testScope("alice") });
			const bobStats = await client.stats({ scope: testScope("bob") });
			expect(aliceStats.memoryCount).toBe(0);
			expect(bobStats.memoryCount).toBe(1);
		}

		// 3. dryRun reports matches without deleting.
		{
			const client = createClient();
			await client.add({ scope: testScope("carol"), content: "c-1" });
			await client.add({ scope: testScope("carol"), content: "c-2" });
			const result = await client.prune({
				scope: testScope("carol"),
				createdBefore: future(),
				dryRun: true,
			});
			expect(result.dryRun).toBe(true);
			expect(result.matchedCount).toBe(2);
			expect(result.deletedCount).toBe(0);
			const stats = await client.stats({ scope: testScope("carol") });
			expect(stats.memoryCount).toBe(2);
		}

		// 4. Prune by expired only removes memories whose expiresAt has passed.
		{
			const client = createClient();
			await client.add({
				scope: testScope("dave"),
				content: "fresh",
			});
			await client.add({
				scope: testScope("dave"),
				content: "stale",
				expiresAt: new Date(Date.now() - 60_000),
			});
			const result = await client.prune({
				scope: testScope("dave"),
				expired: true,
			});
			expect(result.matchedCount).toBe(1);
			expect(result.deletedCount).toBe(1);
			const stats = await client.stats({ scope: testScope("dave") });
			expect(stats.memoryCount).toBe(1);
		}

		// 5. Prune by maxImportance keeps high/critical memories.
		{
			const client = createClient();
			await client.add({
				scope: testScope("erin"),
				content: "low",
				importance: "low",
			});
			await client.add({
				scope: testScope("erin"),
				content: "normal",
				importance: "normal",
			});
			await client.add({
				scope: testScope("erin"),
				content: "high",
				importance: "high",
			});
			await client.add({
				scope: testScope("erin"),
				content: "critical",
				importance: "critical",
			});
			const result = await client.prune({
				scope: testScope("erin"),
				maxImportance: "normal",
			});
			expect(result.deletedCount).toBe(2);
			const stats = await client.stats({ scope: testScope("erin") });
			expect(stats.memoryCount).toBe(2);
		}

		// 6. Prune by createdBefore + kinds.
		{
			const client = createClient();
			// Older memory: insert and then manually backdate via prune filter.
			// We simulate "before" by using a near-future cutoff and combine with type.
			await client.add({
				scope: testScope("frank"),
				content: "session-old",
				kind: "session",
			});
			await client.add({
				scope: testScope("frank"),
				content: "fact-keep",
				kind: "fact",
			});
			const result = await client.prune({
				scope: testScope("frank"),
				createdBefore: new Date(Date.now() + 60_000),
				kinds: ["session"],
			});
			expect(result.deletedCount).toBe(1);
			const stats = await client.stats({ scope: testScope("frank") });
			expect(stats.memoryCount).toBe(1);
		}

		// 7. Prune by tags requires ALL listed tags.
		{
			const client = createClient();
			await client.add({
				scope: testScope("grace"),
				content: "both",
				tags: ["spam", "old"],
			});
			await client.add({
				scope: testScope("grace"),
				content: "one",
				tags: ["spam"],
			});
			const result = await client.prune({
				scope: testScope("grace"),
				tags: ["spam", "old"],
			});
			expect(result.deletedCount).toBe(1);
			const stats = await client.stats({ scope: testScope("grace") });
			expect(stats.memoryCount).toBe(1);
		}

		// 8. Prune emits an observability event with deletedCount.
		{
			const events: MnemocyteObservation[] = [];
			const client = createMemory({
				embedder: {
					model: "prune-observability",
					dimensions: 2,
					async embed(texts: readonly string[]) {
						return texts.map((text) => [text.length, 1]);
					},
				},
				observability: {
					onEvent(event) {
						events.push(event);
					},
				},
			});
			await client.add({ scope: testScope("henry"), content: "x" });
			await client.prune({
				scope: testScope("henry"),
				createdBefore: future(),
			});
			const pruneSuccess = events.find(
				(event) => event.operation === "prune" && event.phase === "success",
			);
			expect(pruneSuccess?.namespace).toBe("test");
			expect(pruneSuccess?.entityId).toBe("henry");
			expect(pruneSuccess?.count).toBe(1);
		}
	});
});

describe("prune scope selectors", () => {
	function createClient() {
		return createMemory({
			embedder: {
				model: "prune-scope-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) => [text.length % 7, 1]);
				},
			},
		});
	}

	test("a namespace scope covers every entity in it and no other namespace", async () => {
		const client = createClient();
		const expiresAt = new Date(Date.now() - 60_000);
		await client.add({ scope: testScope("a"), content: "a", expiresAt });
		await client.add({ scope: testScope("b"), content: "b", expiresAt });
		await client.add({
			scope: { namespace: "other", entityId: "a" },
			content: "other",
			expiresAt,
		});
		const result = await client.prune({
			scope: { namespace: "test" },
			expired: true,
		});
		expect(result.deletedCount).toBe(2);
		await expect(
			client.stats({ scope: { namespace: "other" } }),
		).resolves.toMatchObject({ memoryCount: 1 });
	});

	test("an agent or session in the scope matches exactly, not shared rows", async () => {
		const client = createClient();
		const scope = testScope("alice");
		const expiresAt = new Date(Date.now() - 60_000);
		await client.add({ scope, content: "shared", expiresAt });
		await client.add({
			scope: { ...scope, agentId: "a" },
			content: "agent a",
			expiresAt,
		});
		await client.add({
			scope: { ...scope, agentId: "b", sessionId: "s" },
			content: "agent b session",
			expiresAt,
		});
		await expect(
			client.prune({ scope: { ...scope, agentId: "a" }, expired: true }),
		).resolves.toMatchObject({ deletedCount: 1 });
		await expect(
			client.prune({ scope: { ...scope, sessionId: "s" }, expired: true }),
		).resolves.toMatchObject({ deletedCount: 1 });
		await expect(client.stats({ scope })).resolves.toMatchObject({
			memoryCount: 1,
		});
	});

	test("allNamespaces covers the whole installation", async () => {
		const client = createClient();
		await client.add({ scope: testScope("a"), content: "a", kind: "session" });
		await client.add({
			scope: { namespace: "other", entityId: "a" },
			content: "b",
			kind: "session",
		});
		await expect(
			client.prune({ allNamespaces: true, kinds: ["session"], dryRun: true }),
		).resolves.toMatchObject({ matchedCount: 2 });
	});
});
