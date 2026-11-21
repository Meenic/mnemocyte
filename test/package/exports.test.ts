import {
	createMemory,
	isMnemocyteError,
	isProviderError,
	MnemocyteError,
	migrate,
	ProviderError,
	setTextSearchConfig,
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
import * as libsqlEntry from "mnemocyte/libsql";
import manifest from "mnemocyte/package.json" with { type: "json" };
import * as postgresEntry from "mnemocyte/postgres";
import { postgresStore } from "mnemocyte/postgres";
import { describe, expect, test } from "vitest";
import { testScope } from "../helpers.js";

describe("package exports", () => {
	test("exports the package manifest", () => {
		expect(manifest.name).toBe("mnemocyte");
		expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
	});

	test("exposes the built package runtime API", async () => {
		expect(typeof createMemory).toBe("function");
		expect(typeof MnemocyteError).toBe("function");
		expect(typeof migrate).toBe("function");
		expect(typeof setTextSearchConfig).toBe("function");
		expect(typeof postgresStore).toBe("function");
		expect(Object.keys(postgresEntry)).toEqual(["postgresStore"]);
		expect(Object.keys(libsqlEntry)).toEqual(["libsqlStore"]);
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
		expect(
			isProviderError(new ProviderError({ message: "x", status: 503 })),
		).toBe(true);
		expect(
			isMnemocyteError(new ProviderError({ message: "x", status: 503 })),
		).toBe(true);
		// The embedders entry shares the root's error class.
		expect(() =>
			directOpenAICompatibleEmbedder({
				baseURL: "",
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
