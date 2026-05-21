import type { Embedder, RememberInput, RetrievalConfig } from "mnemocyte";

const VOCABULARY = new Map([
	["typescript", 0],
	["library", 1],
	["libraries", 1],
	["concise", 2],
	["short", 2],
	["answers", 3],
	["responses", 3],
	["postgres", 4],
	["pgvector", 5],
	["database", 6],
	["migration", 7],
	["release", 8],
	["publish", 9],
	["npm", 10],
	["workflow", 11],
]);

function tokenize(text: string) {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function vectorize(text: string) {
	const vector = Array.from({ length: 12 }, () => 0);
	for (const token of tokenize(text)) {
		const index = VOCABULARY.get(token);
		if (index !== undefined) {
			vector[index] = (vector[index] ?? 0) + 1;
		}
	}
	return vector;
}

export const testEmbedder: Embedder = {
	model: "retrieval-quality-test",
	dimensions: 12,
	async embed(texts) {
		return texts.map(vectorize);
	},
};

export const retrievalConfig: RetrievalConfig = {
	weights: {
		vector: 0.4,
		lexical: 0.25,
		recency: 0.05,
		confidence: 0.1,
		access: 0.05,
		importance: 0.15,
	},
	accessSaturation: 3,
	candidateMultiplier: 3,
};

type RetrievalQualityCase = {
	name: string;
	query: string;
	expectedTopContent: string;
	memories: Array<Omit<RememberInput, "entityId">>;
};

export const retrievalQualityCases: RetrievalQualityCase[] = [
	{
		name: "prefers TypeScript answer style over unrelated release workflow",
		query: "typescript concise answers",
		expectedTopContent: "Prefers concise TypeScript library answers.",
		memories: [
			{
				content: "Prefers concise TypeScript library answers.",
				type: "preference",
				importance: "high",
				confidence: 0.95,
				tags: ["typescript", "style"],
			},
			{
				content: "Release workflow uses npm publish after version bump.",
				type: "instruction",
				importance: "normal",
				confidence: 0.9,
				tags: ["release"],
			},
			{
				content: "Postgres and pgvector store memory embeddings.",
				type: "fact",
				importance: "normal",
				confidence: 0.85,
				tags: ["database"],
			},
		],
	},
	{
		name: "retrieves database memory over answer style memory",
		query: "postgres pgvector database",
		expectedTopContent: "Postgres and pgvector store memory embeddings.",
		memories: [
			{
				content: "Prefers concise TypeScript library answers.",
				type: "preference",
				importance: "high",
				confidence: 0.95,
				tags: ["typescript", "style"],
			},
			{
				content: "Postgres and pgvector store memory embeddings.",
				type: "fact",
				importance: "high",
				confidence: 0.95,
				tags: ["database"],
			},
			{
				content: "Release workflow uses npm publish after version bump.",
				type: "instruction",
				importance: "normal",
				confidence: 0.9,
				tags: ["release"],
			},
		],
	},
];
