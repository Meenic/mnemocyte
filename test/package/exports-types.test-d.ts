import type { PGlite } from "@electric-sql/pglite";
import type { drizzle as drizzleNodePostgres } from "drizzle-orm/node-postgres";
import type { drizzle as drizzlePGlite } from "drizzle-orm/pglite";
import type {
	drizzle as drizzlePostgresJs,
	PostgresJsDatabase,
} from "drizzle-orm/postgres-js";
import type {
	AddInput,
	AddManyInput,
	AuditConfig,
	AuditEvent,
	AuditLogCursor,
	BoundAddInput,
	BoundExperimentalMemoryClient,
	BoundGetInput,
	BoundMemoryClient,
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
	OptionalNamespaceScope,
	OptionalNamespaceSelector,
	PruneInput,
	RetrievalBoosts,
	RetrievalConfig,
	RetrievalExplanation,
	RetrievalFusionConfig,
	RetrievalScores,
	PostgresClient as RootPostgresClient,
	ScopeInput,
	ScopeSelector,
	ScopeSelectorInput,
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
	type DrizzleClient,
	type NodePostgresPool,
	type PGliteClient,
	type PostgresClient,
	type PostgresJsClient,
	type PostgresJsExecutor,
	type PostgresStoreOptions,
	postgresJs,
	postgresStore,
	type SqlExecutor,
	type SqlQueryOptions,
	type SqlStatement,
} from "mnemocyte/postgres";
import { drizzleStore } from "mnemocyte/stores/drizzle";
import type { Client, Pool } from "pg";
import type { ReservedSql, Sql, TransactionSql } from "postgres";
import type {
	Sql as Sql3,
	TransactionSql as TransactionSql3,
} from "postgres-3";

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
const postgresJsExecutor: PostgresJsExecutor = postgresJs(callerSql);
const statements: SqlStatement[] = [{ sql: "SELECT $1", params: [1] }];
const batched: Promise<Record<string, unknown>[][]> = postgresJsExecutor.batch(
	statements,
	queryOptions,
);
// An executor may implement batch without transaction (stateless drivers).
const batchOnlyExecutor: SqlExecutor = {
	query: async () => [],
	batch: async (input) => input.map(() => []),
};
const postgresOptions: PostgresStoreOptions = { client: executor };
// Each driver's own client fits postgresStore without a wrapper.
declare const postgresJsSql: Sql;
declare const nodePostgresPool: Pool;
declare const nodePostgresClient: Client;
declare const pglite: PGlite;
declare const drizzleOverPostgresJs: ReturnType<
	typeof drizzlePostgresJs<Record<string, never>, Sql>
>;
declare const drizzleOverPool: ReturnType<
	typeof drizzleNodePostgres<Record<string, never>, Pool>
>;
declare const drizzleOverPGlite: ReturnType<
	typeof drizzlePGlite<Record<string, never>, PGlite>
>;
const postgresJsClient: PostgresJsClient = postgresJsSql;
const nodePostgresPoolClient: NodePostgresPool = nodePostgresPool;
const pgliteClient: PGliteClient = pglite;
const drizzleClient: DrizzleClient = drizzleOverPool;
const driverClients: PostgresClient[] = [
	postgresJsSql,
	nodePostgresPool,
	pglite,
	drizzleOverPostgresJs,
	drizzleOverPool,
	drizzleOverPGlite,
	executor,
	batchOnlyExecutor,
];
for (const driverClient of driverClients) {
	postgresStore({ client: driverClient });
}
const drizzleStores: MnemocyteStoreConfig[] = [
	drizzleStore(drizzleOverPostgresJs),
	drizzleStore(drizzleOverPool),
	drizzleStore(drizzleOverPGlite),
];
// A node-postgres Client type-checks (its query fits SqlExecutor's, whose
// other methods are optional) and is rejected at runtime with "CONFIG".
postgresStore({ client: nodePostgresClient });
// postgres.js 3.x and 4.x, and the sql a transaction callback receives on
// either: savepoint only on 3.x, savepoint and begin on 4.x.
declare const postgresJs3Sql: Sql3;
declare const postgresJs3Tx: TransactionSql3;
declare const postgresJs4Tx: TransactionSql;
declare const postgresJs4Reserved: ReservedSql;
postgresStore({ client: postgresJs3Sql });
postgresStore({ client: postgresJs3Tx });
postgresStore({ client: postgresJs4Tx });
// @ts-expect-error A reserved connection has neither begin nor savepoint.
postgresStore({ client: postgresJs4Reserved });
// createMemory and migrate take the same clients as store, no wrapper; the
// root entry exports PostgresClient too.
const rootClients: RootPostgresClient[] = driverClients;
for (const driverClient of rootClients) {
	const direct: MemoryClient = createMemory({ store: driverClient, embedder });
	const defaulted: MemoryClient<true> = createMemory({
		namespace: "app",
		store: driverClient,
		embedder,
	});
	void direct;
	void defaulted;
	void migrate({ store: driverClient, dimensions: 1536 });
}
createMemory({ store: postgresJsSql, embedder });
createMemory({ store: postgresJs3Sql, embedder });
createMemory({ store: drizzleOverPGlite, embedder });
const clientConfig: MemoryConfig = { embedder, store: nodePostgresPool };
void clientConfig;
// @ts-expect-error A reserved connection has neither begin nor savepoint.
createMemory({ store: postgresJs4Reserved, embedder });
// @ts-expect-error A connection string is not a client.
createMemory({ store: "postgres://localhost/app", embedder });
void postgresJsClient;
void nodePostgresPoolClient;
void pgliteClient;
void drizzleClient;
void drizzleStores;
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
const migrateFromClient: MigrateInput = {
	memory: client,
	createExtension: true,
	dryRun: true,
};
const dryRunResult: Promise<boolean> = migrate(migrateFromClient).then(
	(result) => result.extensionCreated,
);
// @ts-expect-error migrate takes memory or store, not both.
const migrateBoth: MigrateInput = {
	memory: client,
	store: postgresStore(postgresOptions),
};
// @ts-expect-error migrate needs memory or store.
const migrateNeither: MigrateInput = { dimensions: 1536 };
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
void dryRunResult;
void migrateBoth;
void migrateNeither;
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
void batched;

// A default namespace makes the scope's namespace optional; without one it
// stays required.
const defaulted: MemoryClient<true> = createMemory({
	namespace: "app",
	embedder,
});
void defaulted.add({ scope: { entityId: "entity" }, content: "content" });
void defaulted.add({
	scope: { namespace: "other", entityId: "e" },
	content: "c",
});
void defaulted.stats({ scope: {} });
void defaulted.prune({ scope: { entityId: "entity" }, expired: true });
void defaulted.stats({ allNamespaces: true });
// @ts-expect-error Without a default namespace the scope needs one.
void client.add({ scope: { entityId: "entity" }, content: "content" });
// @ts-expect-error Without a default namespace for() needs one.
void client.for({ entityId: "entity" });
const optionalScope: OptionalNamespaceScope = { entityId: "entity" };
const optionalSelector: OptionalNamespaceSelector = {};
const scopeInput: ScopeInput<true> = optionalScope;
const fullScopeInput: ScopeInput = scope;
const selectorInput: ScopeSelectorInput<true> = optionalSelector;
const defaultedAsMigrateInput: MigrateInput = { memory: defaulted };

// A bound client takes no scope and cannot reach across namespaces.
const bound: BoundMemoryClient = defaulted.for({ entityId: "entity" });
const boundScope: Readonly<MemoryScope> = bound.scope;
const boundAdd: BoundAddInput = { content: "content", key: "key" };
const boundGet: BoundGetInput = { key: "key" };
void bound.add(boundAdd);
void bound.get(boundGet);
void bound.list();
void bound.findDuplicates();
void bound.listAuditLog();
const boundStats: Promise<MemoryStats> = bound.stats();
const boundErased: Promise<{ deletedCount: number }> = bound.deleteScope();
void bound.prune({ expired: true, dryRun: true });
const boundExperimental: BoundExperimentalMemoryClient = bound.experimental;
void boundExperimental.consolidate({ survivorId: "a", supersededIds: ["b"] });
const boundMigrate: MigrateInput = { memory: bound };
// @ts-expect-error A bound client takes no scope.
void bound.add({ scope, content: "content" });
// @ts-expect-error A bound client has no allNamespaces.
void bound.prune({ allNamespaces: true, expired: true });
// @ts-expect-error A bound client's stats takes no input.
void bound.stats({ allNamespaces: true });
// @ts-expect-error A bound client cannot be bound again.
void bound.for;
// @ts-expect-error get takes an id or a key, not both.
void bound.get({ id: "id", key: "key" });

void scopeInput;
void fullScopeInput;
void selectorInput;
void defaultedAsMigrateInput;
void boundScope;
void boundStats;
void boundErased;
void boundMigrate;
void batchOnlyExecutor;
