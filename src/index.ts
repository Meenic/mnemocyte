/**
 * Mnemocyte: memory for TypeScript AI apps, stored in your own database.
 *
 * @example Basic usage
 * ```ts
 * import { createMemory } from "mnemocyte";
 *
 * const memory = createMemory({
 *   embedder: {
 *     model: "demo",
 *     dimensions: 3,
 *     async embed(texts) {
 *       return texts.map((text) => [text.length, 1, 0]);
 *     },
 *   },
 * });
 *
 * const scope = { namespace: "my-app", entityId: "user_123" };
 *
 * await memory.add({
 *   scope,
 *   content: "Prefers short, direct answers.",
 *   kind: "preference",
 * });
 *
 * const results = await memory.search({
 *   scope,
 *   query: "How should I respond?",
 *   limit: 5,
 * });
 * ```
 *
 * @packageDocumentation
 */

export { createMemory } from "./client.js";
export type {
	MnemocyteErrorCode,
	MnemocyteErrorInput,
	MnemocyteErrorReason,
	ProviderErrorInput,
} from "./errors.js";
export {
	isMnemocyteError,
	isProviderError,
	MnemocyteError,
	ProviderError,
} from "./errors.js";
export { migrate, setTextSearchConfig } from "./migrate.js";
export type {
	LibsqlClient,
	LibsqlDriverClient,
	PostgresClient,
} from "./sql/detect.js";
export type {
	AddInput,
	AddManyInput,
	AuditConfig,
	AuditEvent,
	AuditEventType,
	BoundAddInput,
	BoundAddManyInput,
	BoundConsolidateInput,
	BoundContextInput,
	BoundContextWithMemoriesInput,
	BoundDeleteInput,
	BoundDeleteScopeInput,
	BoundExperimentalMemoryClient,
	BoundFindDuplicatesInput,
	BoundFindDuplicatesPageInput,
	BoundGetInput,
	BoundListAuditLogInput,
	BoundListInput,
	BoundMemoryClient,
	BoundPruneAuditLogInput,
	BoundPruneInput,
	BoundSearchInput,
	BoundStatsInput,
	BoundUpdateInput,
	ConsolidateInput,
	ConsolidateResult,
	ContextFormat,
	ContextInput,
	ContextWithMemoriesInput,
	ContextWithMemoriesResult,
	DeleteInput,
	DeleteResult,
	DeleteScopeInput,
	DeleteScopeResult,
	DependentsPolicy,
	DuplicatePage,
	DuplicatePair,
	Embedder,
	EmbeddingPurpose,
	EmbedOptions,
	ExperimentalMemoryClient,
	FindDuplicatesInput,
	FindDuplicatesPageInput,
	GetInput,
	ImportanceLevel,
	JsonObject,
	JsonValue,
	ListAuditLogInput,
	ListAuditLogOptions,
	ListAuditLogResult,
	ListInput,
	ListResult,
	Memory,
	MemoryClient,
	MemoryConfig,
	MemoryKind,
	MemoryRecordScope,
	MemoryScope,
	MemoryStats,
	MemoryWithScore,
	MigrateInput,
	MigrateResult,
	MnemocyteBackend,
	MnemocyteObservation,
	MnemocyteObservationPhase,
	MnemocyteOperation,
	MnemocyteStoreConfig,
	NewMemory,
	ObservabilityConfig,
	OptionalNamespaceScope,
	OptionalNamespaceSelector,
	ProviderResilienceConfig,
	PruneAuditLogInput,
	PruneAuditLogOptions,
	PruneAuditLogResult,
	PruneInput,
	PruneResult,
	PruneSelectors,
	RetrievalBoosts,
	RetrievalConfig,
	RetrievalExplanation,
	RetrievalFusionConfig,
	RetrievalScores,
	ScopedReadOptions,
	ScopeInput,
	ScopeSelector,
	ScopeSelectorInput,
	SearchInput,
	SetTextSearchConfigInput,
	StatsInput,
	TextSearchConfigResult,
	TokenCounter,
	UpdateInput,
} from "./types.js";
