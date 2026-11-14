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
export type { MnemocyteErrorCode, ProviderErrorInput } from "./errors.js";
export { isMnemocyteError, MnemocyteError, ProviderError } from "./errors.js";
export { migrate } from "./migrate.js";
export type { PostgresClient } from "./sql/detect.js";
export type {
	AddInput,
	AddManyInput,
	AuditConfig,
	AuditEvent,
	AuditLogCursor,
	BoundAddInput,
	BoundAddManyInput,
	BoundConsolidateInput,
	BoundContextInput,
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
	BoundSearchInput,
	BoundUpdateInput,
	ConsolidateInput,
	ConsolidateResult,
	ContextFormat,
	ContextInput,
	DeleteInput,
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
	StatsInput,
	TokenCounter,
	UpdateInput,
} from "./types.js";
