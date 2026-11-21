import { createMemory, type JsonObject, type JsonValue } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError, testScope } from "../helpers.js";

function profile(metadata: JsonObject): JsonObject {
	const value = metadata.profile;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected profile metadata to be an object.");
	}
	return value;
}

describe("metadata value semantics", () => {
	test("deep-clones JSON metadata at write and read boundaries", async () => {
		const client = createMemory({
			embedder: {
				model: "metadata-test",
				dimensions: 2,
				async embed(texts) {
					return texts.map(() => [1, 0]);
				},
			},
		});
		const metadata: JsonObject = {
			profile: { tier: "gold" },
			preferences: ["concise", { format: "markdown" }],
		};

		const pending = client.add({
			scope: testScope("alice"),
			content: "Prefers concise answers.",
			metadata,
		});
		profile(metadata).tier = "free";
		const remembered = await pending;
		profile(remembered.metadata).tier = "trial";

		const firstRecall = await client.search({
			scope: testScope("alice"),
			query: "concise answers",
		});
		expect(profile(firstRecall[0]?.metadata ?? {}).tier).toBe("gold");

		profile(firstRecall[0]?.metadata ?? {}).tier = "mutated";
		const secondRecall = await client.search({
			scope: testScope("alice"),
			query: "concise answers",
		});
		expect(profile(secondRecall[0]?.metadata ?? {}).tier).toBe("gold");
	});

	test("rejects unsupported and cyclic metadata before embedding", async () => {
		let embedCalls = 0;
		const client = createMemory({
			embedder: {
				model: "metadata-validation-test",
				dimensions: 1,
				async embed(texts) {
					embedCalls += 1;
					return texts.map(() => [1]);
				},
			},
		});
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const unsupported: unknown[] = [
			{ value: undefined },
			{ value: 1n },
			{ value: Number.NaN },
			{ value: Number.POSITIVE_INFINITY },
			{ value: new Date("2026-01-01T00:00:00.000Z") },
			{ value: () => "not JSON" },
			cyclic,
		];

		for (const metadata of unsupported) {
			await expectMnemocyteError(
				client.add({
					scope: testScope("alice"),
					content: "Invalid metadata",
					metadata: metadata as JsonObject,
				}),
				"VALIDATION",
			);
		}
		expect(embedCalls).toBe(0);
	});

	test("accepts the complete JsonValue domain", async () => {
		const value: JsonValue = {
			string: "value",
			number: 1.5,
			boolean: true,
			null: null,
			array: ["value", 2, false, null, { nested: "value" }],
		};
		const client = createMemory({
			embedder: {
				model: "json-value-test",
				dimensions: 1,
				async embed(texts) {
					return texts.map(() => [1]);
				},
			},
		});

		const memory = await client.add({
			scope: testScope("alice"),
			content: "Valid metadata",
			metadata: value as JsonObject,
		});
		expect(memory.metadata).toEqual(value);
	});
});
