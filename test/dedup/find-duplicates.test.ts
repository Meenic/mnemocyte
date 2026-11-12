import {
	createMemory,
	type MemoryConfig,
	type MnemocyteObservation,
} from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectDefined, expectMnemocyteError, testScope } from "../helpers.js";

describe("findDuplicates", () => {
	test("validates and finds duplicate memory pairs", async () => {
		/**
		 * Deterministic embedder that maps a small dictionary of phrases to fixed
		 * 4-dimensional vectors. Unknown content falls back to a content-length
		 * based vector so cosine similarity stays bounded but distinct.
		 */
		function dictionaryEmbedder() {
			const dictionary = new Map([
				["coffee morning", [1, 0, 0, 0]],
				["coffee early", [0.99, 0.05, 0, 0]],
				["tea afternoon", [0, 1, 0, 0]],
				["weather sunny", [0, 0, 1, 0]],
			]);
			return {
				model: "dedup-test",
				dimensions: 4,
				async embed(texts: readonly string[]) {
					return texts.map((text) => {
						const vec = dictionary.get(text);
						if (vec) {
							return vec;
						}
						return [text.length, 1, 0, 0];
					});
				},
			};
		}

		function createClient(extra: Partial<MemoryConfig> = {}) {
			return createMemory({ embedder: dictionaryEmbedder(), ...extra });
		}

		// 1. Empty entityId is rejected with VALIDATION.
		{
			const client = createClient();
			await expectMnemocyteError(
				client.findDuplicates({ scope: testScope("") }),
				"VALIDATION",
			);
		}

		// 2. Out-of-range threshold is rejected with VALIDATION.
		{
			const client = createClient();
			await expectMnemocyteError(
				client.findDuplicates({ scope: testScope("alice"), threshold: 1.5 }),
				"VALIDATION",
			);
		}

		// 3. Near-identical memories produce a pair; unrelated memory does not.
		{
			const client = createClient();
			const morning = await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
			});
			const early = await client.add({
				scope: testScope("alice"),
				content: "coffee early",
			});
			await client.add({
				scope: testScope("alice"),
				content: "weather sunny",
			});
			const pairs = await client.findDuplicates({
				scope: testScope("alice"),
				threshold: 0.95,
			});
			expect(pairs.length).toBe(1);
			const pair = expectDefined(pairs[0]);
			const ids = [pair.a.id, pair.b.id].sort();
			expect(ids).toEqual([morning.id, early.id].sort());
			expect(pair.similarity).toBeGreaterThanOrEqual(0.95);
			expect(pair.similarity).toBeLessThanOrEqual(1);
		}

		// 4. Entity scoping: duplicates across entities are not surfaced.
		{
			const client = createClient();
			await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
			});
			await client.add({ scope: testScope("bob"), content: "coffee early" });
			const alice = await client.findDuplicates({
				scope: testScope("alice"),
			});
			const bob = await client.findDuplicates({ scope: testScope("bob") });
			expect(alice.length).toBe(0);
			expect(bob.length).toBe(0);
		}

		// 5. Threshold filters: a high threshold drops near-but-not-exact pairs.
		{
			const client = createClient();
			await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
			});
			await client.add({
				scope: testScope("alice"),
				content: "coffee early",
			});
			const loose = await client.findDuplicates({
				scope: testScope("alice"),
				threshold: 0.9,
			});
			const strict = await client.findDuplicates({
				scope: testScope("alice"),
				threshold: 0.999999,
			});
			expect(loose.length).toBe(1);
			expect(strict.length).toBe(0);
		}

		// 6. types filter restricts the scan to listed types.
		{
			const client = createClient();
			await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
				kind: "fact",
			});
			await client.add({
				scope: testScope("alice"),
				content: "coffee early",
				kind: "preference",
			});
			const both = await client.findDuplicates({ scope: testScope("alice") });
			const factsOnly = await client.findDuplicates({
				scope: testScope("alice"),
				kinds: ["fact"],
			});
			expect(both.length).toBe(1);
			expect(factsOnly.length).toBe(0);
		}

		// 7. tags filter requires both pair members to include all listed tags.
		{
			const client = createClient();
			await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
				tags: ["preferences"],
			});
			await client.add({
				scope: testScope("alice"),
				content: "coffee early",
				tags: ["preferences", "drink"],
			});
			const withMatch = await client.findDuplicates({
				scope: testScope("alice"),
				tags: ["preferences"],
			});
			const withoutMatch = await client.findDuplicates({
				scope: testScope("alice"),
				tags: ["preferences", "drink"],
			});
			expect(withMatch.length).toBe(1);
			expect(withoutMatch.length).toBe(0);
		}

		// 8. limit caps the number of returned pairs, ordered by similarity desc.
		{
			const client = createClient();
			await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
			});
			await client.add({
				scope: testScope("alice"),
				content: "coffee early",
			});
			await client.add({
				scope: testScope("alice"),
				content: "tea afternoon",
			});
			const pairs = await client.findDuplicates({
				scope: testScope("alice"),
				threshold: 0,
				limit: 1,
			});
			expect(pairs.length).toBe(1);
			// Highest-similarity pair must be the two coffee entries.
			const highestSimilarityPair = expectDefined(pairs[0]);
			const contents = [
				highestSimilarityPair.a.content,
				highestSimilarityPair.b.content,
			].sort();
			expect(contents).toEqual(["coffee early", "coffee morning"]);
		}

		// 9. Superseded / expired memories are excluded by default.
		{
			const client = createClient();
			await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
			});
			await client.add({
				scope: testScope("alice"),
				content: "coffee early",
				expiresAt: new Date(Date.now() - 60_000),
			});
			const defaults = await client.findDuplicates({
				scope: testScope("alice"),
			});
			const includeExpired = await client.findDuplicates({
				scope: testScope("alice"),
				includeExpired: true,
			});
			expect(defaults.length).toBe(0);
			expect(includeExpired.length).toBe(1);
		}

		// 10. Emits a findDuplicates observability event with the pair count.
		{
			const events: MnemocyteObservation[] = [];
			const client = createMemory({
				embedder: dictionaryEmbedder(),
				observability: {
					onEvent(event) {
						events.push(event);
					},
				},
			});
			await client.add({
				scope: testScope("alice"),
				content: "coffee morning",
			});
			await client.add({
				scope: testScope("alice"),
				content: "coffee early",
			});
			const pairs = await client.findDuplicates({
				scope: testScope("alice"),
			});
			expect(pairs.length).toBe(1);
			const success = events.find(
				(event) =>
					event.operation === "findDuplicates" && event.phase === "success",
			);
			expect(success?.entityId).toBe("alice");
			expect(success?.count).toBe(1);
		}
	});
});
