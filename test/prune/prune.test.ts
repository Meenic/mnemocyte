import { createMnemocyte, type MnemocyteObservation } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

describe("prune", () => {
	test("validates and deletes selected memories", async () => {
		function createClient() {
			return createMnemocyte({
				embedder: {
					model: "prune-test",
					dimensions: 2,
					async embed(texts) {
						return texts.map((text) => [text.length % 7, 1]);
					},
				},
			});
		}

		// 1. Empty input is rejected with VALIDATION.
		{
			const client = createClient();
			try {
				await expectMnemocyteError(client.prune({}), "VALIDATION");
			} finally {
				await client.close();
			}
		}

		// 2. Prune by entityId removes only that entity's memories.
		{
			const client = createClient();
			try {
				await client.remember({ entityId: "alice", content: "alice-1" });
				await client.remember({ entityId: "alice", content: "alice-2" });
				await client.remember({ entityId: "bob", content: "bob-1" });
				const result = await client.prune({ entityId: "alice" });
				expect(result.dryRun).toBe(false);
				expect(result.matchedCount).toBe(2);
				expect(result.deletedCount).toBe(2);
				const aliceStats = await client.stats({ entityId: "alice" });
				const bobStats = await client.stats({ entityId: "bob" });
				expect(aliceStats.memoryCount).toBe(0);
				expect(bobStats.memoryCount).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 3. dryRun reports matches without deleting.
		{
			const client = createClient();
			try {
				await client.remember({ entityId: "carol", content: "c-1" });
				await client.remember({ entityId: "carol", content: "c-2" });
				const result = await client.prune({
					entityId: "carol",
					dryRun: true,
				});
				expect(result.dryRun).toBe(true);
				expect(result.matchedCount).toBe(2);
				expect(result.deletedCount).toBe(0);
				const stats = await client.stats({ entityId: "carol" });
				expect(stats.memoryCount).toBe(2);
			} finally {
				await client.close();
			}
		}

		// 4. Prune by expired only removes memories whose expiresAt has passed.
		{
			const client = createClient();
			try {
				await client.remember({
					entityId: "dave",
					content: "fresh",
				});
				await client.remember({
					entityId: "dave",
					content: "stale",
					expiresAt: new Date(Date.now() - 60_000),
				});
				const result = await client.prune({ entityId: "dave", expired: true });
				expect(result.matchedCount).toBe(1);
				expect(result.deletedCount).toBe(1);
				const stats = await client.stats({ entityId: "dave" });
				expect(stats.memoryCount).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 5. Prune by maxImportance keeps high/critical memories.
		{
			const client = createClient();
			try {
				await client.remember({
					entityId: "erin",
					content: "low",
					importance: "low",
				});
				await client.remember({
					entityId: "erin",
					content: "normal",
					importance: "normal",
				});
				await client.remember({
					entityId: "erin",
					content: "high",
					importance: "high",
				});
				await client.remember({
					entityId: "erin",
					content: "critical",
					importance: "critical",
				});
				const result = await client.prune({
					entityId: "erin",
					maxImportance: "normal",
				});
				expect(result.deletedCount).toBe(2);
				const stats = await client.stats({ entityId: "erin" });
				expect(stats.memoryCount).toBe(2);
			} finally {
				await client.close();
			}
		}

		// 6. Prune by createdBefore + types.
		{
			const client = createClient();
			try {
				// Older memory: insert and then manually backdate via prune filter.
				// We simulate "before" by using a near-future cutoff and combine with type.
				await client.remember({
					entityId: "frank",
					content: "session-old",
					type: "session",
				});
				await client.remember({
					entityId: "frank",
					content: "fact-keep",
					type: "fact",
				});
				const result = await client.prune({
					entityId: "frank",
					createdBefore: new Date(Date.now() + 60_000),
					types: ["session"],
				});
				expect(result.deletedCount).toBe(1);
				const stats = await client.stats({ entityId: "frank" });
				expect(stats.memoryCount).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 7. Prune by tags requires ALL listed tags.
		{
			const client = createClient();
			try {
				await client.remember({
					entityId: "grace",
					content: "both",
					tags: ["spam", "old"],
				});
				await client.remember({
					entityId: "grace",
					content: "one",
					tags: ["spam"],
				});
				const result = await client.prune({
					entityId: "grace",
					tags: ["spam", "old"],
				});
				expect(result.deletedCount).toBe(1);
				const stats = await client.stats({ entityId: "grace" });
				expect(stats.memoryCount).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 8. Prune emits an observability event with deletedCount.
		{
			const events: MnemocyteObservation[] = [];
			const client = createMnemocyte({
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
			try {
				await client.remember({ entityId: "henry", content: "x" });
				await client.prune({ entityId: "henry" });
				const pruneSuccess = events.find(
					(event) => event.operation === "prune" && event.phase === "success",
				);
				expect(pruneSuccess?.entityId).toBe("henry");
				expect(pruneSuccess?.count).toBe(1);
			} finally {
				await client.close();
			}
		}
	});
});
