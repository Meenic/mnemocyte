import type {
	MnemocyteConfig,
	MnemocyteErrorCode,
	MnemocyteObservation,
} from "mnemocyte";
import { createMnemocyte } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

describe("consolidate", () => {
	test("validates and consolidates duplicate memories", async () => {
		function createClient(extra: Partial<MnemocyteConfig> = {}) {
			return createMnemocyte({
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
			try {
				const survivor = await client.remember({
					entityId: "alice",
					content: "coffee",
				});
				await expectError("VALIDATION", () =>
					client.experimental.consolidate({
						entityId: "alice",
						survivorId: survivor.id,
						supersededIds: [],
					}),
				);
			} finally {
				await client.close();
			}
		}

		// 2. survivorId appearing in supersededIds → VALIDATION.
		{
			const client = createClient();
			try {
				const survivor = await client.remember({
					entityId: "alice",
					content: "coffee",
				});
				await expectError("VALIDATION", () =>
					client.experimental.consolidate({
						entityId: "alice",
						survivorId: survivor.id,
						supersededIds: [survivor.id],
					}),
				);
			} finally {
				await client.close();
			}
		}

		// 3. Unknown survivor → NOT_FOUND.
		{
			const client = createClient();
			try {
				const other = await client.remember({
					entityId: "alice",
					content: "x",
				});
				await expectError("NOT_FOUND", () =>
					client.experimental.consolidate({
						entityId: "alice",
						survivorId: "mem_nope",
						supersededIds: [other.id],
					}),
				);
			} finally {
				await client.close();
			}
		}

		// 4. Unknown / cross-entity superseded → NOT_FOUND.
		{
			const client = createClient();
			try {
				const aliceMem = await client.remember({
					entityId: "alice",
					content: "a",
				});
				const bobMem = await client.remember({ entityId: "bob", content: "b" });
				await expectError("NOT_FOUND", () =>
					client.experimental.consolidate({
						entityId: "alice",
						survivorId: aliceMem.id,
						supersededIds: ["mem_nope"],
					}),
				);
				await expectError("NOT_FOUND", () =>
					client.experimental.consolidate({
						entityId: "alice",
						survivorId: aliceMem.id,
						supersededIds: [bobMem.id],
					}),
				);
			} finally {
				await client.close();
			}
		}

		// 5. Successful merge: losers get supersededBy + supersededAt, survivor unchanged.
		{
			const client = createClient();
			try {
				const survivor = await client.remember({
					entityId: "alice",
					content: "coffee morning",
				});
				const loser = await client.remember({
					entityId: "alice",
					content: "coffee early",
				});
				expect(survivor.supersededAt).toBe(null);
				expect(loser.supersededAt).toBe(null);
				const result = await client.experimental.consolidate({
					entityId: "alice",
					survivorId: survivor.id,
					supersededIds: [loser.id],
				});
				expect(result.survivorId).toBe(survivor.id);
				expect(result.supersededCount).toBe(1);
				expect([...result.supersededIds]).toEqual([loser.id]);
				// Recall should now exclude the loser by default.
				const recalled = await client.recall({
					entityId: "alice",
					query: "coffee",
				});
				const ids = recalled.map((memory) => memory.id);
				expect(ids).toContain(survivor.id);
				expect(ids).not.toContain(loser.id);
				// Including superseded surfaces the loser with supersededAt set.
				const all = await client.recall({
					entityId: "alice",
					query: "coffee",
					includeSuperseded: true,
				});
				const loserAfter = all.find((memory) => memory.id === loser.id);
				expect(loserAfter).toBeTruthy();
				const supersededLoser = expectDefined(loserAfter);
				expect(supersededLoser.supersededBy).toBe(survivor.id);
				expect(supersededLoser.supersededAt).toBeInstanceOf(Date);
				const stats = await client.stats({ entityId: "alice" });
				expect(stats.supersededMemoryCount).toBe(1);
				expect(stats.activeMemoryCount).toBe(1);
			} finally {
				await client.close();
			}
		}

		// 6. Tags unioned onto survivor by default; mergeTags:false leaves tags alone.
		{
			const client = createClient();
			try {
				const survivor = await client.remember({
					entityId: "alice",
					content: "coffee",
					tags: ["drink"],
				});
				const loser = await client.remember({
					entityId: "alice",
					content: "coffee 2",
					tags: ["drink", "morning"],
				});
				await client.experimental.consolidate({
					entityId: "alice",
					survivorId: survivor.id,
					supersededIds: [loser.id],
				});
				const recalledMerged = await client.recall({
					entityId: "alice",
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

				const survivor2 = await client.remember({
					entityId: "alice",
					content: "tea",
					tags: ["drink"],
				});
				const loser2 = await client.remember({
					entityId: "alice",
					content: "tea 2",
					tags: ["evening"],
				});
				await client.experimental.consolidate({
					entityId: "alice",
					survivorId: survivor2.id,
					supersededIds: [loser2.id],
					mergeTags: false,
				});
				const recalled = await client.recall({
					entityId: "alice",
					query: "tea",
				});
				const survivorAfter = recalled.find(
					(memory) => memory.id === survivor2.id,
				);
				expect(survivorAfter).toBeTruthy();
				expect([...expectDefined(survivorAfter).tags]).toEqual(["drink"]);
			} finally {
				await client.close();
			}
		}

		// 7. Already-superseded losers are skipped idempotently.
		{
			const client = createClient();
			try {
				const survivor = await client.remember({
					entityId: "alice",
					content: "a",
				});
				const loser = await client.remember({
					entityId: "alice",
					content: "b",
				});
				const first = await client.experimental.consolidate({
					entityId: "alice",
					survivorId: survivor.id,
					supersededIds: [loser.id],
				});
				expect(first.supersededCount).toBe(1);
				const second = await client.experimental.consolidate({
					entityId: "alice",
					survivorId: survivor.id,
					supersededIds: [loser.id],
				});
				expect(second.supersededCount).toBe(0);
				expect([...second.supersededIds]).toEqual([]);
			} finally {
				await client.close();
			}
		}

		// 8. Merging into an already-superseded survivor is rejected with VALIDATION.
		{
			const client = createClient();
			try {
				const winner = await client.remember({
					entityId: "alice",
					content: "winner",
				});
				const middle = await client.remember({
					entityId: "alice",
					content: "middle",
				});
				const newest = await client.remember({
					entityId: "alice",
					content: "newest",
				});
				await client.experimental.consolidate({
					entityId: "alice",
					survivorId: winner.id,
					supersededIds: [middle.id],
				});
				// middle is now superseded → cannot be used as survivor.
				await expectError("VALIDATION", () =>
					client.experimental.consolidate({
						entityId: "alice",
						survivorId: middle.id,
						supersededIds: [newest.id],
					}),
				);
			} finally {
				await client.close();
			}
		}

		// 9. Audit + observability events fire (when enabled).
		{
			const events: MnemocyteObservation[] = [];
			const client = createMnemocyte({
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
			try {
				const survivor = await client.remember({
					entityId: "alice",
					content: "a",
				});
				const loser = await client.remember({
					entityId: "alice",
					content: "b",
				});
				const result = await client.experimental.consolidate({
					entityId: "alice",
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
				const log = await client.listAuditLog({ entityId: "alice" });
				const superseded = log.find(
					(event) => event.description === "memory.superseded",
				);
				expect(superseded).toBeTruthy();
				const supersededEvent = expectDefined(superseded);
				expect(supersededEvent.metadata.memoryId).toBe(loser.id);
				expect(supersededEvent.metadata.supersededBy).toBe(survivor.id);
			} finally {
				await client.close();
			}
		}
	});
});
