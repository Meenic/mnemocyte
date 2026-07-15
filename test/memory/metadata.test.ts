import { createMnemocyte, type JsonObject, type JsonValue } from "mnemocyte";
import { describe, expect, test } from "vitest";
import { expectMnemocyteError } from "../helpers.js";

function profile(metadata: JsonObject): JsonObject {
	const value = metadata.profile;
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected profile metadata to be an object.");
	}
	return value;
}

describe("metadata value semantics", () => {
	test("deep-clones JSON metadata at write and read boundaries", async () => {
		const client = createMnemocyte({
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

		try {
			const pending = client.remember({
				entityId: "alice",
				content: "Prefers concise answers.",
				metadata,
			});
			profile(metadata).tier = "free";
			const remembered = await pending;
			profile(remembered.metadata).tier = "trial";

			const firstRecall = await client.recall({
				entityId: "alice",
				query: "concise answers",
			});
			expect(profile(firstRecall[0]?.metadata ?? {}).tier).toBe("gold");

			profile(firstRecall[0]?.metadata ?? {}).tier = "mutated";
			const secondRecall = await client.recall({
				entityId: "alice",
				query: "concise answers",
			});
			expect(profile(secondRecall[0]?.metadata ?? {}).tier).toBe("gold");
		} finally {
			await client.close();
		}
	});

	test("rejects unsupported and cyclic metadata before embedding", async () => {
		let embedCalls = 0;
		const client = createMnemocyte({
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

		try {
			for (const metadata of unsupported) {
				await expectMnemocyteError(
					client.remember({
						entityId: "alice",
						content: "Invalid metadata",
						metadata: metadata as JsonObject,
					}),
					"VALIDATION",
				);
			}
			expect(embedCalls).toBe(0);
		} finally {
			await client.close();
		}
	});

	test("accepts the complete JsonValue domain", async () => {
		const value: JsonValue = {
			string: "value",
			number: 1.5,
			boolean: true,
			null: null,
			array: ["value", 2, false, null, { nested: "value" }],
		};
		const client = createMnemocyte({
			embedder: {
				model: "json-value-test",
				dimensions: 1,
				async embed(texts) {
					return texts.map(() => [1]);
				},
			},
		});

		try {
			const memory = await client.remember({
				entityId: "alice",
				content: "Valid metadata",
				metadata: value as JsonObject,
			});
			expect(memory.metadata).toEqual(value);
		} finally {
			await client.close();
		}
	});
});
