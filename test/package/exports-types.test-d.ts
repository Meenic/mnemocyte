import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
	AuditConfig,
	AuditEvent,
	AuditLogCursor,
	BuildContextInput,
	ConsolidateInput,
	ConsolidateResult,
	ContextFormat,
	DuplicatePair,
	Embedder,
	ExperimentalMnemocyteClient,
	FindDuplicatesInput,
	JsonObject,
	JsonValue,
	ListAuditLogInput,
	MigrateInput,
	MigrateResult,
	MnemocyteClient,
	MnemocyteConfig,
	MnemocyteErrorCode,
	MnemocyteStoreConfig,
	RecallInput,
	RememberInput,
	RememberManyInput,
	RetrievalBoosts,
	RetrievalConfig,
	RetrievalExplanation,
	RetrievalFusionConfig,
	RetrievalScores,
	TokenCounter,
} from "mnemocyte";
import { createMnemocyte, MnemocyteError, migrate } from "mnemocyte";
import {
	type OpenAIEmbedderOptions,
	openaiEmbedder,
} from "mnemocyte/embedders";
import {
	type OpenAIEmbedderOptions as DirectOpenAIEmbedderOptions,
	openaiEmbedder as directOpenAIEmbedder,
} from "mnemocyte/embedders/openai";
import {
	type PostgresStoreOptions,
	postgresJs,
	postgresStore,
	type SqlExecutor,
	type SqlQueryOptions,
} from "mnemocyte/postgres";
import { drizzleStore } from "mnemocyte/stores/drizzle";

const format: ContextFormat = "markdown";
const fusion: RetrievalFusionConfig = { k: 60, lexical: 0.5 };
const boosts: RetrievalBoosts = { recency: 0 };
const retrieval: RetrievalConfig = { fusion, boosts };
const counter: TokenCounter = { count: (text) => text.length };
const embedder: Embedder = {
	model: "exports-types",
	dimensions: 1,
	embed: async (texts) => texts.map(() => [1]),
};
const config: MnemocyteConfig = { embedder, retrieval };
declare const callerDatabase: PostgresJsDatabase<{
	applicationTable: unknown;
}>;
const callerStore: MnemocyteStoreConfig = drizzleStore(callerDatabase);
const callerStoreConfig: MnemocyteConfig = {
	embedder,
	store: callerStore,
};
declare const callerSql: Parameters<typeof postgresJs>[0];
const executor: SqlExecutor = postgresJs(callerSql);
const queryOptions: SqlQueryOptions = { signal: new AbortController().signal };
const postgresOptions: PostgresStoreOptions = { client: executor };
const postgresConfig: MnemocyteConfig = {
	embedder,
	store: postgresStore(postgresOptions),
};
const migrateInput: MigrateInput = {
	store: postgresStore(postgresOptions),
	dimensions: 1536,
	signal: new AbortController().signal,
};
const migrated: Promise<MigrateResult> = migrate(migrateInput);
const client: MnemocyteClient = createMnemocyte(config);
const conflictCode: MnemocyteErrorCode = "CONFLICT";
const conflictError = new MnemocyteError("conflict", conflictCode);
const jsonValue: JsonValue = ["value", 1, true, null, { nested: "value" }];
const jsonObject: JsonObject = { value: jsonValue };
const remember: RememberInput = {
	entityId: "entity",
	content: "content",
	metadata: jsonObject,
};
const rememberMany: RememberManyInput = {
	inputs: [remember],
	signal: new AbortController().signal,
};
const recall: RecallInput = { entityId: "entity", query: "query" };
const context: BuildContextInput = {
	entityId: "entity",
	query: "query",
	format,
	tokenCounter: counter,
};
const scores: RetrievalScores = {
	vectorRank: 1,
	lexicalRank: null,
	vector: 1,
	lexical: null,
	fused: 0.5,
	recency: 1,
	importance: 0.5,
};
const explanation: RetrievalExplanation = {
	fusion: { k: 60, vector: 1, lexical: 1 },
	boosts: { recency: 0.1, importance: 0.1 },
	boostFactor: 1,
	finalScore: scores.fused,
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
		supersededAt: null,
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
		supersededAt: null,
		expiresAt: null,
		lastAccessedAt: null,
		accessCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	},
	similarity: 0.99,
};

const auditConfig: AuditConfig = { enabled: true };
const auditCursor: AuditLogCursor = {
	timestamp: new Date(),
	id: "evt_cursor",
};
const listAudit: ListAuditLogInput = {
	entityId: "entity",
	limit: 50,
	beforeCursor: auditCursor,
};
const auditEvent: AuditEvent = {
	id: "evt_x",
	entityId: "entity",
	description: "memory.created",
	metadata: {},
	timestamp: new Date(),
};

const consolidate: ConsolidateInput = {
	entityId: "entity",
	survivorId: "mem_a",
	supersededIds: ["mem_b"],
};
const consolidateResult: ConsolidateResult = {
	survivorId: "mem_a",
	supersededCount: 1,
	supersededIds: ["mem_b"],
};
const experimental: ExperimentalMnemocyteClient = client.experimental;
const openaiOptions: OpenAIEmbedderOptions = {
	model: "text-embedding-3-small",
	dimensions: 1536,
};
const openai = openaiEmbedder(openaiOptions);
const directOpenaiOptions: DirectOpenAIEmbedderOptions = {
	model: "text-embedding-3-small",
};
const directOpenai = directOpenAIEmbedder(directOpenaiOptions);

void client;
void migrated;
void callerStoreConfig;
void postgresConfig;
void queryOptions;
void conflictCode;
void conflictError;
void jsonValue;
void jsonObject;
void remember;
void rememberMany;
void client.rememberMany(rememberMany);
void client.rememberMany([remember]);
void recall;
void context;
void explanation;
void findDuplicates;
void duplicatePair;
void auditConfig;
void listAudit;
void auditEvent;
void consolidate;
void consolidateResult;
void experimental;
void MnemocyteError;
void openai;
void directOpenai;
