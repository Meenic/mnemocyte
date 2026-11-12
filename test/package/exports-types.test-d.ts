import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type {
	AddInput,
	AddManyInput,
	AuditConfig,
	AuditEvent,
	AuditLogCursor,
	ConsolidateInput,
	ConsolidateResult,
	ContextFormat,
	ContextInput,
	DuplicatePair,
	Embedder,
	ExperimentalMemoryClient,
	FindDuplicatesInput,
	JsonObject,
	JsonValue,
	ListAuditLogInput,
	ListResult,
	Memory,
	MemoryClient,
	MemoryConfig,
	MemoryKind,
	MemoryScope,
	MemoryStats,
	MigrateInput,
	MigrateResult,
	MnemocyteErrorCode,
	MnemocyteStoreConfig,
	NewMemory,
	PruneInput,
	RetrievalBoosts,
	RetrievalConfig,
	RetrievalExplanation,
	RetrievalFusionConfig,
	RetrievalScores,
	ScopeSelector,
	SearchInput,
	TokenCounter,
	UpdateInput,
} from "mnemocyte";
import { createMemory, MnemocyteError, migrate } from "mnemocyte";
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

const scope: MemoryScope = {
	namespace: "app",
	entityId: "entity",
	agentId: "agent",
	sessionId: "session",
};
const recordScope = {
	namespace: "app",
	entityId: "entity",
	agentId: null,
	sessionId: null,
};
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
const config: MemoryConfig = { embedder, retrieval };
declare const callerDatabase: PostgresJsDatabase<{
	applicationTable: unknown;
}>;
const callerStore: MnemocyteStoreConfig = drizzleStore(callerDatabase);
const callerStoreConfig: MemoryConfig = {
	embedder,
	store: callerStore,
};
declare const callerSql: Parameters<typeof postgresJs>[0];
const executor: SqlExecutor = postgresJs(callerSql);
const queryOptions: SqlQueryOptions = { signal: new AbortController().signal };
const postgresOptions: PostgresStoreOptions = { client: executor };
const postgresConfig: MemoryConfig = {
	embedder,
	store: postgresStore(postgresOptions),
};
const migrateInput: MigrateInput = {
	store: postgresStore(postgresOptions),
	dimensions: 1536,
	signal: new AbortController().signal,
};
const migrated: Promise<MigrateResult> = migrate(migrateInput);
const client: MemoryClient = createMemory(config);
const conflictCode: MnemocyteErrorCode = "CONFLICT";
const conflictError = new MnemocyteError("conflict", conflictCode);
const jsonValue: JsonValue = ["value", 1, true, null, { nested: "value" }];
const jsonObject: JsonObject = { value: jsonValue };
const kind: MemoryKind = "preference";
const add: AddInput = {
	scope,
	key: "key",
	content: "content",
	kind,
	metadata: jsonObject,
};
const newMemory: NewMemory = { content: "content", key: "other" };
const addMany: AddManyInput = {
	scope,
	memories: [newMemory],
	signal: new AbortController().signal,
};
const search: SearchInput = {
	scope,
	query: "query",
	kinds: [kind],
	exactAgent: true,
};
const update: UpdateInput = {
	scope,
	id: "id",
	key: null,
	expiresAt: null,
	source: null,
};
const selector: ScopeSelector = { namespace: "app" };
const prune: PruneInput = { scope: selector, expired: true };
const pruneAll: PruneInput = { allNamespaces: true, expired: true };
const listed: Promise<ListResult> = client.list({ scope, cursor: "c" });
const fetched: Promise<Memory | null> = client.get({ scope, key: "key" });
const stats: Promise<MemoryStats> = client.stats({ allNamespaces: true });
const erased: Promise<{ deletedCount: number }> = client.deleteScope({
	scope: { namespace: "app", entityId: "entity" },
});
// @ts-expect-error The client holds no resources and has no close().
void client.close;
// @ts-expect-error prune needs a scope or allNamespaces.
const unscopedPrune: PruneInput = { expired: true };
// @ts-expect-error get takes an id or a key, not both.
void client.get({ scope, id: "id", key: "key" });
// @ts-expect-error A scope needs an entity.
const entitylessScope: MemoryScope = { namespace: "app" };
const context: ContextInput = {
	scope,
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
	scope,
	threshold: 0.95,
};
const duplicatePair: DuplicatePair = {
	a: {
		id: "mem_a",
		scope: recordScope,
		key: null,
		content: "a",
		kind: "fact",
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
		scope: recordScope,
		key: null,
		content: "b",
		kind: "fact",
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
	scope,
	limit: 50,
	beforeCursor: auditCursor,
};
const auditEvent: AuditEvent = {
	id: "evt_x",
	scope: recordScope,
	description: "memory.created",
	metadata: {},
	timestamp: new Date(),
};

const consolidate: ConsolidateInput = {
	scope,
	survivorId: "mem_a",
	supersededIds: ["mem_b"],
};
const consolidateResult: ConsolidateResult = {
	survivorId: "mem_a",
	supersededCount: 1,
	supersededIds: ["mem_b"],
};
const experimental: ExperimentalMemoryClient = client.experimental;
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
void add;
void addMany;
void client.add(add);
void client.addMany(addMany);
void search;
void update;
void prune;
void pruneAll;
void listed;
void fetched;
void stats;
void erased;
void unscopedPrune;
void entitylessScope;
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
