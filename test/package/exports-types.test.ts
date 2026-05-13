import type {
	BuildContextInput,
	ContextFormat,
	DuplicatePair,
	Embedder,
	FindDuplicatesInput,
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

const findDuplicates: FindDuplicatesInput = {
	entityId: "entity",
	threshold: 0.95,
};
const duplicatePair: DuplicatePair = {
	a: {
		id: "mem_a",
		entityId: "entity",
		content: "a",
		type: "fact",
		importance: "normal",
		tags: [],
		source: null,
		metadata: {},
		confidence: 1,
		embeddingModel: "exports-types",
		embeddingDimensions: 1,
		supersededBy: null,
		expiresAt: null,
		lastAccessedAt: null,
		accessCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	},
	b: {
		id: "mem_b",
		entityId: "entity",
		content: "b",
		type: "fact",
		importance: "normal",
		tags: [],
		source: null,
		metadata: {},
		confidence: 1,
		embeddingModel: "exports-types",
		embeddingDimensions: 1,
		supersededBy: null,
		expiresAt: null,
		lastAccessedAt: null,
		accessCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	},
	similarity: 0.99,
};

void client;
void remember;
void recall;
void context;
void explanation;
void findDuplicates;
void duplicatePair;
void MnemocyteError;
