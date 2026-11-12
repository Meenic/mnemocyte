/**
 * What kind of memory a {@link Memory} is.
 *
 * - `"fact"`: a stable, objective statement.
 * - `"preference"`: a preference that should shape future responses.
 * - `"instruction"`: a directive the agent should follow.
 * - `"backstory"`: long-lived background about the entity.
 * - `"episode"`: a discrete past event.
 * - `"session"`: short-lived context tied to one session.
 *
 * @defaultValue `"fact"` when omitted on {@link NewMemory}.
 */
export type MemoryKind =
	| "fact"
	| "preference"
	| "instruction"
	| "backstory"
	| "episode"
	| "session";

/**
 * Relative importance of a memory. Gives a small ranking boost in
 * {@link MemoryClient.search}.
 *
 * @defaultValue `"normal"` when omitted on {@link NewMemory}.
 */
export type ImportanceLevel = "low" | "normal" | "high" | "critical";

/**
 * Output format of {@link MemoryClient.context}.
 *
 * - `"markdown"`: headings and fenced blocks (default).
 * - `"plain"`: fenced plain-text blocks.
 * - `"xml"`: escaped XML elements.
 *
 * @defaultValue `"markdown"`
 */
export type ContextFormat = "markdown" | "plain" | "xml";

/**
 * A value that can be persisted losslessly as JSON.
 *
 * Metadata rejects unsupported runtime values such as `undefined`, functions,
 * symbols, bigints, non-finite numbers, class instances, and cyclic objects.
 */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonObject
	| JsonValue[];

/** A JSON-compatible object used for persisted memory and audit metadata. */
export interface JsonObject {
	[key: string]: JsonValue;
}

/**
 * Where a memory lives. Every read and write names one.
 *
 * - `namespace`: the tenant or application. Required.
 * - `entityId`: who or what the memory is about (a user, a customer, a
 *   repository). Required.
 * - `agentId`: who holds the memory. Omitted means shared by every agent.
 * - `sessionId`: short-lived context. Omitted means not tied to a session.
 *
 * Reads at a scope also see shared memories: searching at
 * `{ namespace, entityId, agentId: "a" }` returns the memories agent `"a"`
 * holds plus those with no agent. `exactAgent` / `exactSession` turn that off.
 * A scope without `agentId` sees only memories with no agent.
 */
export interface MemoryScope {
	/** Tenant or application. Non-empty. */
	namespace: string;
	/** Who or what the memory is about. Non-empty. */
	entityId: string;
	/** Agent that holds the memory; omit for memories shared by every agent. */
	agentId?: string;
	/** Session the memory belongs to; omit for memories outside any session. */
	sessionId?: string;
}

/**
 * Selects memories by scope for bulk operations
 * ({@link MemoryClient.prune}, {@link MemoryClient.stats}). Fields that are
 * set must match exactly; fields that are omitted match any value, so
 * `{ namespace: "app" }` covers every entity, agent and session in `"app"`.
 */
export interface ScopeSelector {
	/** Tenant or application. Non-empty. */
	namespace: string;
	/** Limit to one entity. */
	entityId?: string;
	/** Limit to memories this agent holds (not shared ones). */
	agentId?: string;
	/** Limit to memories of this session (not session-less ones). */
	sessionId?: string;
}

/**
 * The scope stored with a memory or audit event. `agentId` and `sessionId`
 * are `null` for memories shared by every agent or outside any session.
 */
export interface MemoryRecordScope {
	namespace: string;
	entityId: string;
	agentId: string | null;
	sessionId: string | null;
}

/**
 * A {@link MemoryScope} whose `namespace` may be omitted. Calls on a client
 * created with {@link MemoryConfig.namespace} take it: an omitted namespace
 * is the client's default, and one the scope names wins.
 */
export interface OptionalNamespaceScope {
	/** Tenant or application. Defaults to {@link MemoryConfig.namespace}. */
	namespace?: string;
	/** Who or what the memory is about. Non-empty. */
	entityId: string;
	/** Agent that holds the memory; omit for memories shared by every agent. */
	agentId?: string;
	/** Session the memory belongs to; omit for memories outside any session. */
	sessionId?: string;
}

/**
 * A {@link ScopeSelector} whose `namespace` may be omitted, for a client
 * created with {@link MemoryConfig.namespace}.
 */
export interface OptionalNamespaceSelector {
	/** Tenant or application. Defaults to {@link MemoryConfig.namespace}. */
	namespace?: string;
	/** Limit to one entity. */
	entityId?: string;
	/** Limit to memories this agent holds (not shared ones). */
	agentId?: string;
	/** Limit to memories of this session (not session-less ones). */
	sessionId?: string;
}

/**
 * The scope a {@link MemoryClient} method takes: {@link MemoryScope}, or
 * {@link OptionalNamespaceScope} when the client has a default namespace.
 */
export type ScopeInput<DefaultNamespace extends boolean = false> =
	DefaultNamespace extends true ? OptionalNamespaceScope : MemoryScope;

/**
 * The selector {@link MemoryClient.prune} and {@link MemoryClient.stats}
 * take: {@link ScopeSelector}, or {@link OptionalNamespaceSelector} when the
 * client has a default namespace.
 */
export type ScopeSelectorInput<DefaultNamespace extends boolean = false> =
	DefaultNamespace extends true ? OptionalNamespaceSelector : ScopeSelector;

/**
 * Identifies which backend a {@link MemoryClient} is using: the configured
 * {@link MemoryConfig.store}, or in-memory storage when none is supplied.
 */
export type MnemocyteBackend = "in-memory" | "postgres";

/**
 * The {@link MemoryClient} methods that emit {@link MnemocyteObservation}
 * events through {@link ObservabilityConfig.onEvent}, plus `"trackAccess"`:
 * the access write a tracked search starts after its results are ready (see
 * {@link RetrievalConfig.trackAccess}).
 */
export type MnemocyteOperation =
	| "add"
	| "addMany"
	| "search"
	| "get"
	| "list"
	| "update"
	| "delete"
	| "deleteScope"
	| "context"
	| "prune"
	| "findDuplicates"
	| "listAuditLog"
	| "consolidate"
	| "stats"
	| "trackAccess";

/**
 * Lifecycle phase of a {@link MnemocyteObservation}.
 *
 * Every operation emits exactly one `"start"` event and exactly one of
 * `"success"` or `"error"` once it settles.
 */
export type MnemocyteObservationPhase = "start" | "success" | "error";

/**
 * A single observability event emitted by a {@link MemoryClient}.
 *
 * Delivered to {@link ObservabilityConfig.onEvent} for tracing, metrics,
 * and structured logging.
 */
export interface MnemocyteObservation {
	/** Operation that produced this event. */
	operation: MnemocyteOperation;
	/** Lifecycle phase: `"start"`, `"success"`, or `"error"`. */
	phase: MnemocyteObservationPhase;
	/** Backend handling the operation. */
	backend: MnemocyteBackend;
	/** Wall-clock timestamp of this event. */
	timestamp: Date;
	/** Elapsed milliseconds since the `"start"` event. Present on `"success"` / `"error"`. */
	durationMs?: number;
	/** Namespace of the operation's scope, when it has one. */
	namespace?: string;
	/** Entity of the operation's scope, when it has one. */
	entityId?: string;
	/** Memory ID associated with the operation, when applicable. */
	memoryId?: string;
	/** Number of items processed (e.g. memories returned, batch size). */
	count?: number;
	/** Thrown value. Present only on `"error"`. */
	error?: unknown;
}

/**
 * Hooks for observing client activity.
 *
 * Exceptions thrown by {@link ObservabilityConfig.onEvent} are swallowed so
 * that telemetry never affects application logic.
 */
export interface ObservabilityConfig {
	/**
	 * Called for every lifecycle event of every operation. Receives a single
	 * {@link MnemocyteObservation}. May be sync or async; it is awaited, so a
	 * slow async hook delays the operation.
	 */
	onEvent?: (event: MnemocyteObservation) => void | Promise<void>;
}

/**
 * Production-hardening knobs applied to outbound provider calls
 * (currently the {@link Embedder}). Mnemocyte applies a timeout, retries
 * on transient failures, and forwards `AbortSignal` cancellation to each
 * attempt. Every field is optional; the defaults disable retries and
 * timeouts.
 */
export interface ProviderResilienceConfig {
	/**
	 * Maximum time, in milliseconds, that a single provider attempt may
	 * run before a {@link MnemocyteError} with code `"TIMEOUT"` is thrown.
	 * Must be a non-negative finite number. Defaults to `0` which disables the
	 * timeout.
	 */
	timeoutMs?: number;
	/**
	 * Maximum number of retry attempts after the initial call. Must be a
	 * non-negative integer. `0` disables retries (default).
	 */
	retries?: number;
	/**
	 * Base backoff delay (ms) used before the first retry. Must be a
	 * non-negative finite number. Defaults to `100`.
	 */
	baseDelayMs?: number;
	/**
	 * Maximum backoff delay (ms) used between retries. Must be a non-negative
	 * finite number. Values below `baseDelayMs` are normalized up to the base
	 * delay. Defaults to `2000`.
	 */
	maxDelayMs?: number;
	/**
	 * Optional predicate deciding whether `error` should trigger a retry.
	 * Receives the thrown value and the 1-indexed `attempt` number that
	 * just failed. When omitted, a conservative built-in heuristic is used
	 * that retries on common transient indicators (network errors, 5xx
	 * responses, rate-limit hints) and never retries `"VALIDATION"`,
	 * `"CONFIG"`, or `"ABORTED"` {@link MnemocyteError}s.
	 */
	shouldRetry?: (error: unknown, attempt: number) => boolean;
}

declare const mnemocyteStoreConfigBrand: unique symbol;

/**
 * Opaque storage-adapter value accepted by {@link MemoryConfig.store}.
 *
 * Obtain this value from a supported adapter factory such as `postgresStore()`
 * from `mnemocyte/postgres` or `drizzleStore()` from
 * `mnemocyte/stores/drizzle`. The underlying `MemoryStore` contract stays
 * internal; this type intentionally exposes no adapter implementation methods.
 */
export interface MnemocyteStoreConfig {
	readonly [mnemocyteStoreConfigBrand]: true;
}

/** Options {@link migrate} takes with either input shape. */
interface MigrateOptions {
	/**
	 * Run `CREATE EXTENSION IF NOT EXISTS vector` when pgvector is missing,
	 * in the fresh install's transaction, before the schema. Off by default:
	 * pgvector is not a trusted extension, so this needs a superuser or a
	 * provider's admin role (`rds_superuser`, `neon_superuser`, Supabase's
	 * `postgres`). Without the privilege it rejects with `"MIGRATION"`.
	 */
	createExtension?: boolean;
	/**
	 * Inspect the database as a real run would and return the `applied`,
	 * `adopted` and `extensionCreated` it would produce, changing nothing.
	 * It rejects with the errors a real run would raise before its first
	 * statement; a migration that would fail partway through is not detected.
	 */
	dryRun?: boolean;
	/**
	 * Cancels the running statement when aborted. The migration in progress
	 * rolls back; migrations that already committed stay applied.
	 */
	signal?: AbortSignal;
}

/**
 * Input for {@link migrate}: the app's client, or a store with the
 * dimensions written out.
 */
export type MigrateInput =
	| (MigrateOptions & {
			/**
			 * The client from `createMemory()`, or one bound with `for()`. Its
			 * store is migrated and its `embedder.dimensions` fixes the vector
			 * column on a fresh install.
			 */
			memory: MemoryClient<boolean> | BoundMemoryClient;
			store?: never;
			/**
			 * Optional here. A value that differs from `embedder.dimensions`
			 * rejects with `"CONFIG"` before anything runs.
			 */
			dimensions?: number;
	  })
	| (MigrateOptions & {
			memory?: never;
			/** The store to migrate, from `postgresStore()` or `drizzleStore()`. */
			store: MnemocyteStoreConfig;
			/**
			 * Embedding dimensions of the installation. Required on a database
			 * with no Mnemocyte tables, where it fixes the vector column for good:
			 * `vector` up to 2,000 dimensions, `halfvec` up to 4,000. On an
			 * existing installation it is optional, and a value that differs from
			 * the installed column rejects with `"CONFIG"` before anything runs.
			 */
			dimensions?: number;
	  });

/**
 * Result of {@link migrate}. Names are migration file names without the
 * extension, such as `"0003_schema_v2"`. With `dryRun`, what the call would
 * have produced.
 */
export interface MigrateResult {
	/**
	 * Migrations this call applied, in order. A fresh install creates the
	 * final schema in one step and lists every migration it contains.
	 */
	applied: string[];
	/**
	 * Migrations found already applied in a database that had Mnemocyte tables
	 * but no `mnemocyte_migrations` table (installed with `psql` or
	 * drizzle-kit). They are recorded without running again.
	 */
	adopted: string[];
	/**
	 * True when this call ran `CREATE EXTENSION vector` (`createExtension`);
	 * false when pgvector was already installed or nothing was created.
	 */
	extensionCreated: boolean;
}

/**
 * Configuration passed to {@link createMemory}.
 */
export interface MemoryConfig {
	/**
	 * Default namespace for every call. A scope that omits `namespace` gets
	 * this one; a scope that names its own wins, so multi-tenant apps can keep
	 * per-call namespaces. Non-empty, at most 256 bytes in UTF-8. With it set,
	 * {@link createMemory} returns a `MemoryClient<true>`, whose scopes take
	 * an optional namespace.
	 */
	namespace?: string;
	/**
	 * Caller-supplied storage adapter. Use `postgresStore({ client })` from
	 * `mnemocyte/postgres` with the database client you already own, or
	 * `drizzleStore(db)` from `mnemocyte/stores/drizzle` for a postgres.js
	 * Drizzle instance. When omitted, an in-memory backend is used.
	 */
	store?: MnemocyteStoreConfig;
	/** Required embedder used to vectorise content for storage and retrieval. */
	embedder: Embedder;
	/** Default values applied to {@link SearchInput} when properties are omitted. */
	defaults?: {
		/** Default `limit` for {@link MemoryClient.search}. */
		limit?: number;
		/** Default `minScore` cutoff for {@link MemoryClient.search}. */
		minScore?: number;
	};
	/** Retrieval-ranking tuning. See {@link RetrievalConfig}. */
	retrieval?: RetrievalConfig;
	/** Observability hooks. See {@link ObservabilityConfig}. */
	observability?: ObservabilityConfig;
	/**
	 * Production-hardening knobs for outbound provider calls
	 * (timeouts, retries, abort propagation). See
	 * {@link ProviderResilienceConfig}.
	 */
	provider?: ProviderResilienceConfig;
	/**
	 * Audit-log configuration. When enabled, Mnemocyte records an
	 * {@link AuditEvent} for every change to a memory. Read with
	 * {@link MemoryClient.listAuditLog}.
	 */
	audit?: AuditConfig;
}

/**
 * Audit-log configuration. See {@link MemoryConfig.audit}.
 */
export interface AuditConfig {
	/**
	 * Master switch for audit logging. When `false` (default), Mnemocyte
	 * writes no audit events; existing events stay readable through
	 * {@link MemoryClient.listAuditLog}.
	 *
	 * @defaultValue `false`
	 */
	enabled?: boolean;
}

/**
 * Pluggable embedding provider. Wraps an external embedding API
 * (e.g. OpenAI, Cohere, a local model) in a small interface.
 *
 * Mnemocyte records {@link Embedder.model} and {@link Embedder.dimensions}
 * on every stored memory. The Postgres backend also records both values as
 * installation metadata and rejects embedding-dependent operations when the
 * configured embedder is incompatible.
 */
export interface Embedder {
	/** Stable identifier for the underlying model (e.g. `"text-embedding-3-small"`). */
	readonly model: string;
	/** Dimensionality of vectors returned by {@link Embedder.embed}. */
	readonly dimensions: number;
	/**
	 * Embed one or more texts. Implementations MUST return one vector per
	 * input, in the same order, each of length {@link Embedder.dimensions} and
	 * containing only finite numeric values.
	 *
	 * `options.signal` is the caller's `signal` (or Mnemocyte's provider
	 * timeout). Implementations that call `fetch` should forward it so
	 * requests can be cancelled promptly.
	 */
	embed(
		texts: readonly string[],
		options?: { signal?: AbortSignal },
	): Promise<number[][]>;
}

/**
 * A stored memory as returned by the client. Returned records are detached
 * copies.
 */
export interface Memory {
	/** Unique identifier: a UUIDv7 string. */
	id: string;
	/** Where the memory lives. */
	scope: MemoryRecordScope;
	/**
	 * Caller-chosen key, unique within the memory's exact scope, or `null`.
	 * Adding a memory with an existing key updates that memory.
	 */
	key: string | null;
	/** Raw textual content of the memory. */
	content: string;
	/** What kind of memory it is. */
	kind: MemoryKind;
	/** Relative importance. */
	importance: ImportanceLevel;
	/** Free-form tags used for filtering. */
	tags: string[];
	/** Optional human-readable source attribution (e.g. `"chat:2024-04-12"`). */
	source: string | null;
	/** JSON-compatible metadata persisted by value alongside the memory. */
	metadata: JsonObject;
	/** Confidence in `[0, 1]`. Stored for callers; search does not rank by it. */
	confidence: number;
	/** {@link Embedder.model} value at the last write of the content. */
	embeddingModel: string;
	/** {@link Embedder.dimensions} value at the last write of the content. */
	embeddingDimensions: number;
	/** ID of the memory that supersedes this one, or `null` if active. */
	supersededBy: string | null;
	/**
	 * When this memory was superseded, or `null`. Set together with
	 * {@link Memory.supersededBy} by
	 * {@link ExperimentalMemoryClient.consolidate}.
	 */
	supersededAt: Date | null;
	/** Optional expiry; expired memories are filtered out by default. */
	expiresAt: Date | null;
	/**
	 * Last time a search with access tracking returned this memory; `null`
	 * if none has. See {@link RetrievalConfig.trackAccess}.
	 */
	lastAccessedAt: Date | null;
	/** Number of searches with access tracking that returned this memory. */
	accessCount: number;
	/** Creation timestamp. Kept when a keyed add updates the memory. */
	createdAt: Date;
	/** Most recent write timestamp. Searches never change it. */
	updatedAt: Date;
}

/**
 * Per-component values behind a search result's
 * {@link MemoryWithScore.score}. Ranks are 1-based positions in each
 * candidate list; a memory missing from a list has `null` for that list's
 * rank and score.
 */
export interface RetrievalScores {
	/** Position in the vector (nearest-neighbour) list, or `null`. */
	vectorRank: number | null;
	/** Position in the lexical (full-text) list, or `null`. */
	lexicalRank: number | null;
	/** Cosine similarity clamped to `[0, 1]`, or `null` when not in the vector list. */
	vector: number | null;
	/**
	 * Backend-defined lexical score (`ts_rank` on Postgres, the fraction of
	 * query terms found on the in-memory store), or `null` when not in the
	 * lexical list. Only comparable within one search on one backend.
	 */
	lexical: number | null;
	/** Reciprocal rank fusion score in `[0, 1]`, before boosts. */
	fused: number;
	/** Time-decay score in `[0, 1]` based on {@link RetrievalConfig.recencyHalfLifeDays}. */
	recency: number;
	/** Score in `[0, 1]` derived from {@link ImportanceLevel}. */
	importance: number;
}

/**
 * Reciprocal rank fusion settings. Each list contributes
 * `weight / (k + rank)`; the sum is divided by its best possible value.
 */
export interface RetrievalFusionConfig {
	/** Non-negative finite rank constant. Larger values flatten rank differences. @defaultValue `60` */
	k?: number;
	/** Non-negative finite weight of the vector list. `0` skips the vector search. @defaultValue `1` */
	vector?: number;
	/** Non-negative finite weight of the lexical list. `0` skips the lexical search. @defaultValue `1` */
	lexical?: number;
}

/**
 * Boosts that scale the fused score by
 * `(1 + recency × recencyScore + importance × importanceScore) / (1 + recency + importance)`.
 * `0` turns a boost off.
 */
export interface RetrievalBoosts {
	/** Non-negative finite strength of the recency boost. @defaultValue `0.1` */
	recency?: number;
	/** Non-negative finite strength of the importance boost. @defaultValue `0.1` */
	importance?: number;
}

/**
 * Retrieval-ranking tuning. All fields are optional; sensible defaults are
 * used for any field that is omitted.
 */
export interface RetrievalConfig {
	/** Reciprocal rank fusion settings. See {@link RetrievalFusionConfig}. */
	fusion?: RetrievalFusionConfig;
	/** Recency and importance boosts. See {@link RetrievalBoosts}. */
	boosts?: RetrievalBoosts;
	/** Positive finite half-life (days) for the recency score. @defaultValue `90` */
	recencyHalfLifeDays?: number;
	/**
	 * Multiplier applied to {@link SearchInput.limit} to determine how many
	 * candidates each search fetches before fusion.
	 * Must be an integer greater than or equal to 1. @defaultValue `3`
	 */
	candidateMultiplier?: number;
	/**
	 * Record access on search: increment {@link Memory.accessCount} and set
	 * {@link Memory.lastAccessedAt} on the returned memories. The write starts
	 * once the results are ready and search does not wait for it, so the
	 * returned records carry the values from before this search. Failures are
	 * reported as `"trackAccess"` events to {@link ObservabilityConfig.onEvent}
	 * and never fail the search. {@link SearchInput.trackAccess} overrides it
	 * per call.
	 *
	 * @defaultValue `false`
	 */
	trackAccess?: boolean;
}

/**
 * Scoring settings attached to each {@link MemoryWithScore} when
 * {@link SearchInput.explain} is `true`. Together with
 * {@link MemoryWithScore.scores} they reproduce the final score.
 */
export interface RetrievalExplanation {
	/** Effective fusion settings (defaults filled in). */
	fusion: Required<RetrievalFusionConfig>;
	/** Effective boosts (defaults filled in). */
	boosts: Required<RetrievalBoosts>;
	/** Factor in `(0, 1]` applied to {@link RetrievalScores.fused}. */
	boostFactor: number;
	/** Final score — same value as {@link MemoryWithScore.score}. */
	finalScore: number;
}

/**
 * A {@link Memory} returned by {@link MemoryClient.search}, annotated with
 * retrieval scores.
 */
export interface MemoryWithScore extends Memory {
	/** Final relevance score in `[0, 1]`: the fused score times the boost factor. Higher is better. */
	score: number;
	/** Per-component scores that produced {@link MemoryWithScore.score}. */
	scores: RetrievalScores;
	/**
	 * Full scoring breakdown when {@link SearchInput.explain} is `true`,
	 * `null` otherwise.
	 */
	explanation: RetrievalExplanation | null;
}

/**
 * Options for reads at a {@link MemoryScope}: by default a read also sees
 * memories shared by every agent (no `agentId`) and outside any session (no
 * `sessionId`).
 */
export interface ScopedReadOptions {
	/**
	 * Only memories whose agent equals `scope.agentId`, without shared ones.
	 * @defaultValue `false`
	 */
	exactAgent?: boolean;
	/**
	 * Only memories whose session equals `scope.sessionId`, without
	 * session-less ones.
	 * @defaultValue `false`
	 */
	exactSession?: boolean;
}

/**
 * The fields of a memory to add. Omitted fields take their defaults; on a
 * keyed add that updates an existing memory, they are reset to the defaults
 * too.
 */
export interface NewMemory {
	/** Raw textual content to store. Must be non-empty. */
	content: string;
	/**
	 * Idempotency key, unique within the exact scope. Adding a memory with a
	 * key that already exists in the scope replaces that memory's content and
	 * fields, keeping its `id`, `createdAt` and access counts.
	 */
	key?: string;
	/** Memory kind. @defaultValue `"fact"` */
	kind?: MemoryKind;
	/** Relative importance. @defaultValue `"normal"` */
	importance?: ImportanceLevel;
	/** Free-form tags used for later filtering. */
	tags?: string[];
	/** Optional human-readable source attribution. */
	source?: string;
	/** JSON-compatible metadata persisted by value alongside the memory. */
	metadata?: JsonObject;
	/** Confidence in `[0, 1]`. @defaultValue `1` */
	confidence?: number;
	/** Optional expiry; expired memories are filtered out by default. */
	expiresAt?: Date;
}

/** Input for {@link MemoryClient.add}. */
export interface AddInput<DefaultNamespace extends boolean = false>
	extends NewMemory {
	/** Where the memory lives. */
	scope: ScopeInput<DefaultNamespace>;
	/**
	 * Optional cancellation signal. Forwarded to the embedder; when aborted,
	 * the operation throws a {@link MnemocyteError} with code `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/** Input for {@link MemoryClient.addMany}. */
export interface AddManyInput<DefaultNamespace extends boolean = false> {
	/** Where every memory of the batch lives. */
	scope: ScopeInput<DefaultNamespace>;
	/** Memories to add, in order. Keys must be distinct within the batch. */
	memories: readonly NewMemory[];
	/** Optional cancellation signal for the whole batch. */
	signal?: AbortSignal;
}

/** Input for {@link MemoryClient.search}. */
export interface SearchInput<DefaultNamespace extends boolean = false>
	extends ScopedReadOptions {
	/** Scope to search; see {@link MemoryScope} for shared memories. */
	scope: ScopeInput<DefaultNamespace>;
	/** Free-text query; embedded and matched against stored memories. */
	query: string;
	/** Maximum number of results. Falls back to {@link MemoryConfig.defaults}. */
	limit?: number;
	/** Minimum final score required for a memory to be returned. */
	minScore?: number;
	/** Restrict results to these kinds. */
	kinds?: MemoryKind[];
	/** Require results to include all of these tags. */
	tags?: string[];
	/** Only include memories created strictly before this date. */
	before?: Date;
	/** Only include memories created strictly after this date. */
	after?: Date;
	/** Include memories that have been superseded. @defaultValue `false` */
	includeSuperseded?: boolean;
	/** Include memories whose `expiresAt` has passed. @defaultValue `false` */
	includeExpired?: boolean;
	/** Populate {@link MemoryWithScore.explanation} on each result. @defaultValue `false` */
	explain?: boolean;
	/**
	 * Record access for this call's results. Overrides
	 * {@link RetrievalConfig.trackAccess}.
	 */
	trackAccess?: boolean;
	/**
	 * Optional cancellation signal. Forwarded to the embedder; when
	 * aborted, the operation throws a {@link MnemocyteError} with code
	 * `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/**
 * Input for {@link MemoryClient.get}: a memory by `id` (any memory visible at
 * the scope) or by `key` (the exact scope only, where keys are unique).
 */
export type GetInput<DefaultNamespace extends boolean = false> =
	BoundGetInput & {
		scope: ScopeInput<DefaultNamespace>;
	};

/** Input for {@link BoundMemoryClient.get}: {@link GetInput} without `scope`. */
export type BoundGetInput = ScopedReadOptions & {
	signal?: AbortSignal;
} & ({ id: string; key?: never } | { key: string; id?: never });

/** Input for {@link MemoryClient.list}. */
export interface ListInput<DefaultNamespace extends boolean = false>
	extends ScopedReadOptions {
	/** Scope to list; see {@link MemoryScope} for shared memories. */
	scope: ScopeInput<DefaultNamespace>;
	/** Page size; positive integer. @defaultValue `50` */
	limit?: number;
	/** `nextCursor` from the previous page. Omit for the first page. */
	cursor?: string;
	/** Restrict to these kinds. */
	kinds?: MemoryKind[];
	/** Require memories to include all of these tags. */
	tags?: string[];
	/** Include superseded memories. @defaultValue `false` */
	includeSuperseded?: boolean;
	/** Include expired memories. @defaultValue `false` */
	includeExpired?: boolean;
	/** Optional cancellation signal. */
	signal?: AbortSignal;
}

/** Result of {@link MemoryClient.list}. */
export interface ListResult {
	/** Memories newest first, by `createdAt` then `id`. */
	memories: Memory[];
	/**
	 * Opaque cursor for the next page, or `null` when this page is the last.
	 * Pass it back unchanged as {@link ListInput.cursor}.
	 */
	nextCursor: string | null;
}

/**
 * Input for {@link MemoryClient.update}. Fields that are present replace the
 * stored value; omitted fields stay as they are. At least one field must be
 * present.
 */
export interface UpdateInput<DefaultNamespace extends boolean = false> {
	/** Scope the memory is visible at; see {@link MemoryScope}. */
	scope: ScopeInput<DefaultNamespace>;
	/** Id of the memory to update. */
	id: string;
	/** New content. The memory is re-embedded. */
	content?: string;
	/** New key, or `null` to remove it. Must be unique in the memory's scope. */
	key?: string | null;
	kind?: MemoryKind;
	importance?: ImportanceLevel;
	tags?: string[];
	/** New source, or `null` to remove it. */
	source?: string | null;
	metadata?: JsonObject;
	confidence?: number;
	/** New expiry, or `null` to remove it. */
	expiresAt?: Date | null;
	/** Optional cancellation signal, forwarded to the embedder. */
	signal?: AbortSignal;
}

/** Input for {@link MemoryClient.delete}. */
export interface DeleteInput<DefaultNamespace extends boolean = false> {
	/** Scope the memory is visible at; see {@link MemoryScope}. */
	scope: ScopeInput<DefaultNamespace>;
	/** Id of the memory to delete. */
	id: string;
	/** Optional cancellation signal. */
	signal?: AbortSignal;
}

/**
 * Input for {@link MemoryClient.deleteScope}. Here an omitted `agentId` or
 * `sessionId` matches any value: `{ namespace, entityId }` deletes everything
 * about the entity across all agents and sessions.
 */
export interface DeleteScopeInput<DefaultNamespace extends boolean = false> {
	/** What to delete; omitted optional fields match any value. */
	scope: ScopeInput<DefaultNamespace>;
	/** Optional cancellation signal. */
	signal?: AbortSignal;
}

/** Result of {@link MemoryClient.deleteScope}. */
export interface DeleteScopeResult {
	/** Number of memories deleted. */
	deletedCount: number;
}

/**
 * Pluggable token counter used by {@link MemoryClient.context} to enforce
 * {@link ContextInput.maxTokens}. Plug in your model's tokenizer for exact
 * budgets; the default estimates one token per four characters.
 */
export interface TokenCounter {
	/** Return the number of tokens in `text`. */
	count(text: string): number;
}

/**
 * Input for {@link MemoryClient.context}, which renders relevant memories
 * into a prompt-ready string.
 */
export interface ContextInput<DefaultNamespace extends boolean = false>
	extends ScopedReadOptions {
	/** Scope to search; see {@link MemoryScope} for shared memories. */
	scope: ScopeInput<DefaultNamespace>;
	/** Free-text query used to select relevant memories. It is not echoed. */
	query: string;
	/** Output format. @defaultValue `"markdown"` */
	format?: ContextFormat;
	/** Positive-integer token budget. @defaultValue `1200` */
	maxTokens?: number;
	/** Maximum number of memories to consider. */
	limit?: number;
	/** Minimum retrieval score required. */
	minScore?: number;
	/** Restrict to these kinds. */
	kinds?: MemoryKind[];
	/** Require results to include all of these tags. */
	tags?: string[];
	/** Include superseded memories. @defaultValue `false` */
	includeSuperseded?: boolean;
	/** Include expired memories. @defaultValue `false` */
	includeExpired?: boolean;
	/**
	 * Record access for the selected memories. Overrides
	 * {@link RetrievalConfig.trackAccess}.
	 */
	trackAccess?: boolean;
	/** Tokenizer used to enforce {@link ContextInput.maxTokens}. */
	tokenCounter?: TokenCounter;
	/**
	 * Optional cancellation signal. Forwarded to the search and the embedder;
	 * when aborted, the operation throws `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/**
 * Selectors shared by {@link PruneInput}. At least one must be effective;
 * `false` flags and empty arrays do not count.
 */
export interface PruneSelectors {
	/** Match memories whose `expiresAt` is in the past. */
	expired?: boolean;
	/** Match memories that have been superseded (`supersededBy !== null`). */
	superseded?: boolean;
	/** Match memories created strictly before this date. */
	createdBefore?: Date;
	/**
	 * Match memories last accessed strictly before this date. A memory that
	 * was never accessed counts from its `createdAt`, so one created after
	 * the date is kept.
	 */
	notAccessedSince?: Date;
	/** Match memories of these kinds. */
	kinds?: MemoryKind[];
	/** Match memories that include all of these tags. */
	tags?: string[];
	/** Match memories at or below this importance. */
	maxImportance?: ImportanceLevel;
	/** Count what would be pruned without deleting anything. @defaultValue `false` */
	dryRun?: boolean;
	/**
	 * Optional cancellation signal. A pre-aborted signal prevents storage work.
	 * In-flight Postgres pruning requests server-query cancellation, but a
	 * deletion that has already committed cannot be undone.
	 */
	signal?: AbortSignal;
}

/**
 * Input for {@link MemoryClient.prune}: a {@link ScopeSelector}, or
 * `allNamespaces: true` for the whole installation, plus at least one
 * selector. Selectors are combined with AND.
 */
export type PruneInput<DefaultNamespace extends boolean = false> =
	PruneSelectors &
		(
			| {
					scope: ScopeSelectorInput<DefaultNamespace>;
					allNamespaces?: never;
			  }
			| { allNamespaces: true; scope?: never }
		);

/**
 * Result returned by {@link MemoryClient.prune}.
 */
export interface PruneResult {
	/** Number of memories that matched the prune filter. */
	matchedCount: number;
	/**
	 * Number of memories actually deleted. Equals `matchedCount` for
	 * normal runs and `0` for `dryRun` runs.
	 */
	deletedCount: number;
	/** `true` when {@link PruneSelectors.dryRun} was set. */
	dryRun: boolean;
}

/**
 * Input for {@link MemoryClient.findDuplicates}: a pairwise cosine-similarity
 * scan of the memories visible at a scope. Read-only.
 */
export interface FindDuplicatesInput<DefaultNamespace extends boolean = false>
	extends ScopedReadOptions {
	/** Scope to scan; see {@link MemoryScope} for shared memories. */
	scope: ScopeInput<DefaultNamespace>;
	/**
	 * Cosine-similarity cutoff in `[0, 1]`. Pairs whose similarity is at
	 * or above this value are returned. @defaultValue `0.95`
	 */
	threshold?: number;
	/**
	 * Maximum number of duplicate pairs to return, ordered by descending
	 * similarity. @defaultValue `100`
	 */
	limit?: number;
	/** Restrict the scan to these kinds. */
	kinds?: readonly MemoryKind[];
	/** Require both memories in the pair to include all of these tags. */
	tags?: readonly string[];
	/** Include superseded memories in the scan. @defaultValue `false` */
	includeSuperseded?: boolean;
	/** Include expired memories in the scan. @defaultValue `false` */
	includeExpired?: boolean;
	/**
	 * Optional cancellation signal. In-memory scans check it cooperatively;
	 * Postgres requests cancellation of the active duplicate-search query.
	 */
	signal?: AbortSignal;
}

/**
 * A pair of memories that are likely duplicates. Unordered; each pair is
 * returned once.
 */
export interface DuplicatePair {
	/** One of the two memories in the duplicate pair. */
	a: Memory;
	/** The other memory in the duplicate pair. */
	b: Memory;
	/** Cosine similarity between the two embeddings, in `[0, 1]`. */
	similarity: number;
}

/**
 * A single audit-log entry recording a change.
 */
export interface AuditEvent {
	/** Unique identifier: a UUIDv7 string. */
	id: string;
	/** Scope of the change. */
	scope: MemoryRecordScope;
	/**
	 * Stable, dotted slug describing the change: `"memory.created"`,
	 * `"memory.updated"`, `"memory.deleted"`, `"memory.pruned"` or
	 * `"memory.superseded"`.
	 */
	description: string;
	/** JSON-compatible structured details persisted by value with the change. */
	metadata: JsonObject;
	/** When the change was recorded. */
	timestamp: Date;
}

/**
 * Stable composite position for deterministic audit-log pagination.
 */
export interface AuditLogCursor {
	/** Event timestamp at the page boundary. */
	timestamp: Date;
	/** Event ID used to break timestamp ties. */
	id: string;
}

/**
 * Input for {@link MemoryClient.listAuditLog}. An omitted `agentId` or
 * `sessionId` in `scope` matches any value, so `{ namespace, entityId }`
 * lists every event about the entity.
 */
export interface ListAuditLogInput<DefaultNamespace extends boolean = false> {
	/** Whose events to list; omitted optional fields match any value. */
	scope: ScopeInput<DefaultNamespace>;
	/**
	 * Maximum number of entries to return, ordered newest first.
	 * @defaultValue `50`
	 */
	limit?: number;
	/**
	 * Only return entries strictly before this timestamp. This is a filter, not
	 * a complete pagination cursor: events sharing the timestamp are excluded.
	 */
	before?: Date;
	/**
	 * Only return entries strictly after this timestamp. This is a filter, not
	 * a complete pagination cursor: events sharing the timestamp are excluded.
	 */
	after?: Date;
	/** Return entries strictly older than this `(timestamp, id)` position. */
	beforeCursor?: AuditLogCursor;
	/** Return entries strictly newer than this `(timestamp, id)` position. */
	afterCursor?: AuditLogCursor;
	/**
	 * Optional cancellation signal. In-memory scans check it cooperatively;
	 * Postgres requests cancellation of the active audit-log query.
	 */
	signal?: AbortSignal;
}

/**
 * Input for {@link ExperimentalMemoryClient.consolidate}: mark each memory in
 * `supersededIds` as superseded by `survivorId`, optionally merging their
 * tags into the survivor.
 */
export interface ConsolidateInput<DefaultNamespace extends boolean = false> {
	/** Scope every referenced memory is visible at; see {@link MemoryScope}. */
	scope: ScopeInput<DefaultNamespace>;
	/** Memory that should win the merge. Must not itself be superseded. */
	survivorId: string;
	/**
	 * Memories to mark as superseded by the survivor. Entries already
	 * superseded by this same survivor are skipped for idempotency. If any
	 * entry points to a different survivor, the entire call rejects with
	 * `"CONFLICT"`. Must not contain duplicates or
	 * {@link ConsolidateInput.survivorId}.
	 */
	supersededIds: readonly string[];
	/**
	 * When `true`, the survivor's `tags` becomes the union of its own
	 * mutation-time tags and the tags of every memory that was actually
	 * superseded.
	 * @defaultValue `true`
	 */
	mergeTags?: boolean;
	/**
	 * Optional cancellation signal. On Postgres it cancels the running
	 * statement; the consolidation is one statement, so a cancel before it
	 * finishes writes nothing.
	 */
	signal?: AbortSignal;
}

/**
 * Result returned by {@link ExperimentalMemoryClient.consolidate}.
 */
export interface ConsolidateResult {
	/** Echoes {@link ConsolidateInput.survivorId}. */
	survivorId: string;
	/**
	 * Number of memories actually marked as superseded. Excludes entries
	 * that already pointed to this survivor (idempotent skip).
	 */
	supersededCount: number;
	/** The IDs that were newly superseded during this call. */
	supersededIds: readonly string[];
}

/**
 * Input for {@link MemoryClient.stats}: a {@link ScopeSelector}, or
 * `allNamespaces: true` for the whole installation.
 */
export type StatsInput<DefaultNamespace extends boolean = false> =
	| { scope: ScopeSelectorInput<DefaultNamespace>; allNamespaces?: never }
	| { allNamespaces: true; scope?: never };

/** Counts returned by {@link MemoryClient.stats}. */
export interface MemoryStats {
	/** Number of distinct entities (per namespace) with at least one memory. */
	entityCount: number;
	/** Number of memories selected. */
	memoryCount: number;
	/** Memories that are neither expired nor superseded. */
	activeMemoryCount: number;
	/** Memories whose `expiresAt` has passed. */
	expiredMemoryCount: number;
	/** Memories that have been superseded. */
	supersededMemoryCount: number;
}

/**
 * The memory client returned by {@link createMemory}. It holds no
 * connections or timers, so it needs no shutdown call; the database client
 * behind a store stays yours to end.
 *
 * Every method may throw {@link MnemocyteError}; use {@link isMnemocyteError}
 * to narrow caught values.
 *
 * `DefaultNamespace` is `true` for a client created with
 * {@link MemoryConfig.namespace}: its scopes may then omit `namespace`.
 */
export interface MemoryClient<DefaultNamespace extends boolean = false> {
	/**
	 * Store one memory and return it. With a `key` that already exists in the
	 * scope, the existing memory is updated in place instead.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` for invalid input, `"EMBEDDING"`
	 * if the embedder fails, `"DB"` for storage failures.
	 */
	add(input: AddInput<DefaultNamespace>): Promise<Memory>;
	/**
	 * Store several memories of one scope with one embedder call and one
	 * statement. Returns them in input order.
	 */
	addMany(input: AddManyInput<DefaultNamespace>): Promise<Memory[]>;
	/**
	 * Rank the memories visible at the scope against `query` with hybrid
	 * vector and keyword search.
	 */
	search(input: SearchInput<DefaultNamespace>): Promise<MemoryWithScore[]>;
	/** Return one memory by id or key, or `null` when there is none. */
	get(input: GetInput<DefaultNamespace>): Promise<Memory | null>;
	/** Page through the memories visible at the scope, newest first. */
	list(input: ListInput<DefaultNamespace>): Promise<ListResult>;
	/**
	 * Change fields of one memory and return it. Content changes re-embed it.
	 *
	 * @throws {MnemocyteError} `"NOT_FOUND"` if no memory with that id is
	 * visible at the scope; `"CONFLICT"` if the new key is already used in
	 * the memory's scope.
	 */
	update(input: UpdateInput<DefaultNamespace>): Promise<Memory>;
	/**
	 * Delete one memory.
	 *
	 * @throws {MnemocyteError} `"NOT_FOUND"` if no memory with that id is
	 * visible at the scope; `"CONFLICT"` while another memory references it as
	 * its consolidation survivor.
	 */
	delete(input: DeleteInput<DefaultNamespace>): Promise<void>;
	/**
	 * Delete every memory in a scope, and the scope's audit events, in one
	 * statement. `{ namespace, entityId }` erases the entity across all agents
	 * and sessions.
	 *
	 * @throws {MnemocyteError} `"CONFLICT"` when a memory outside the scope
	 * still references a memory inside it as its consolidation survivor.
	 */
	deleteScope(
		input: DeleteScopeInput<DefaultNamespace>,
	): Promise<DeleteScopeResult>;
	/**
	 * Search and render the results as a prompt-ready string within a token
	 * budget.
	 */
	context(input: ContextInput<DefaultNamespace>): Promise<string>;
	/**
	 * Bulk-delete memories that match a scope selector and at least one other
	 * selector. Pass `dryRun: true` to count without deleting.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` without a scope (or
	 * `allNamespaces: true`) or without a selector; `"CONFLICT"` when a
	 * non-dry-run prune selects a memory that still has consolidation
	 * dependents. The prune deletes nothing in that case.
	 */
	prune(input: PruneInput<DefaultNamespace>): Promise<PruneResult>;
	/**
	 * Return pairs of near-identical memories visible at the scope, most
	 * similar first. Read-only.
	 */
	findDuplicates(
		input: FindDuplicatesInput<DefaultNamespace>,
	): Promise<DuplicatePair[]>;
	/** Return audit-log events for a scope, newest first. */
	listAuditLog(
		input: ListAuditLogInput<DefaultNamespace>,
	): Promise<AuditEvent[]>;
	/** Count memories for a scope selector or the whole installation. */
	stats(input: StatsInput<DefaultNamespace>): Promise<MemoryStats>;
	/**
	 * Return a client bound to `scope`: the same methods without the
	 * `scope` field, so a call cannot drift to another entity. An omitted
	 * `namespace` is the client's default. The bound client shares this
	 * client's store and embedder and holds no state of its own besides the
	 * scope.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` if the scope is malformed or
	 * has no namespace and the client has no default.
	 *
	 * @example
	 * ```ts
	 * const memory = createMemory({ namespace: "my-app", store, embedder });
	 * const userMemory = memory.for({ entityId: user.id });
	 * await userMemory.add({ content: "Prefers short, direct answers." });
	 * const context = await userMemory.context({ query: message });
	 * ```
	 */
	for(scope: ScopeInput<DefaultNamespace>): BoundMemoryClient;
	/**
	 * Unstable surface. Members may change or be removed in a minor release
	 * until they graduate to the main client interface.
	 */
	experimental: ExperimentalMemoryClient<DefaultNamespace>;
}

/**
 * Unstable operations, reached through {@link MemoryClient.experimental}.
 *
 * @experimental Members may change or be removed in a minor release.
 */
export interface ExperimentalMemoryClient<
	DefaultNamespace extends boolean = false,
> {
	/**
	 * Mark likely duplicates as superseded by one survivor, optionally merging
	 * their tags into it. Idempotent for memories that already point to the
	 * survivor. Emits one `"memory.superseded"` audit event per newly
	 * superseded memory when audit is enabled.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` for empty or duplicate
	 * `supersededIds`, a `survivorId` inside `supersededIds`, or a survivor
	 * that is itself superseded; `"NOT_FOUND"` if a memory is not visible at
	 * the scope; `"CONFLICT"` if a memory points to a different survivor or
	 * the survivor changed before the write. Nothing is written on any error.
	 */
	consolidate(
		input: ConsolidateInput<DefaultNamespace>,
	): Promise<ConsolidateResult>;
}

/** Input for {@link BoundMemoryClient.add}. */
export type BoundAddInput = Omit<AddInput, "scope">;
/** Input for {@link BoundMemoryClient.addMany}. */
export type BoundAddManyInput = Omit<AddManyInput, "scope">;
/** Input for {@link BoundMemoryClient.search}. */
export type BoundSearchInput = Omit<SearchInput, "scope">;
/** Input for {@link BoundMemoryClient.list}. */
export type BoundListInput = Omit<ListInput, "scope">;
/** Input for {@link BoundMemoryClient.update}. */
export type BoundUpdateInput = Omit<UpdateInput, "scope">;
/** Input for {@link BoundMemoryClient.delete}. */
export type BoundDeleteInput = Omit<DeleteInput, "scope">;
/** Input for {@link BoundMemoryClient.deleteScope}. */
export type BoundDeleteScopeInput = Omit<DeleteScopeInput, "scope">;
/** Input for {@link BoundMemoryClient.context}. */
export type BoundContextInput = Omit<ContextInput, "scope">;
/** Input for {@link BoundMemoryClient.findDuplicates}. */
export type BoundFindDuplicatesInput = Omit<FindDuplicatesInput, "scope">;
/** Input for {@link BoundMemoryClient.listAuditLog}. */
export type BoundListAuditLogInput = Omit<ListAuditLogInput, "scope">;
/** Input for {@link BoundExperimentalMemoryClient.consolidate}. */
export type BoundConsolidateInput = Omit<ConsolidateInput, "scope">;

/**
 * A client bound to one scope, from {@link MemoryClient.for}. Its methods
 * take no `scope` field and reject one at runtime with `"VALIDATION"`, as
 * they reject `allNamespaces`: operations across namespaces stay on the
 * unbound client. Reads and changes by id see the bound scope plus shared
 * memories, as on the unbound client; `deleteScope`, `prune`, `stats` and
 * `listAuditLog` select within the bound scope, where an omitted `agentId`
 * or `sessionId` matches any value.
 */
export interface BoundMemoryClient {
	/** The bound scope. Frozen. */
	readonly scope: Readonly<MemoryScope>;
	/** {@link MemoryClient.add} at the bound scope. */
	add(input: BoundAddInput): Promise<Memory>;
	/** {@link MemoryClient.addMany} at the bound scope. */
	addMany(input: BoundAddManyInput): Promise<Memory[]>;
	/** {@link MemoryClient.search} at the bound scope. */
	search(input: BoundSearchInput): Promise<MemoryWithScore[]>;
	/** {@link MemoryClient.get} at the bound scope. */
	get(input: BoundGetInput): Promise<Memory | null>;
	/** {@link MemoryClient.list} at the bound scope. */
	list(input?: BoundListInput): Promise<ListResult>;
	/** {@link MemoryClient.update} at the bound scope. */
	update(input: BoundUpdateInput): Promise<Memory>;
	/** {@link MemoryClient.delete} at the bound scope. */
	delete(input: BoundDeleteInput): Promise<void>;
	/**
	 * Delete every memory in the bound scope, and its audit events. A scope
	 * without `agentId` or `sessionId` erases the entity across all agents
	 * or sessions; see {@link MemoryClient.deleteScope}.
	 */
	deleteScope(input?: BoundDeleteScopeInput): Promise<DeleteScopeResult>;
	/** {@link MemoryClient.context} at the bound scope. */
	context(input: BoundContextInput): Promise<string>;
	/** {@link MemoryClient.prune} within the bound scope. */
	prune(input: PruneSelectors): Promise<PruneResult>;
	/** {@link MemoryClient.findDuplicates} at the bound scope. */
	findDuplicates(input?: BoundFindDuplicatesInput): Promise<DuplicatePair[]>;
	/** {@link MemoryClient.listAuditLog} within the bound scope. */
	listAuditLog(input?: BoundListAuditLogInput): Promise<AuditEvent[]>;
	/** {@link MemoryClient.stats} within the bound scope. */
	stats(): Promise<MemoryStats>;
	/**
	 * Unstable surface at the bound scope; see
	 * {@link MemoryClient.experimental}.
	 */
	experimental: BoundExperimentalMemoryClient;
}

/**
 * Unstable operations of a {@link BoundMemoryClient}.
 *
 * @experimental Members may change or be removed in a minor release.
 */
export interface BoundExperimentalMemoryClient {
	/** {@link ExperimentalMemoryClient.consolidate} at the bound scope. */
	consolidate(input: BoundConsolidateInput): Promise<ConsolidateResult>;
}
