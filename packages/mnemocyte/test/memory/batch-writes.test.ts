import { createMemory, type Embedder, type NewMemory } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

/** Records each embed call's batch; `fail(call)` makes that call throw. */
function recordingEmbedder(
	options: { fail?: (call: number) => boolean; onCall?: () => void } = {},
): { embedder: Embedder; calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		embedder: {
			model: "batch-test",
			dimensions: 2,
			async embed(texts) {
				calls.push([...texts]);
				options.onCall?.();
				if (options.fail?.(calls.length)) {
					throw new Error("provider down");
				}
				return texts.map((_, index) => [1, index + 1]);
			},
		},
	};
}

function memories(count: number): NewMemory[] {
	return Array.from({ length: count }, (_, index) => ({
		content: `memory ${index}`,
	}));
}

describe("addMany embedding chunks", () => {
	test("embeds at most 100 texts per call, in order", async () => {
		const { embedder, calls } = recordingEmbedder();
		const client = createMemory({ embedder });

		const added = await client.addMany({
			scope: testScope("alice"),
			memories: memories(250),
		});

		expect(calls.map((call) => call.length)).toEqual([100, 100, 50]);
		expect(calls.flat()).toEqual(memories(250).map((m) => m.content));
		expect(added.map((memory) => memory.content)).toEqual(
			memories(250).map((m) => m.content),
		);
	});

	test("writes nothing when a later chunk fails", async () => {
		const { embedder, calls } = recordingEmbedder({
			fail: (call) => call === 3,
		});
		const client = createMemory({ embedder });

		await expectMnemocyteError(
			client.addMany({ scope: testScope("alice"), memories: memories(250) }),
			"EMBEDDING",
		);

		expect(calls).toHaveLength(3);
		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({ memoryCount: 0 });
	});

	test("stops between chunks when the signal aborts", async () => {
		const controller = new AbortController();
		const { embedder, calls } = recordingEmbedder({
			onCall: () => controller.abort(),
		});
		const client = createMemory({ embedder });

		await expectMnemocyteError(
			client.addMany({
				scope: testScope("alice"),
				memories: memories(150),
				signal: controller.signal,
			}),
			"ABORTED",
		);

		expect(calls).toHaveLength(1);
		await expect(
			client.stats({ scope: testScope("alice") }),
		).resolves.toMatchObject({ memoryCount: 0 });
	});

	test("follows the embedder's maxBatch", async () => {
		const { embedder, calls } = recordingEmbedder();
		const client = createMemory({ embedder: { ...embedder, maxBatch: 40 } });

		await client.addMany({ scope: testScope("alice"), memories: memories(90) });

		expect(calls.map((call) => call.length)).toEqual([40, 40, 10]);
	});

	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects maxBatch %s with CONFIG",
		(maxBatch) => {
			const { embedder } = recordingEmbedder();
			expect(() =>
				createMemory({ embedder: { ...embedder, maxBatch } }),
			).toThrow(expect.objectContaining({ code: "CONFIG" }));
		},
	);
});

describe("embedding purpose", () => {
	test("passes document for writes and query for search and context", async () => {
		const purposes: string[] = [];
		const client = createMemory({
			embedder: {
				model: "purpose-test",
				dimensions: 2,
				async embed(texts, options) {
					purposes.push(options.purpose);
					return texts.map(() => [1, 1]);
				},
			},
		});
		const scope = testScope("alice");

		const added = await client.add({ scope, content: "one" });
		purposes.push("|");
		await client.addMany({ scope, memories: memories(2) });
		purposes.push("|");
		await client.update({ scope, id: added.id, content: "changed" });
		purposes.push("|");
		await client.search({ scope, query: "one" });
		purposes.push("|");
		await client.context({ scope, query: "one" });

		expect(purposes.join(" ")).toBe(
			"document | document | document | query | query",
		);
	});
});

describe("input caps", () => {
	function client() {
		return createMemory({ embedder: recordingEmbedder().embedder });
	}
	const scope = testScope("alice");

	test("addMany accepts 1,000 memories and rejects 1,001", async () => {
		const memory = client();

		await expect(
			memory.addMany({ scope, memories: memories(1000) }),
		).resolves.toHaveLength(1000);
		await expectMnemocyteError(
			memory.addMany({ scope, memories: memories(1001) }),
			"VALIDATION",
		);
	});

	test("content and query: 32,000 characters", async () => {
		const memory = client();
		const max = "a".repeat(32_000);

		await expect(memory.add({ scope, content: max })).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.add({ scope, content: `${max}a` }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.addMany({ scope, memories: [{ content: `${max}a` }] }),
			"VALIDATION",
		);
		const added = await memory.add({ scope, content: "short" });
		await expectMnemocyteError(
			memory.update({ scope, id: added.id, content: `${max}a` }),
			"VALIDATION",
		);
		await expect(memory.search({ scope, query: max })).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.search({ scope, query: `${max}a` }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.context({ scope, query: `${max}a` }),
			"VALIDATION",
		);
	});

	test("limit: 1 to 1,000", async () => {
		const memory = client();

		await expect(
			memory.search({ scope, query: "q", limit: 1000 }),
		).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.search({ scope, query: "q", limit: 1001 }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.list({ scope, limit: 1001 }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.listAuditLog({ scope, limit: 1001 }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.findDuplicates({ scope, limit: 1001 }),
			"VALIDATION",
		);
	});

	test("tags: 64 per memory, 128 characters each", async () => {
		const memory = client();
		const tags = Array.from({ length: 64 }, (_, index) => `t${index}`);

		await expect(
			memory.add({ scope, content: "c", tags }),
		).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.add({ scope, content: "c", tags: [...tags, "extra"] }),
			"VALIDATION",
		);
		await expect(
			memory.add({ scope, content: "c", tags: ["a".repeat(128)] }),
		).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.add({ scope, content: "c", tags: ["a".repeat(129)] }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.search({ scope, query: "q", tags: ["a".repeat(129)] }),
			"VALIDATION",
		);
	});

	test("metadata: 64 KiB as JSON", async () => {
		const memory = client();
		// {"v":"…"} adds 8 bytes around the string.
		const fits = { v: "a".repeat(65_536 - 8) };
		const tooBig = { v: "a".repeat(65_536 - 7) };

		await expect(
			memory.add({ scope, content: "c", metadata: fits }),
		).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.add({ scope, content: "c", metadata: tooBig }),
			"VALIDATION",
		);
		// Multi-byte characters count in UTF-8 bytes.
		await expectMnemocyteError(
			memory.add({
				scope,
				content: "c",
				metadata: { v: "é".repeat(40_000) },
			}),
			"VALIDATION",
		);
	});

	test("metadata: 32 levels deep, rejected before the stack runs out", async () => {
		const memory = client();
		function nested(depth: number): Record<string, unknown> {
			let value: Record<string, unknown> = {};
			for (let level = 1; level < depth; level += 1) {
				value = { child: value };
			}
			return value;
		}

		await expect(
			memory.add({ scope, content: "c", metadata: nested(32) as never }),
		).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.add({ scope, content: "c", metadata: nested(33) as never }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.add({ scope, content: "c", metadata: nested(100_000) as never }),
			"VALIDATION",
		);
	});

	test("key: 512 UTF-8 bytes", async () => {
		const memory = client();

		await expect(
			memory.add({ scope, content: "c", key: "k".repeat(512) }),
		).resolves.toBeDefined();
		await expectMnemocyteError(
			memory.add({ scope, content: "c", key: "k".repeat(513) }),
			"VALIDATION",
		);
		// 171 three-byte characters are 513 bytes.
		await expectMnemocyteError(
			memory.add({ scope, content: "c", key: "€".repeat(171) }),
			"VALIDATION",
		);
		await expectMnemocyteError(
			memory.get({ scope, key: "k".repeat(513) }),
			"VALIDATION",
		);
	});

	test("scope fields: 256 UTF-8 bytes each", async () => {
		const memory = client();
		const long = "s".repeat(257);

		await expect(
			memory.add({
				scope: {
					namespace: "n".repeat(256),
					entityId: "e".repeat(256),
					agentId: "a".repeat(256),
					sessionId: "s".repeat(256),
				},
				content: "c",
			}),
		).resolves.toBeDefined();
		for (const field of [
			"namespace",
			"entityId",
			"agentId",
			"sessionId",
		] as const) {
			await expectMnemocyteError(
				memory.add({ scope: { ...scope, [field]: long }, content: "c" }),
				"VALIDATION",
			);
		}
		await expectMnemocyteError(
			memory.deleteScope({ scope: { ...scope, entityId: long } }),
			"VALIDATION",
		);
	});
});
