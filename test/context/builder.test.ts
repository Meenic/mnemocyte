import { createMnemocyte } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

describe("context builder", () => {
	test("formats and trims memory context", async () => {
		const embedder = {
			model: "context-test",
			dimensions: 4,
			async embed(texts: readonly string[]) {
				return texts.map((text) => [
					text.length,
					text.includes("xml") ? 1 : 0,
					text.includes("direct") ? 1 : 0,
					1,
				]);
			},
		};

		const client = createMnemocyte({ embedder });
		const entityId = `context_${Date.now()}_${Math.random().toString(36).slice(2)}`;

		try {
			await client.remember({
				entityId,
				content: "Prefers short, direct answers with <xml> safety & escaping.",
				type: "preference",
				importance: "high",
				tags: ["style"],
			});

			const markdown = await client.buildContext({
				entityId,
				query: "direct xml answers",
				format: "markdown",
				limit: 1,
			});
			expect(markdown).toMatch(/# Memory Context/);
			expect(markdown).toMatch(/Relevant Memories/);
			expect(markdown).toMatch(/```text/);
			expect(markdown).toMatch(/Prefers short, direct answers/);

			const plain = await client.buildContext({
				entityId,
				query: "direct xml answers",
				format: "plain",
				limit: 1,
			});
			expect(plain).toMatch(/MEMORY CONTEXT/);
			expect(plain).toMatch(/RELEVANT MEMORIES/);
			expect(plain).toMatch(/--- MEMORY 1 START ---/);

			const xml = await client.buildContext({
				entityId,
				query: "direct xml answers",
				format: "xml",
				limit: 1,
			});
			expect(xml).toMatch(/<memory_context/);
			expect(xml).toMatch(/&lt;xml&gt; safety &amp; escaping/);
			expect(xml).not.toMatch(/<xml> safety & escaping/);

			const trimmed = await client.buildContext({
				entityId,
				query: "direct xml answers",
				format: "markdown",
				limit: 1,
				maxTokens: 12,
				tokenCounter: {
					count(text) {
						return text.split(/\s+/).filter(Boolean).length;
					},
				},
			});
			expect(trimmed).toMatch(
				/\[(1 memories omitted|truncated) to fit token budget\]/,
			);

			const { buildContext } = client;
			const detached = await buildContext({
				entityId,
				query: "direct xml answers",
				format: "plain",
				limit: 1,
			});
			expect(detached).toMatch(/RELEVANT MEMORIES/);
		} finally {
			await client.close();
		}
	});

	test("rejects invalid maxTokens while preserving omission as the default path", async () => {
		let embedCalls = 0;
		const client = createMnemocyte({
			embedder: {
				model: "context-validation-test",
				dimensions: 1,
				async embed(texts) {
					embedCalls += 1;
					return texts.map(() => [1]);
				},
			},
		});

		try {
			await expect(
				client.buildContext({ entityId: "alice", query: "default budget" }),
			).resolves.toEqual(expect.any(String));
			expect(embedCalls).toBe(1);

			for (const maxTokens of [
				0,
				-1,
				1.5,
				Number.NaN,
				Number.POSITIVE_INFINITY,
			]) {
				await expectMnemocyteError(
					client.buildContext({
						entityId: "alice",
						query: "invalid budget",
						maxTokens,
					}),
					"VALIDATION",
				);
			}
			expect(embedCalls).toBe(1);
		} finally {
			await client.close();
		}
	});
});
