import { createMemory, type Embedder } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { createInMemoryStore } from "../../src/memory/in-memory.js";
import { createMnemocyteStoreConfig } from "../../src/memory/store-config.js";
import { CONTRACT_DIMENSIONS, embedText } from "../contract/suite.js";
import {
	verifyContextMemories,
	verifyContextTracksRenderedMemories,
} from "../fixtures/context-memories.js";
import { testScope } from "../helpers.js";

const embedder: Embedder = {
	model: "context-memories",
	dimensions: CONTRACT_DIMENSIONS,
	async embed(texts) {
		return texts.map(embedText);
	},
};

describe("experimental.contextWithMemories (in-memory)", () => {
	test("follows the shared fixture", async () => {
		const store = createMnemocyteStoreConfig(createInMemoryStore());
		await verifyContextMemories({
			memory: createMemory({ store, embedder }),
			defaulted: createMemory({ namespace: "context", store, embedder }),
			namespace: "context",
		});
	});

	test("tracks access only for the memories in the text", async () => {
		const store = createMnemocyteStoreConfig(createInMemoryStore());
		await verifyContextTracksRenderedMemories({
			createTracked: (onEvent) =>
				createMemory({
					store,
					embedder,
					retrieval: { trackAccess: true },
					observability: { onEvent },
				}),
			namespace: "context",
		});
	});

	test("reports its own operation with the rendered count", async () => {
		const events: { operation: string; phase: string; count?: number }[] = [];
		const memory = createMemory({
			embedder,
			observability: {
				onEvent(event) {
					events.push({
						operation: event.operation,
						phase: event.phase,
						...(event.count === undefined ? {} : { count: event.count }),
					});
				},
			},
		});
		const scope = testScope("alice");
		await memory.add({ scope, content: "Prefers green tea." });
		events.length = 0;
		await memory.experimental.contextWithMemories({ scope, query: "tea" });
		expect(
			events.filter((event) => event.operation === "contextWithMemories"),
		).toEqual([
			{ operation: "contextWithMemories", phase: "start" },
			{ operation: "contextWithMemories", phase: "success", count: 1 },
		]);
		expect(events.map((event) => event.operation)).toContain("search");
	});
});
