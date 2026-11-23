import type { Embedder } from "mnemocyte";
import { describe, expect, it, vi } from "vitest";
import { createMemoryMcpServer } from "../src/index.js";
import { boundTo, connect, createTestMemory, textOf } from "./helpers.js";

describe("tools/list", () => {
	it("lists search and save by default", async () => {
		const client = await connect({ memory: boundTo(createTestMemory()) });
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"searchMemories",
			"saveMemory",
		]);
	});

	it("adds forgetMemory with allowForget", async () => {
		const client = await connect({
			memory: boundTo(createTestMemory()),
			allowForget: true,
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual([
			"searchMemories",
			"saveMemory",
			"forgetMemory",
		]);
	});

	it("lists only searchMemories with readOnly", async () => {
		const client = await connect({
			memory: boundTo(createTestMemory()),
			readOnly: true,
		});
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).toEqual(["searchMemories"]);
	});

	it("describes inputs without scope fields and with hints", async () => {
		const client = await connect({
			memory: boundTo(createTestMemory()),
			allowForget: true,
		});
		const { tools } = await client.listTools();
		const byName = new Map(tools.map((tool) => [tool.name, tool]));

		const search = byName.get("searchMemories");
		expect(search?.inputSchema).toMatchObject({
			type: "object",
			required: ["query"],
			additionalProperties: false,
		});
		expect(Object.keys(search?.inputSchema.properties ?? {})).toEqual([
			"query",
			"limit",
			"kinds",
		]);
		expect(search?.outputSchema).toMatchObject({ required: ["memories"] });
		expect(search?.annotations).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
		});

		const save = byName.get("saveMemory");
		expect(Object.keys(save?.inputSchema.properties ?? {})).toEqual([
			"content",
			"kind",
			"importance",
		]);
		expect(save?.annotations).toMatchObject({
			readOnlyHint: false,
			destructiveHint: false,
		});

		const forget = byName.get("forgetMemory");
		expect(Object.keys(forget?.inputSchema.properties ?? {})).toEqual(["id"]);
		expect(forget?.annotations).toMatchObject({
			destructiveHint: true,
			idempotentHint: true,
		});
	});
});

describe("tools/call", () => {
	it("saves at the bound scope and finds it again", async () => {
		const memory = createTestMemory();
		const client = await connect({ memory: boundTo(memory) });

		const saved = await client.callTool({
			name: "saveMemory",
			arguments: { content: "Prefers metric units.", kind: "preference" },
		});
		expect(saved.isError).not.toBe(true);
		const { id } = saved.structuredContent as { id: string };
		expect(JSON.parse(textOf(saved))).toEqual({ id });

		const stored = await memory.get({
			scope: { entityId: "u1" },
			id,
		});
		expect(stored).toMatchObject({
			content: "Prefers metric units.",
			kind: "preference",
			source: "saveMemory",
			scope: { namespace: "app", entityId: "u1" },
		});

		const found = await client.callTool({
			name: "searchMemories",
			arguments: { query: "metric units" },
		});
		expect(found.isError).not.toBe(true);
		const { memories } = found.structuredContent as {
			memories: Record<string, unknown>[];
		};
		expect(memories).toHaveLength(1);
		expect(memories[0]).toEqual({
			id,
			content: "Prefers metric units.",
			kind: "preference",
			importance: "normal",
			tags: [],
			createdAt: expect.any(String),
			score: expect.any(Number),
		});
		expect(JSON.parse(textOf(found))).toEqual(found.structuredContent);
	});

	it("does not see another entity's memories", async () => {
		const memory = createTestMemory();
		await memory.add({
			scope: { entityId: "u2" },
			content: "Lives in Lisbon.",
		});
		const client = await connect({ memory: boundTo(memory) });
		const found = await client.callTool({
			name: "searchMemories",
			arguments: { query: "Lisbon" },
		});
		expect(found.structuredContent).toEqual({ memories: [] });
	});

	it.each([
		["entityId", { query: "x", entityId: "u2" }],
		["namespace", { query: "x", namespace: "other" }],
		["scope", { query: "x", scope: { entityId: "u2" } }],
		["allNamespaces", { query: "x", allNamespaces: true }],
	])("rejects the scope field %s", async (field, args) => {
		const client = await connect({ memory: boundTo(createTestMemory()) });
		const result = await client.callTool({
			name: "searchMemories",
			arguments: args,
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(
			`${field} is not accepted: the memory scope is fixed by the server.`,
		);
	});

	it.each([
		["saveMemory", { content: "x", tags: ["a"] }, "Unknown field tags."],
		["saveMemory", { content: "  " }, "content must be a non-empty string."],
		["saveMemory", { content: "x", kind: "note" }, "kind must be one of"],
		["searchMemories", { query: "x", limit: 21 }, "limit must be an integer"],
		["searchMemories", { query: "x", kinds: ["x"] }, "kinds must be an array"],
	])("rejects bad input to %s", async (name, args, message) => {
		const client = await connect({ memory: boundTo(createTestMemory()) });
		const result = await client.callTool({ name, arguments: args });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(message);
	});

	it("forgets a memory, then reports it gone", async () => {
		const memory = createTestMemory();
		const kept = await memory.add({
			scope: { entityId: "u1" },
			content: "Has a dog named Rex.",
		});
		const client = await connect({
			memory: boundTo(memory),
			allowForget: true,
		});
		const first = await client.callTool({
			name: "forgetMemory",
			arguments: { id: kept.id },
		});
		expect(first.structuredContent).toEqual({ forgotten: true });
		expect(
			await memory.get({ scope: { entityId: "u1" }, id: kept.id }),
		).toBeNull();

		const second = await client.callTool({
			name: "forgetMemory",
			arguments: { id: kept.id },
		});
		expect(second.structuredContent).toEqual({ forgotten: false });
	});

	it("cannot forget another entity's memory", async () => {
		const memory = createTestMemory();
		const other = await memory.add({
			scope: { entityId: "u2" },
			content: "Has a cat.",
		});
		const client = await connect({
			memory: boundTo(memory),
			allowForget: true,
		});
		const result = await client.callTool({
			name: "forgetMemory",
			arguments: { id: other.id },
		});
		expect(result.structuredContent).toEqual({ forgotten: false });
		expect(
			await memory.get({ scope: { entityId: "u2" }, id: other.id }),
		).not.toBeNull();
	});

	it("does not run forgetMemory unless allowed", async () => {
		const client = await connect({ memory: boundTo(createTestMemory()) });
		// An unlisted tool is a protocol error, not a tool result.
		await expect(
			client.callTool({ name: "forgetMemory", arguments: { id: "x" } }),
		).rejects.toThrow("Tool forgetMemory not found");
	});

	it("returns a failure of the embedder as a tool error", async () => {
		const failing: Embedder = {
			model: "failing",
			dimensions: 3,
			embed: () => Promise.reject(new Error("embedder down")),
		};
		const client = await connect({
			memory: boundTo(createTestMemory(failing)),
		});
		const result = await client.callTool({
			name: "saveMemory",
			arguments: { content: "x" },
		});
		expect(result).toEqual({
			content: [{ type: "text", text: "Failed to embed text." }],
			isError: true,
		});
	});

	it("cancels the search when the client cancels the call", async () => {
		let embedSignal: AbortSignal | undefined;
		const hanging: Embedder = {
			model: "hanging",
			dimensions: 3,
			embed: (_texts, options) => {
				embedSignal = options.signal;
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason),
					);
				});
			},
		};
		const client = await connect({
			memory: boundTo(createTestMemory(hanging)),
		});
		const controller = new AbortController();
		const call = client.callTool(
			{ name: "searchMemories", arguments: { query: "x" } },
			{ signal: controller.signal },
		);
		await vi.waitFor(() => expect(embedSignal).toBeDefined());
		controller.abort();
		await expect(call).rejects.toThrow();
		await vi.waitFor(() => expect(embedSignal?.aborted).toBe(true));
	});
});

describe("createMemoryMcpServer", () => {
	it("requires a bound client", () => {
		expect(() =>
			createMemoryMcpServer({
				memory: createTestMemory() as never,
			}),
		).toThrow("requires a bound client");
	});

	it("rejects unknown options and non-boolean flags", () => {
		const memory = boundTo(createTestMemory());
		expect(() => createMemoryMcpServer({ memory, scope: {} } as never)).toThrow(
			"unknown option scope",
		);
		expect(() =>
			createMemoryMcpServer({ memory, allowForget: "yes" } as never),
		).toThrow("must be booleans");
	});

	it("rejects readOnly with allowForget", () => {
		expect(() =>
			createMemoryMcpServer({
				memory: boundTo(createTestMemory()),
				readOnly: true,
				allowForget: true,
			}),
		).toThrow("cannot both be set");
	});
});
