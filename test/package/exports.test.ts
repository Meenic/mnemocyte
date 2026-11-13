import {
	createMemory,
	MnemocyteError,
	migrate,
	ProviderError,
} from "mnemocyte";
import {
	aiSdkEmbedder,
	extractMemories,
	memoryMiddleware,
	memoryTools,
	withMemory,
} from "mnemocyte/ai-sdk";
import {
	cohereEmbedder,
	googleEmbedder,
	openaiCompatibleEmbedder,
	openaiEmbedder,
	voyageEmbedder,
} from "mnemocyte/embedders";
import { cohereEmbedder as directCohereEmbedder } from "mnemocyte/embedders/cohere";
import { googleEmbedder as directGoogleEmbedder } from "mnemocyte/embedders/google";
import { openaiEmbedder as directOpenAIEmbedder } from "mnemocyte/embedders/openai";
import { openaiCompatibleEmbedder as directOpenAICompatibleEmbedder } from "mnemocyte/embedders/openai-compatible";
import { voyageEmbedder as directVoyageEmbedder } from "mnemocyte/embedders/voyage";
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
		expect(openaiCompatibleEmbedder).toBe(directOpenAICompatibleEmbedder);
		expect(voyageEmbedder).toBe(directVoyageEmbedder);
		expect(cohereEmbedder).toBe(directCohereEmbedder);
		expect(googleEmbedder).toBe(directGoogleEmbedder);
		expect(
			googleEmbedder({ apiKey: "k", model: "models/gemini-embedding-001" }),
		).toMatchObject({ model: "gemini-embedding-001", dimensions: 3072 });
		expect(() => voyageEmbedder({ apiKey: "k", model: "x" })).toThrow(
			MnemocyteError,
		);

		expect(typeof ProviderError).toBe("function");
		// The embedders entry shares the root's error class.
		expect(() =>
			directOpenAICompatibleEmbedder({
				baseUrl: "",
				model: "m",
				dimensions: 1,
			}),
		).toThrow(MnemocyteError);
		// So does the AI SDK entry.
		expect(() => aiSdkEmbedder({ model: "unknown/model" })).toThrow(
			MnemocyteError,
		);
		expect(
			aiSdkEmbedder({ model: "openai/text-embedding-3-small" }),
		).toMatchObject({ model: "text-embedding-3-small", dimensions: 1536 });
		expect(() => memoryTools({ memory: undefined as never })).toThrow(
			MnemocyteError,
		);
		expect(() => memoryMiddleware({ memory: undefined as never })).toThrow(
			MnemocyteError,
		);
		expect(() =>
			withMemory({ model: undefined as never, memory: undefined as never }),
		).toThrow(MnemocyteError);
		await expect(
			extractMemories({
				model: undefined as never,
				memory: undefined as never,
				prompt: [],
				text: "",
			}),
		).rejects.toBeInstanceOf(MnemocyteError);

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
