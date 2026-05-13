import type {
	BuildContextInput,
	ContextFormat,
	Embedder,
	MnemocyteClient,
	MnemocyteConfig,
	RecallInput,
	RememberInput,
	RetrievalConfig,
	RetrievalExplanation,
	RetrievalScores,
	RetrievalScoreWeights,
	TokenCounter,
} from "mnemocyte";
import { createMnemocyte, MnemocyteError } from "mnemocyte";

const format: ContextFormat = "markdown";
const weights: RetrievalScoreWeights = { vector: 1 };
const retrieval: RetrievalConfig = { weights };
const counter: TokenCounter = { count: (text) => text.length };
const embedder: Embedder = {
	model: "exports-types",
	dimensions: 1,
	embed: async (texts) => texts.map(() => [1]),
};
const config: MnemocyteConfig = { embedder, retrieval };
const client: MnemocyteClient = createMnemocyte(config);
const remember: RememberInput = { entityId: "entity", content: "content" };
const recall: RecallInput = { entityId: "entity", query: "query" };
const context: BuildContextInput = {
	entityId: "entity",
	query: "query",
	format,
	tokenCounter: counter,
};
const scores: RetrievalScores = {
	vector: 1,
	lexical: 0,
	recency: 0,
	confidence: 1,
	access: 0,
	importance: 0.5,
};
const explanation: RetrievalExplanation = {
	vectorScore: scores.vector,
	lexicalScore: scores.lexical,
	recencyScore: scores.recency,
	confidenceScore: scores.confidence,
	accessScore: scores.access,
	importanceScore: scores.importance,
	importanceBoost: 0,
	weights: {
		vector: 1,
		lexical: 0,
		recency: 0,
		confidence: 0,
		access: 0,
		importance: 0,
	},
	finalScore: 1,
};

void client;
void remember;
void recall;
void context;
void explanation;
void MnemocyteError;
