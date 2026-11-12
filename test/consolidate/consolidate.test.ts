import type {
	MemoryConfig,
	MnemocyteErrorCode,
	MnemocyteObservation,
} from "mnemocyte";
import { createMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectDefined, expectMnemocyteError, testScope } from "../helpers.js";

describe("consolidate", () => {
	test("validates and consolidates duplicate memories", async () => {
		function createClient(extra: Partial<MemoryConfig> = {}) {
			return createMemory({
				embedder: {
					model: "consolidate-test",
					dimensions: 2,
					async embed(texts: readonly string[]) {
						return texts.map((text) => [text.length % 5, 1]);
					},
				},
				...extra,
			});
		}

		async function expectError(
			code: MnemocyteErrorCode,
			action: () => Promise<unknown>,
		) {
			await expectMnemocyteError(action(), code);
		}

		// 1. Empty supersededIds → VALIDATION.
		{
			const client = createClient();
			const survivor = await client.add({
				scope: testScope("alice"),
				content: "coffee",
			});
			await expectError("VALIDATION", () =>
				client.experimental.consolidate({
					scope: testScope("alice"),
					survivorId: survivor.id,
					supersededIds: [],
				}),
			);
		}

		// 2. survivorId appearing in supersededIds → VALIDATION.
		{
			const client = createClient();
			const survivor = await client.add({
				scope: testScope("alice"),
				content: "coffee",
			});
			await expectError("VALIDATION", () =>
				client.experimental.consolidate({
					scope: testScope("alice"),
					survivorId: survivor.id,
					supersededIds: [survivor.id],
				}),
			);
		}

		// 3. Unknown survivor → NOT_FOUND.
		{
			const client = createClient();
			const other = await client.add({
				scope: testScope("alice"),
				content: "x",
			});
			await expectError("NOT_FOUND", () =>
				client.experimental.consolidate({
					scope: testScope("alice"),
					survivorId: "mem_nope",
					supersededIds: [other.id],
				}),
			);
		}

		// 4. Unknown / cross-entity superseded → NOT_FOUND.
		{
			const client = createClient();
			const aliceMem = await client.add({
				scope: testScope("alice"),
				content: "a",
			});
			const bobMem = await client.add({
				scope: testScope("bob"),
				content: "b",
			});
			await expectError("NOT_FOUND", () =>
				client.experimental.consolidate({
					scope: testScope("alice"),
					survivorId: aliceMem.id,
					supersededIds: ["mem_nope"],
				}),
			);
			await expectError("NOT_FOUND", () =>
				client.experimental.consolidate({
					scope: testScope("alice"),
					survivorId: aliceMem.id,
					supersededIds: [bobMem.id],
				}),
			);
		}

		// 5. Successful merge: losers get supersededBy + supersededAt, survivor unchanged.
		{
			const client = createClient();
			const survivor = await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
			});
			const loser = await client.add({
				scope: testScope("alice"),
				content: "coffee early",
			});
			expect(survivor.supersededAt).toBe(null);
			expect(loser.supersededAt).toBe(null);
			const result = await client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: survivor.id,
				supersededIds: [loser.id],
			});
			expect(result.survivorId).toBe(survivor.id);
			expect(result.supersededCount).toBe(1);
			expect([...result.supersededIds]).toEqual([loser.id]);
			// Recall should now exclude the loser by default.
			const recalled = await client.search({
				scope: testScope("alice"),
				query: "coffee",
			});
			const ids = recalled.map((memory) => memory.id);
			expect(ids).toContain(survivor.id);
			expect(ids).not.toContain(loser.id);
			// Including superseded surfaces the loser with supersededAt set.
			const all = await client.search({
				scope: testScope("alice"),
				query: "coffee",
				includeSuperseded: true,
			});
			const loserAfter = all.find((memory) => memory.id === loser.id);
			expect(loserAfter).toBeTruthy();
			const supersededLoser = expectDefined(loserAfter);
			expect(supersededLoser.supersededBy).toBe(survivor.id);
			expect(supersededLoser.supersededAt).toBeInstanceOf(Date);
			const stats = await client.stats({ scope: testScope("alice") });
			expect(stats.supersededMemoryCount).toBe(1);
			expect(stats.activeMemoryCount).toBe(1);
		}

		// 6. Tags unioned onto survivor by default; mergeTags:false leaves tags alone.
		{
			const client = createClient();
			const survivor = await client.add({
				scope: testScope("alice"),
				content: "coffee",
				tags: ["drink"],
			});
			const loser = await client.add({
				scope: testScope("alice"),
				content: "coffee 2",
				tags: ["drink", "morning"],
			});
			await client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: survivor.id,
				supersededIds: [loser.id],
			});
			const recalledMerged = await client.search({
				scope: testScope("alice"),
				query: "coffee",
			});
			const survivorAfterMerge = recalledMerged.find(
				(memory) => memory.id === survivor.id,
			);
			expect(survivorAfterMerge).toBeTruthy();
			expect([...expectDefined(survivorAfterMerge).tags].sort()).toEqual([
				"drink",
				"morning",
			]);

			const survivor2 = await client.add({
				scope: testScope("alice"),
				content: "tea",
				tags: ["drink"],
			});
			const loser2 = await client.add({
				scope: testScope("alice"),
				content: "tea 2",
				tags: ["evening"],
			});
			await client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: survivor2.id,
				supersededIds: [loser2.id],
				mergeTags: false,
			});
			const recalled = await client.search({
				scope: testScope("alice"),
				query: "tea",
			});
			const survivorAfter = recalled.find(
				(memory) => memory.id === survivor2.id,
			);
			expect(survivorAfter).toBeTruthy();
			expect([...expectDefined(survivorAfter).tags]).toEqual(["drink"]);
		}

		// 7. Already-superseded losers are skipped idempotently.
		{
			const client = createClient();
			const survivor = await client.add({
				scope: testScope("alice"),
				content: "a",
			});
			const loser = await client.add({
				scope: testScope("alice"),
				content: "b",
			});
			const first = await client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: survivor.id,
				supersededIds: [loser.id],
			});
			expect(first.supersededCount).toBe(1);
			const second = await client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: survivor.id,
				supersededIds: [loser.id],
			});
			expect(second.supersededCount).toBe(0);
			expect([...second.supersededIds]).toEqual([]);
		}

		// 8. Merging into an already-superseded survivor is rejected with VALIDATION.
		{
			const client = createClient();
			const winner = await client.add({
				scope: testScope("alice"),
				content: "winner",
			});
			const middle = await client.add({
				scope: testScope("alice"),
				content: "middle",
			});
			const newest = await client.add({
				scope: testScope("alice"),
				content: "newest",
			});
			await client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: winner.id,
				supersededIds: [middle.id],
			});
			// middle is now superseded → cannot be used as survivor.
			await expectError("VALIDATION", () =>
				client.experimental.consolidate({
					scope: testScope("alice"),
					survivorId: middle.id,
					supersededIds: [newest.id],
				}),
			);
		}

		// 9. Audit + observability events fire (when enabled).
		{
			const events: MnemocyteObservation[] = [];
			const client = createMemory({
				embedder: {
					model: "consolidate-observability",
					dimensions: 2,
					async embed(texts: readonly string[]) {
						return texts.map((text) => [text.length, 1]);
					},
				},
				audit: { enabled: true },
				observability: {
					onEvent(event) {
						events.push(event);
					},
				},
			});
			const survivor = await client.add({
				scope: testScope("alice"),
				content: "a",
			});
			const loser = await client.add({
				scope: testScope("alice"),
				content: "b",
			});
			const result = await client.experimental.consolidate({
				scope: testScope("alice"),
				survivorId: survivor.id,
				supersededIds: [loser.id],
			});
			expect(result.supersededCount).toBe(1);
			const success = events.find(
				(event) =>
					event.operation === "consolidate" && event.phase === "success",
			);
			expect(success?.entityId).toBe("alice");
			expect(success?.memoryId).toBe(survivor.id);
			expect(success?.count).toBe(1);
			const log = await client.listAuditLog({ scope: testScope("alice") });
			const superseded = log.find(
				(event) => event.description === "memory.superseded",
			);
			expect(superseded).toBeTruthy();
			const supersededEvent = expectDefined(superseded);
			expect(supersededEvent.metadata.memoryId).toBe(loser.id);
			expect(supersededEvent.metadata.supersededBy).toBe(survivor.id);
		}
	});
});
