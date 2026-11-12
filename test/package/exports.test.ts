import { createMemory, MnemocyteError, migrate } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import { openaiEmbedder as directOpenAIEmbedder } from "mnemocyte/embedders/openai";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import { drizzleStore } from "mnemocyte/stores/drizzle";
import { describe, expect, test } from "vitest";
import { testScope } from "../helpers.js";

describe("package exports", () => {
	test("exposes the built package runtime API", async () => {
		expect(typeof createMemory).toBe("function");
		expect(typeof MnemocyteError).toBe("function");
		expect(typeof migrate).toBe("function");
		expect(typeof drizzleStore).toBe("function");
		expect(typeof postgresJs).toBe("function");
		expect(typeof postgresStore).toBe("function");
		expect(typeof openaiEmbedder).toBe("function");
		expect(typeof directOpenAIEmbedder).toBe("function");

		const client = createMemory({
			embedder: {
				model: "exports-smoke",
				dimensions: 2,
				async embed(texts) {
					return texts.map((text) => [text.length, 1]);
				},
			},
		});

		const memory = await client.add({
			scope: testScope("exports_smoke"),
			content: "Package self-reference import works.",
		});
		expect(memory.scope.entityId).toBe("exports_smoke");
		expect(typeof client.context).toBe("function");
		expect("close" in client).toBe(false);
	});
});
