import { createMnemocyte, MnemocyteError } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import { openaiEmbedder as directOpenAIEmbedder } from "mnemocyte/embedders/openai";
import { drizzleStore } from "mnemocyte/stores/drizzle";
import { describe, expect, test } from "vitest";

describe("package exports", () => {
	test("exposes the built package runtime API", async () => {
		expect(typeof createMnemocyte).toBe("function");
		expect(typeof MnemocyteError).toBe("function");
		expect(typeof drizzleStore).toBe("function");
		expect(typeof openaiEmbedder).toBe("function");
		expect(typeof directOpenAIEmbedder).toBe("function");

		const client = createMnemocyte({
			embedder: {
				model: "exports-smoke",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) => [text.length, 1]);
				},
			},
		});

		const memory = await client.remember({
			entityId: "exports_smoke",
			content: "Package self-reference import works.",
		});
		expect(memory.entityId).toBe("exports_smoke");
		expect(typeof client.buildContext).toBe("function");

		await client.close();
	});
});
