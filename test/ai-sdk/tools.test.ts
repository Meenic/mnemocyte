import {
	asSchema,
	type FlexibleSchema,
	generateText,
	stepCountIs,
	type Tool,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createMemory, type Embedder, type MemoryClient } from "mnemocyte";
import { memoryTools } from "mnemocyte/ai-sdk";
import { describe, expect, test } from "vitest";
import { expectDefined, expectMnemocyteError } from "../helpers.js";

const VOCABULARY = ["tea", "coffee", "metric", "london", "cats", "dogs"];

type OnEmbed = (signal: AbortSignal | undefined) => void;

/** One dimension per vocabulary word, plus one so no vector is all zeros. */
function createEmbedder(onEmbed?: OnEmbed): Embedder {
	return {
		model: "memory-tools-test",
		dimensions: VOCABULARY.length + 1,
		async embed(texts, options) {
			onEmbed?.(options.signal);
			return texts.map((text) => {
				const lower = text.toLowerCase();
				return [
					...VOCABULARY.map((word) => (lower.includes(word) ? 1 : 0)),
					0.1,
				];
			});
		},
	};
}

function createClient(onEmbed?: OnEmbed): MemoryClient<true> {
	return createMemory({ namespace: "app", embedder: createEmbedder(onEmbed) });
}

async function execute<Input, Output>(
	memoryTool: Tool<Input, Output>,
	input: Input,
	abortSignal?: AbortSignal,
): Promise<Output> {
	const run = expectDefined(memoryTool.execute, "The tool has no execute.");
	const result = await run(input, {
		toolCallId: "call_1",
		messages: [],
		context: {},
		...(abortSignal === undefined ? {} : { abortSignal }),
	});
	if (
		typeof result === "object" &&
		result !== null &&
		Symbol.asyncIterator in result
	) {
		throw new Error("Expected a single result, not a stream.");
	}
	return result as Output;
}

async function validate(schema: FlexibleSchema<unknown>, value: unknown) {
	const check = expectDefined(asSchema(schema).validate, "No validate.");
	return check(value);
}

async function invalidMessage(
	schema: FlexibleSchema<unknown>,
	value: unknown,
): Promise<string> {
	const result = await validate(schema, value);
	if (result.success) {
		throw new Error(`Expected ${JSON.stringify(value)} to be rejected.`);
	}
	return result.error.message;
}

describe("memoryTools", () => {
	test("returns the three tools with JSON schemas and descriptions", async () => {
		const tools = memoryTools({
			memory: createClient().for({ entityId: "user_1" }),
		});

		expect(Object.keys(tools)).toEqual([
			"searchMemories",
			"saveMemory",
			"forgetMemory",
		]);
		for (const memoryTool of Object.values(tools)) {
			expect(memoryTool.description).toEqual(expect.any(String));
		}
		const schemas = await Promise.all(
			Object.values(tools).map(
				async (memoryTool) =>
					await asSchema(memoryTool.inputSchema as FlexibleSchema<unknown>)
						.jsonSchema,
			),
		);
		expect(schemas).toEqual([
			expect.objectContaining({
				required: ["query"],
				additionalProperties: false,
			}),
			expect.objectContaining({
				required: ["content"],
				additionalProperties: false,
			}),
			expect.objectContaining({
				required: ["id"],
				additionalProperties: false,
			}),
		]);
		for (const schema of schemas) {
			const properties = Object.keys(
				(schema as { properties: object }).properties,
			);
			expect(properties).not.toContain("entityId");
			expect(properties).not.toContain("namespace");
		}
	});

	test("rejects an unbound client or a missing one with CONFIG", () => {
		const memory = createClient();
		for (const options of [{ memory }, { memory: undefined }, {}, undefined]) {
			let caught: unknown;
			try {
				// @ts-expect-error untyped callers can pass anything.
				memoryTools(options);
			} catch (error) {
				caught = error;
			}
			expect(caught).toMatchObject({ code: "CONFIG" });
		}
	});

	test("saves, searches and forgets memories at the bound scope", async () => {
		const memory = createClient();
		const user = memory.for({ entityId: "user_1" });
		const tools = memoryTools({ memory: user });

		const tea = await execute(tools.saveMemory, {
			content: "Prefers tea over coffee.",
			kind: "preference",
			importance: "high",
		});
		const london = await execute(tools.saveMemory, {
			content: "Lives in London.",
		});

		const stored = expectDefined(await user.get({ id: tea.id }));
		expect(stored).toMatchObject({
			content: "Prefers tea over coffee.",
			kind: "preference",
			importance: "high",
			source: "saveMemory",
			scope: { namespace: "app", entityId: "user_1" },
		});
		expect(await user.get({ id: london.id })).toMatchObject({
			kind: "fact",
			importance: "normal",
		});

		const found = await execute(tools.searchMemories, {
			query: "tea or coffee?",
			limit: 1,
		});
		expect(found.memories).toEqual([
			{
				id: tea.id,
				content: "Prefers tea over coffee.",
				kind: "preference",
				importance: "high",
				tags: [],
				createdAt: stored.createdAt.toISOString(),
				score: expect.any(Number),
			},
		]);
		const score = expectDefined(found.memories[0]).score;
		expect(Math.round(score * 1000) / 1000).toBe(score);
		expect(JSON.parse(JSON.stringify(found))).toEqual(found);

		const facts = await execute(tools.searchMemories, {
			query: "tea",
			kinds: ["fact"],
		});
		expect(facts.memories.map((result) => result.id)).toEqual([london.id]);

		expect(await execute(tools.forgetMemory, { id: tea.id })).toEqual({
			forgotten: true,
		});
		expect(await user.get({ id: tea.id })).toBeNull();
		expect(await execute(tools.forgetMemory, { id: tea.id })).toEqual({
			forgotten: false,
		});
		expect(await execute(tools.forgetMemory, { id: "not-a-uuid" })).toEqual({
			forgotten: false,
		});
	});

	test("forgets a consolidated memory with the duplicates merged into it", async () => {
		const memory = createClient();
		const user = memory.for({ entityId: "user_1" });
		const tools = memoryTools({ memory: user });
		const [survivor, duplicate] = await user.addMany({
			memories: [
				{ content: "Prefers tea over coffee." },
				{ content: "Likes tea more than coffee." },
			],
		});
		const survivorId = expectDefined(survivor).id;
		const duplicateId = expectDefined(duplicate).id;
		await user.consolidate({ survivorId, supersededIds: [duplicateId] });

		expect(await execute(tools.forgetMemory, { id: survivorId })).toEqual({
			forgotten: true,
		});
		expect(await user.get({ id: survivorId })).toBeNull();
		expect(await user.get({ id: duplicateId })).toBeNull();
	});

	test("searches with a default limit of 5", async () => {
		const user = createClient().for({ entityId: "user_1" });
		await user.addMany({
			memories: Array.from({ length: 8 }, (_, index) => ({
				content: `Likes cats, note ${index}.`,
			})),
		});

		const found = await execute(memoryTools({ memory: user }).searchMemories, {
			query: "cats",
		});

		expect(found.memories).toHaveLength(5);
	});

	test("never reaches another entity's memories", async () => {
		const memory = createClient();
		const alice = memory.for({ entityId: "alice" });
		const bob = memoryTools({ memory: memory.for({ entityId: "bob" }) });
		const secret = await alice.add({ content: "Alice likes dogs." });

		const found = await execute(bob.searchMemories, { query: "dogs" });
		expect(found.memories).toEqual([]);

		expect(await execute(bob.forgetMemory, { id: secret.id })).toEqual({
			forgotten: false,
		});
		expect(await alice.get({ id: secret.id })).not.toBeNull();
	});

	test("validates input and rejects scope fields", async () => {
		const tools = memoryTools({
			memory: createClient().for({ entityId: "user_1" }),
		});
		const search = tools.searchMemories.inputSchema;
		const save = tools.saveMemory.inputSchema;
		const forget = tools.forgetMemory.inputSchema;

		expect(await validate(search, { query: "tea", limit: 20 })).toEqual({
			success: true,
			value: { query: "tea", limit: 20 },
		});
		expect(await validate(save, { content: "Likes tea." })).toEqual({
			success: true,
			value: { content: "Likes tea." },
		});

		for (const field of ["entityId", "namespace", "agentId", "sessionId"]) {
			expect(
				await invalidMessage(search, { query: "tea", [field]: "bob" }),
			).toBe(
				`${field} is not accepted: the memory scope is fixed by the application.`,
			);
		}
		expect(
			await invalidMessage(save, {
				content: "x",
				scope: { namespace: "other", entityId: "bob" },
			}),
		).toMatch(/^scope is not accepted/);
		expect(await invalidMessage(forget, { id: "x", entityId: "bob" })).toMatch(
			/^entityId is not accepted/,
		);

		expect(await invalidMessage(search, { query: " " })).toBe(
			"query must be a non-empty string.",
		);
		expect(await invalidMessage(search, { query: "tea", limit: 21 })).toBe(
			"limit must be an integer from 1 to 20.",
		);
		expect(await invalidMessage(search, { query: "tea", limit: 1.5 })).toMatch(
			/^limit/,
		);
		expect(
			await invalidMessage(search, { query: "tea", kinds: ["secret"] }),
		).toMatch(/^kinds/);
		expect(
			await invalidMessage(save, { content: "x", kind: "secret" }),
		).toMatch(/^kind/);
		expect(
			await invalidMessage(save, { content: "x", importance: "urgent" }),
		).toMatch(/^importance/);
		expect(await invalidMessage(save, { content: "x", tags: ["a"] })).toBe(
			"Unknown field tags.",
		);
		expect(await invalidMessage(save, { content: "x", key: "k" })).toBe(
			"Unknown field key.",
		);
		expect(await invalidMessage(forget, { id: "" })).toBe(
			"id must be a non-empty string.",
		);
		expect(await invalidMessage(forget, "id")).toBe("Input must be an object.");
	});

	test("forwards the abort signal", async () => {
		const controller = new AbortController();
		const seen: boolean[] = [];
		const user = createClient((signal) => {
			// The client derives its own signal from the caller's; aborting
			// the caller's must abort it.
			controller.abort();
			seen.push(signal?.aborted === true);
		}).for({ entityId: "user_1" });
		const tools = memoryTools({ memory: user });

		await expectMnemocyteError(
			execute(tools.saveMemory, { content: "Likes tea." }, controller.signal),
			"ABORTED",
		);
		expect(seen).toEqual([true]);
		expect((await user.list()).memories).toEqual([]);

		await user.add({ content: "Likes tea." });
		const aborted = AbortSignal.abort();
		await expectMnemocyteError(
			execute(tools.searchMemories, { query: "tea" }, aborted),
			"ABORTED",
		);
		await expectMnemocyteError(
			execute(tools.saveMemory, { content: "x" }, aborted),
			"ABORTED",
		);
		const { memories } = await user.list();
		await expectMnemocyteError(
			execute(
				tools.forgetMemory,
				{ id: expectDefined(memories[0]).id },
				aborted,
			),
			"ABORTED",
		);
		expect((await user.list()).memories).toHaveLength(1);
	});

	test("rethrows errors other than a missing memory", async () => {
		const user = createClient().for({ entityId: "user_1" });
		const failing = memoryTools({
			memory: {
				...user,
				delete: () => Promise.reject(new Error("database is down")),
			},
		});

		await expect(execute(failing.forgetMemory, { id: "x" })).rejects.toThrow(
			"database is down",
		);
	});
});

describe("memoryTools with generateText", () => {
	const usage = {
		inputTokens: {
			total: 1,
			noCache: 1,
			cacheRead: undefined,
			cacheWrite: undefined,
		},
		outputTokens: { total: 1, text: 1, reasoning: undefined },
	};

	function toolCallStep(toolName: string, input: object) {
		return {
			content: [
				{
					type: "tool-call" as const,
					toolCallId: `call_${toolName}`,
					toolName,
					input: JSON.stringify(input),
				},
			],
			finishReason: { unified: "tool-calls" as const, raw: undefined },
			usage,
			warnings: [],
		};
	}

	const textStep = {
		content: [{ type: "text" as const, text: "Done." }],
		finishReason: { unified: "stop" as const, raw: undefined },
		usage,
		warnings: [],
	};

	test("runs the tools in a multi-step call", async () => {
		const signals: (AbortSignal | undefined)[] = [];
		const user = createClient((signal) => signals.push(signal)).for({
			entityId: "user_1",
		});
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCallStep("saveMemory", {
					content: "Prefers metric units.",
					kind: "preference",
				}),
				toolCallStep("searchMemories", { query: "metric" }),
				textStep,
			],
		});
		const controller = new AbortController();

		const result = await generateText({
			model,
			tools: memoryTools({ memory: user }),
			stopWhen: stepCountIs(5),
			prompt: "Remember that I use metric units.",
			abortSignal: controller.signal,
		});

		expect(result.text).toBe("Done.");
		const outputs = result.steps.flatMap((step) =>
			step.content.flatMap((part) =>
				part.type === "tool-result" ? [part.output] : [],
			),
		);
		const saved = (await user.list()).memories;
		expect(saved).toMatchObject([
			{ content: "Prefers metric units.", kind: "preference" },
		]);
		expect(outputs).toEqual([
			{ id: expectDefined(saved[0]).id },
			{
				memories: [
					expect.objectContaining({
						id: expectDefined(saved[0]).id,
						content: "Prefers metric units.",
					}),
				],
			},
		]);

		// Both tool calls reached the embedder with a signal.
		expect(signals).toHaveLength(2);
		for (const signal of signals) {
			expect(signal).toBeInstanceOf(AbortSignal);
		}
	});

	test("aborts a running tool with the call's abort signal", async () => {
		const controller = new AbortController();
		const seen: boolean[] = [];
		const user = createClient((signal) => {
			controller.abort();
			seen.push(signal?.aborted === true);
		}).for({ entityId: "user_1" });
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCallStep("saveMemory", { content: "Likes tea." }),
				textStep,
			],
		});

		await expect(
			generateText({
				model,
				tools: memoryTools({ memory: user }),
				stopWhen: stepCountIs(5),
				prompt: "Remember that I like tea.",
				abortSignal: controller.signal,
			}),
		).rejects.toThrow();
		expect(seen).toEqual([true]);
		expect((await user.list()).memories).toEqual([]);
	});

	test("reports a scope field from the model as a tool error", async () => {
		const memory = createClient();
		const alice = memory.for({ entityId: "alice" });
		await alice.add({ content: "Alice likes dogs." });
		const bob = memory.for({ entityId: "bob" });
		const model = new MockLanguageModelV4({
			doGenerate: [
				toolCallStep("searchMemories", { query: "dogs", entityId: "alice" }),
				textStep,
			],
		});

		const result = await generateText({
			model,
			tools: memoryTools({ memory: bob }),
			stopWhen: stepCountIs(5),
			prompt: "What does Alice like?",
		});

		const parts = result.steps.flatMap((step) => step.content);
		expect(parts.some((part) => part.type === "tool-result")).toBe(false);
		const errors = parts.flatMap((part) =>
			part.type === "tool-error" ? [part.error] : [],
		);
		expect(errors).toHaveLength(1);
		expect(String(errors[0])).toContain(
			"entityId is not accepted: the memory scope is fixed by the application.",
		);
	});
});
