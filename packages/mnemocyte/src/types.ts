import type { LibsqlClient, PostgresClient } from "./sql/detect.js";

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
	agentId?: string | undefined;
	/** Session the memory belongs to; omit for memories outside any session. */
	sessionId?: string | undefined;
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
	entityId?: string | undefined;
	/** Limit to memories this agent holds (not shared ones). */
	agentId?: string | undefined;
	/** Limit to memories of this session (not session-less ones). */
	sessionId?: string | undefined;
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
	namespace?: string | undefined;
	/** Who or what the memory is about. Non-empty. */
	entityId: string;
	/** Agent that holds the memory; omit for memories shared by every agent. */
	agentId?: string | undefined;
	/** Session the memory belongs to; omit for memories outside any session. */
	sessionId?: string | undefined;
}

/**
 * A {@link ScopeSelector} whose `namespace` may be omitted, for a client
 * created with {@link MemoryConfig.namespace}.
 */
export interface OptionalNamespaceSelector {
	/** Tenant or application. Defaults to {@link MemoryConfig.namespace}. */
	namespace?: string | undefined;
	/** Limit to one entity. */
	entityId?: string | undefined;
	/** Limit to memories this agent holds (not shared ones). */
	agentId?: string | undefined;
	/** Limit to memories of this session (not session-less ones). */
	sessionId?: string | undefined;
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
 * `"custom"` is a store from `defineMemoryStore` (`mnemocyte/store`). A
 * minor release may add backends, so a `switch` over them needs a
 * `default`.
 */
export type MnemocyteBackend = "in-memory" | "postgres" | "libsql" | "custom";

/**
 * The {@link MemoryClient} methods that emit {@link MnemocyteObservation}
 * events through {@link ObservabilityConfig.onEvent}, plus `"trackAccess"`:
 * the access write a tracked search starts after its results are ready (see
 * {@link RetrievalConfig.trackAccess}). A minor release may add operations,
 * so a `switch` over them needs a `default`.
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
	| "contextWithMemories"
	| "prune"
	| "findDuplicates"
	| "findDuplicatesPage"
	| "listAuditLog"
	| "pruneAuditLog"
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
	/**
	 * Elapsed milliseconds since the `"start"` event. Present on
	 * `"success"` / `"error"`.
	 */
	durationMs?: number;
	/** Namespace of the operation's scope, when it has one. */
	namespace?: string;
	/** Entity of the operation's scope, when it has one. */
	entityId?: string;
	/**
	 * Agent of the operation's scope, when it names one. Absent for a scope
	 * without an agent, whether that means shared memories or every agent.
	 */
	agentId?: string;
	/**
	 * Session of the operation's scope, when it names one. Absent for a scope
	 * without a session.
	 */
	sessionId?: string;
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
 * Hooks never delay or fail a client call: `onEvent` is called without being
 * awaited, and anything it throws or rejects with goes to
 * {@link ObservabilityConfig.onError} (or is dropped when that is unset).
 */
export interface ObservabilityConfig {
	/**
	 * Called for every lifecycle event of every operation. Receives a single
	 * {@link MnemocyteObservation}. May be sync or async. It is called in order
	 * (`"start"`, then `"success"` or `"error"`) but never awaited, so async
	 * work from one event may still be running when the next one is delivered.
	 * A synchronous hook still blocks while it runs. On serverless platforms
	 * un-awaited work can be cut off when the function ends; flush it yourself.
	 */
	onEvent?: ((event: MnemocyteObservation) => void | Promise<void>) | undefined;
	/**
	 * Called when `onEvent` throws or rejects, with the error and the event it
	 * was handling. Unset by default, so failures are dropped. A throw from
	 * this hook is ignored too.
	 */
	onError?:
		| ((info: { error: unknown; event: MnemocyteObservation }) => void)
		| undefined;
}

/**
 * Production-hardening knobs applied to outbound provider calls
 * (currently the {@link Embedder}). Mnemocyte applies a timeout, retries
 * on transient failures, and forwards `AbortSignal` cancellation to each
 * attempt. Every field is optional; by default there is no timeout and a
 * failed call is retried twice.
 */
export interface ProviderResilienceConfig {
	/**
	 * Maximum time, in milliseconds, that a single provider attempt may
	 * run before a {@link MnemocyteError} with code `"TIMEOUT"` is thrown.
	 * Must be a non-negative finite number. Defaults to `0` which disables the
	 * timeout.
	 */
	timeoutMs?: number | undefined;
	/**
	 * Maximum number of retry attempts after the initial call. Must be a
	 * non-negative integer. `0` disables retries. Defaults to `2`.
	 */
	retries?: number | undefined;
	/**
	 * Base backoff delay (ms) used before the first retry; it doubles for
	 * each later retry, and each wait is a random 50–100% of it. Must be a
	 * non-negative finite number. Defaults to `500`.
	 */
	baseDelayMs?: number | undefined;
	/**
	 * Maximum backoff delay (ms) used between retries. Must be a non-negative
	 * finite number. Values below `baseDelayMs` are normalized up to the base
	 * delay. Defaults to `8000`.
	 */
	maxDelayMs?: number | undefined;
	/**
	 * Longest server-requested wait (ms) Mnemocyte honours. An error with a
	 * `retryAfterMs` (from a `Retry-After` or `retry-after-ms` header) waits
	 * that long instead of the backoff; when it asks for more than this, the
	 * error is thrown without retrying. Must be a non-negative finite number.
	 * Defaults to `60000`.
	 */
	maxRetryAfterMs?: number | undefined;
	/**
	 * Optional predicate deciding whether `error` should trigger a retry.
	 * Receives the thrown value and the 1-indexed `attempt` number that
	 * just failed. When omitted, the built-in rule retries errors with an
	 * HTTP `status` of 408, 429, 500, 502, 503 or 504, network errors with a
	 * transient `code` (such as `ECONNRESET`) on the error or its `cause`,
	 * and `"TIMEOUT"` errors.
	 */
	shouldRetry?: ((error: unknown, attempt: number) => boolean) | undefined;
}

declare const mnemocyteStoreConfigBrand: unique symbol;

/**
 * Opaque storage-adapter value accepted by {@link MemoryConfig.store}.
 *
 * Obtain this value from `postgresStore({ client })` in `mnemocyte/postgres`,
 * `libsqlStore({ client })` in `mnemocyte/libsql`, or
 * `defineMemoryStore({ store })` in `mnemocyte/store`. It exposes none of
 * the store's methods.
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
	createExtension?: boolean | undefined;
	/**
	 * Postgres text search configuration for keyword search, such as
	 * `"english"` (the default), `"simple"` or `"german"`; the database's
	 * `pg_ts_config` lists them. A fresh install builds `content_tsv` with
	 * it. On an existing installation it is optional, and a configuration
	 * that differs from the installed one rejects with `"CONFIG"` before
	 * anything runs: {@link setTextSearchConfig} changes it. An unknown name
	 * rejects with `"VALIDATION"`. The in-memory store ignores it.
	 */
	textSearchConfig?: string | undefined;
	/**
	 * Inspect the database as a real run would and return the `applied`,
	 * `adopted`, `extensionCreated` and `schemaCreated` it would produce,
	 * changing nothing.
	 * It rejects with the errors a real run would raise before its first
	 * statement; a migration that would fail partway through is not detected.
	 */
	dryRun?: boolean | undefined;
	/**
	 * Cancels the running statement when aborted. The migration in progress
	 * rolls back; migrations that already committed stay applied.
	 */
	signal?: AbortSignal | undefined;
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
			dimensions?: number | undefined;
	  })
	| (MigrateOptions & {
			memory?: never;
			/**
			 * The database to migrate: the app's database client (postgres.js, a
			 * node-postgres `Pool`, PGlite, Drizzle over one of them, or a
			 * `SqlExecutor`), or a store from `postgresStore()`.
			 */
			store: MnemocyteStoreConfig | PostgresClient | LibsqlClient;
			/**
			 * Embedding dimensions of the installation. Required on a database
			 * with no Mnemocyte tables, where it fixes the vector column for good:
			 * `vector` up to 2,000 dimensions, `halfvec` up to 4,000. On an
			 * existing installation it is optional, and a value that differs from
			 * the installed column rejects with `"CONFIG"` before anything runs.
			 */
			dimensions?: number | undefined;
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
	/**
	 * True when this call ran `CREATE SCHEMA` for the `schemaName` of
	 * `postgresStore()`, which a fresh install does when the schema is
	 * missing; false otherwise, and always without `schemaName`.
	 */
	schemaCreated: boolean;
}

/** Options {@link setTextSearchConfig} takes with either input shape. */
interface SetTextSearchConfigOptions {
	/**
	 * The Postgres text search configuration keyword search should use, such
	 * as `"simple"` or `"german"`. The database's `pg_ts_config` lists them;
	 * an unknown name rejects with `"VALIDATION"`.
	 */
	textSearchConfig: string;
	/**
	 * Report what the call would change, from a read-only transaction,
	 * changing nothing.
	 */
	dryRun?: boolean | undefined;
	/**
	 * Cancels the running statement when aborted; the change rolls back.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Input for {@link setTextSearchConfig}: the app's client, or a store.
 */
export type SetTextSearchConfigInput =
	| (SetTextSearchConfigOptions & {
			/** The client from `createMemory()`, or one bound with `for()`. */
			memory: MemoryClient<boolean> | BoundMemoryClient;
			store?: never;
	  })
	| (SetTextSearchConfigOptions & {
			memory?: never;
			/**
			 * The database: the app's database client or a store from
			 * `postgresStore()`, as {@link migrate} takes it.
			 */
			store: MnemocyteStoreConfig | PostgresClient | LibsqlClient;
	  });

/**
 * Result of {@link setTextSearchConfig}. Names are canonical, as Postgres
 * prints a `regconfig` (schema-qualified only when the schema is not on
 * `search_path`). With `dryRun`, what the call would have produced.
 */
export interface TextSearchConfigResult {
	/** The configuration before the call; `null` on the in-memory store and custom stores. */
	previous: string | null;
	/** The configuration after the call; `null` on the in-memory store and custom stores. */
	current: string | null;
	/** True when the call rewrote the memories table for a new configuration. */
	changed: boolean;
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
	namespace?: string | undefined;
	/**
	 * Where memories live: the database client the app already owns (a
	 * postgres.js `sql` function, a node-postgres `Pool`, a PGlite instance,
	 * Neon's `neon()` function, a Drizzle instance over one of them, or a
	 * `SqlExecutor`), recognised by its shape, or a store from
	 * `postgresStore({ client })`. Mnemocyte never closes the client. The
	 * Postgres backend is imported on the first call that uses it. When
	 * omitted, an in-memory backend is used.
	 */
	store?: MnemocyteStoreConfig | PostgresClient | LibsqlClient | undefined;
	/** Required embedder used to vectorise content for storage and retrieval. */
	embedder: Embedder;
	/**
	 * Defaults applied to {@link SearchInput} and {@link ContextInput} when
	 * properties are omitted.
	 */
	defaults?:
		| {
				/**
				 * Default `limit` for {@link MemoryClient.search} and
				 * {@link MemoryClient.context}.
				 */
				limit?: number | undefined;
				/**
				 * Default `minScore` cutoff for {@link MemoryClient.search} and
				 * {@link MemoryClient.context}.
				 */
				minScore?: number | undefined;
		  }
		| undefined;
	/** Retrieval-ranking tuning. See {@link RetrievalConfig}. */
	retrieval?: RetrievalConfig | undefined;
	/** Observability hooks. See {@link ObservabilityConfig}. */
	observability?: ObservabilityConfig | undefined;
	/**
	 * Production-hardening knobs for outbound provider calls
	 * (timeouts, retries, abort propagation). See
	 * {@link ProviderResilienceConfig}.
	 */
	provider?: ProviderResilienceConfig | undefined;
	/**
	 * Audit-log configuration. When enabled, Mnemocyte records an
	 * {@link AuditEvent} for every change to a memory. Read with
	 * {@link MemoryClient.listAuditLog}.
	 */
	audit?: AuditConfig | undefined;
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
	enabled?: boolean | undefined;
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
	/**
	 * Stable identifier for the underlying model (e.g.
	 * `"text-embedding-3-small"`).
	 */
	readonly model: string;
	/** Dimensionality of vectors returned by {@link Embedder.embed}. */
	readonly dimensions: number;
	/**
	 * Most texts Mnemocyte passes to one {@link Embedder.embed} call. Must be a
	 * positive integer. Defaults to `100`.
	 */
	readonly maxBatch?: number | undefined;
	/**
	 * Embed one or more texts. Implementations MUST return one vector per
	 * input, in the same order, each of length {@link Embedder.dimensions} and
	 * containing only finite numeric values.
	 *
	 * `options.purpose` says whether the texts are search queries or stored
	 * documents, for providers with separate modes for each.
	 * `options.signal` is the caller's `signal` (or Mnemocyte's provider
	 * timeout). Implementations that call `fetch` should forward it so
	 * requests can be cancelled promptly.
	 */
	embed(texts: readonly string[], options: EmbedOptions): Promise<number[][]>;
}

/**
 * What texts passed to {@link Embedder.embed} are for: `"query"` for search
 * queries, `"document"` for memory contents being stored.
 */
export type EmbeddingPurpose = "query" | "document";

/** Options Mnemocyte passes to every {@link Embedder.embed} call. */
export interface EmbedOptions {
	/** Whether the texts are search queries or stored documents. */
	readonly purpose: EmbeddingPurpose;
	/** Cancels the call; forward it to `fetch`. */
	readonly signal?: AbortSignal;
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
	 * {@link Memory.supersededBy} by {@link MemoryClient.consolidate}.
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
	/**
	 * Cosine similarity clamped to `[0, 1]`, or `null` when not in the vector
	 * list.
	 */
	vector: number | null;
	/**
	 * Backend-defined lexical score (`ts_rank` on Postgres, the fraction of
	 * query terms found on the in-memory store), or `null` when not in the
	 * lexical list. Only comparable within one search on one backend.
	 */
	lexical: number | null;
	/** Reciprocal rank fusion score in `[0, 1]`, before boosts. */
	fused: number;
	/**
	 * Time-decay score in `[0, 1]` based on
	 * {@link RetrievalConfig.recencyHalfLifeDays}.
	 */
	recency: number;
	/** Score in `[0, 1]` derived from {@link ImportanceLevel}. */
	importance: number;
}

/**
 * Reciprocal rank fusion settings. Each list contributes
 * `weight / (k + rank)`; the sum is divided by its best possible value.
 */
export interface RetrievalFusionConfig {
	/**
	 * Non-negative finite rank constant. Larger values flatten rank
	 * differences. @defaultValue `60`
	 */
	k?: number | undefined;
	/**
	 * Non-negative finite weight of the vector list. `0` skips the vector
	 * search. @defaultValue `1`
	 */
	vector?: number | undefined;
	/**
	 * Non-negative finite weight of the lexical list. `0` skips the lexical
	 * search. @defaultValue `1`
	 */
	lexical?: number | undefined;
}

/**
 * Boosts that scale the fused score by
 * `(1 + recency × recencyScore + importance × importanceScore) / (1 + recency + importance)`.
 * `0` turns a boost off.
 */
export interface RetrievalBoosts {
	/** Non-negative finite strength of the recency boost. @defaultValue `0.1` */
	recency?: number | undefined;
	/**
	 * Non-negative finite strength of the importance boost.
	 * @defaultValue `0.1`
	 */
	importance?: number | undefined;
}

/**
 * Retrieval-ranking tuning. All fields are optional; sensible defaults are
 * used for any field that is omitted.
 */
export interface RetrievalConfig {
	/** Reciprocal rank fusion settings. See {@link RetrievalFusionConfig}. */
	fusion?: RetrievalFusionConfig | undefined;
	/** Recency and importance boosts. See {@link RetrievalBoosts}. */
	boosts?: RetrievalBoosts | undefined;
	/**
	 * Positive finite half-life (days) for the recency score.
	 * @defaultValue `90`
	 */
	recencyHalfLifeDays?: number | undefined;
	/**
	 * Multiplier applied to {@link SearchInput.limit} to determine how many
	 * candidates each search fetches before fusion.
	 * Must be an integer greater than or equal to 1. @defaultValue `3`
	 */
	candidateMultiplier?: number | undefined;
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
	trackAccess?: boolean | undefined;
}

/**
 * Scoring settings attached to each {@link MemoryWithScore} when
 * {@link SearchInput.explain} is `true`. Together with
 * {@link MemoryWithScore.scores} they reproduce the final score.
 */
export interface RetrievalExplanation {
	/** Effective fusion settings (defaults filled in). */
	fusion: { k: number; vector: number; lexical: number };
	/** Effective boosts (defaults filled in). */
	boosts: { recency: number; importance: number };
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
	/**
	 * Final relevance score in `[0, 1]`: the fused score times the boost
	 * factor. Higher is better.
	 */
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
	exactAgent?: boolean | undefined;
	/**
	 * Only memories whose session equals `scope.sessionId`, without
	 * session-less ones.
	 * @defaultValue `false`
	 */
	exactSession?: boolean | undefined;
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
	key?: string | undefined;
	/** Memory kind. @defaultValue `"fact"` */
	kind?: MemoryKind | undefined;
	/** Relative importance. @defaultValue `"normal"` */
	importance?: ImportanceLevel | undefined;
	/** Free-form tags used for later filtering. */
	tags?: readonly string[] | undefined;
	/** Optional human-readable source attribution. */
	source?: string | undefined;
	/** JSON-compatible metadata persisted by value alongside the memory. */
	metadata?: JsonObject | undefined;
	/** Confidence in `[0, 1]`. @defaultValue `1` */
	confidence?: number | undefined;
	/** Optional expiry; expired memories are filtered out by default. */
	expiresAt?: Date | undefined;
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
	signal?: AbortSignal | undefined;
}

/** Input for {@link MemoryClient.addMany}. */
export interface AddManyInput<DefaultNamespace extends boolean = false> {
	/** Where every memory of the batch lives. */
	scope: ScopeInput<DefaultNamespace>;
	/** Memories to add, in order. Keys must be distinct within the batch. */
	memories: readonly NewMemory[];
	/** Optional cancellation signal for the whole batch. */
	signal?: AbortSignal | undefined;
}

/** Input for {@link MemoryClient.search}. */
export interface SearchInput<DefaultNamespace extends boolean = false>
	extends ScopedReadOptions {
	/** Scope to search; see {@link MemoryScope} for shared memories. */
	scope: ScopeInput<DefaultNamespace>;
	/** Free-text query; embedded and matched against stored memories. */
	query: string;
	/** Maximum number of results. Falls back to {@link MemoryConfig.defaults}. */
	limit?: number | undefined;
	/** Minimum final score required for a memory to be returned. */
	minScore?: number | undefined;
	/** Restrict results to these kinds. */
	kinds?: readonly MemoryKind[] | undefined;
	/** Require results to include all of these tags. */
	tags?: readonly string[] | undefined;
	/**
	 * Only include memories whose `createdAt` is strictly before this date.
	 * Same name as {@link BoundPruneInput.createdBefore}.
	 */
	createdBefore?: Date | undefined;
	/** Only include memories whose `createdAt` is strictly after this date. */
	createdAfter?: Date | undefined;
	/** Include memories that have been superseded. @defaultValue `false` */
	includeSuperseded?: boolean | undefined;
	/** Include memories whose `expiresAt` has passed. @defaultValue `false` */
	includeExpired?: boolean | undefined;
	/**
	 * Populate {@link MemoryWithScore.explanation} on each result.
	 * @defaultValue `false`
	 */
	explain?: boolean | undefined;
	/**
	 * Record access for this call's results. Overrides
	 * {@link RetrievalConfig.trackAccess}.
	 */
	trackAccess?: boolean | undefined;
	/**
	 * Optional cancellation signal. Forwarded to the embedder; when
	 * aborted, the operation throws a {@link MnemocyteError} with code
	 * `"ABORTED"`.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Input for {@link MemoryClient.get}: a memory by `id` (any memory visible at
 * the scope) or by `key` (the exact scope only, where keys are unique).
 */
export type GetInput<DefaultNamespace extends boolean = false> =
	BoundGetInput & {
		scope: ScopeInput<DefaultNamespace>;
	};

/** Input for {@link BoundMemoryClient.get}: {@link GetInput} minus `scope`. */
export type BoundGetInput = ScopedReadOptions & {
	signal?: AbortSignal | undefined;
} & ({ id: string; key?: never } | { key: string; id?: never });

/** Input for {@link MemoryClient.list}. */
export interface ListInput<DefaultNamespace extends boolean = false>
	extends ScopedReadOptions {
	/** Scope to list; see {@link MemoryScope} for shared memories. */
	scope: ScopeInput<DefaultNamespace>;
	/** Page size; an integer from 1 to 1,000. @defaultValue `50` */
	limit?: number | undefined;
	/** `nextCursor` from the previous page. Omit for the first page. */
	cursor?: string | undefined;
	/** Restrict to these kinds. */
	kinds?: readonly MemoryKind[] | undefined;
	/** Require memories to include all of these tags. */
	tags?: readonly string[] | undefined;
	/**
	 * Only include memories whose `createdAt` is strictly before this date.
	 * Same name as {@link SearchInput.createdBefore}.
	 */
	createdBefore?: Date | undefined;
	/** Only include memories whose `createdAt` is strictly after this date. */
	createdAfter?: Date | undefined;
	/** Include superseded memories. @defaultValue `false` */
	includeSuperseded?: boolean | undefined;
	/** Include expired memories. @defaultValue `false` */
	includeExpired?: boolean | undefined;
	/** Optional cancellation signal. */
	signal?: AbortSignal | undefined;
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
	content?: string | undefined;
	/** New key, or `null` to remove it. Must be unique in the memory's scope. */
	key?: string | null | undefined;
	kind?: MemoryKind | undefined;
	importance?: ImportanceLevel | undefined;
	tags?: readonly string[] | undefined;
	/** New source, or `null` to remove it. */
	source?: string | null | undefined;
	metadata?: JsonObject | undefined;
	confidence?: number | undefined;
	/** New expiry, or `null` to remove it. */
	expiresAt?: Date | null | undefined;
	/** Optional cancellation signal, forwarded to the embedder. */
	signal?: AbortSignal | undefined;
}

/** Input for {@link MemoryClient.delete}. */
export interface DeleteInput<DefaultNamespace extends boolean = false> {
	/** Scope the memory is visible at; see {@link MemoryScope}. */
	scope: ScopeInput<DefaultNamespace>;
	/** Id of the memory to delete. */
	id: string;
	/**
	 * What to do when the memory is a consolidation survivor, so other
	 * memories' `supersededBy` points at it. See {@link DependentsPolicy}.
	 * @defaultValue `"reject"`
	 */
	dependents?: DependentsPolicy | undefined;
	/** Optional cancellation signal. */
	signal?: AbortSignal | undefined;
}

/**
 * What {@link MemoryClient.delete} does with the memories that were
 * consolidated into the one it deletes (its dependents):
 *
 * - `"reject"`: throw `"CONFLICT"` and delete nothing.
 * - `"restore"`: clear their `supersededBy` and `supersededAt`, so they are
 *   active again and show up in search.
 * - `"delete"`: delete them too, and whatever was consolidated into them, in
 *   the same statement.
 *
 * With `"restore"` or `"delete"`, a dependent that is not visible at the
 * call's scope makes the call throw `"CONFLICT"` and delete nothing.
 */
export type DependentsPolicy = "reject" | "restore" | "delete";

/**
 * Result of {@link MemoryClient.delete}: the memories it deleted and the
 * dependents it made active again. Both arrays are always present.
 */
export interface DeleteResult {
	/**
	 * Ids of the deleted memories: the memory asked for first, then the
	 * dependents deleted with it (`dependents: "delete"`), ordered by id.
	 */
	deletedIds: string[];
	/**
	 * Ids of the dependents made active again (`dependents: "restore"`),
	 * ordered by id. Empty for the other policies.
	 */
	restoredIds: string[];
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
	signal?: AbortSignal | undefined;
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
	format?: ContextFormat | undefined;
	/** Positive-integer token budget. @defaultValue `1200` */
	maxTokens?: number | undefined;
	/**
	 * Maximum number of memories to consider. Falls back to
	 * {@link MemoryConfig.defaults}.
	 */
	limit?: number | undefined;
	/**
	 * Minimum retrieval score required. Falls back to
	 * {@link MemoryConfig.defaults}.
	 */
	minScore?: number | undefined;
	/** Restrict to these kinds. */
	kinds?: readonly MemoryKind[] | undefined;
	/** Require results to include all of these tags. */
	tags?: readonly string[] | undefined;
	/**
	 * Only include memories whose `createdAt` is strictly before this date.
	 * Applied in the search, before {@link ContextInput.maxTokens}. Same name
	 * as {@link SearchInput.createdBefore}.
	 */
	createdBefore?: Date | undefined;
	/**
	 * Only include memories whose `createdAt` is strictly after this date.
	 * Applied in the search, before {@link ContextInput.maxTokens}.
	 */
	createdAfter?: Date | undefined;
	/** Include superseded memories. @defaultValue `false` */
	includeSuperseded?: boolean | undefined;
	/** Include expired memories. @defaultValue `false` */
	includeExpired?: boolean | undefined;
	/**
	 * Record access for the selected memories. Overrides
	 * {@link RetrievalConfig.trackAccess}.
	 */
	trackAccess?: boolean | undefined;
	/** Tokenizer used to enforce {@link ContextInput.maxTokens}. */
	tokenCounter?: TokenCounter | undefined;
	/**
	 * Optional cancellation signal. Forwarded to the search and the embedder;
	 * when aborted, the operation throws `"ABORTED"`.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Input for {@link ExperimentalMemoryClient.contextWithMemories}: the input
 * of {@link MemoryClient.context}, plus `explain`.
 *
 * @experimental May change or be removed in a minor release.
 */
export interface ContextWithMemoriesInput<
	DefaultNamespace extends boolean = false,
> extends ContextInput<DefaultNamespace> {
	/**
	 * Populate {@link MemoryWithScore.explanation} on the returned memories,
	 * as {@link SearchInput.explain} does. It does not change the text.
	 * @defaultValue `false`
	 */
	explain?: boolean | undefined;
}

/**
 * Result of {@link ExperimentalMemoryClient.contextWithMemories}: the
 * context text and the memories behind it. `memories` followed by `omitted`
 * is the search result, in rank order.
 *
 * @experimental May change or be removed in a minor release.
 */
export interface ContextWithMemoriesResult {
	/** The string {@link MemoryClient.context} returns for the same input. */
	context: string;
	/** The memories rendered in `context`, in the order they appear. */
	memories: MemoryWithScore[];
	/**
	 * Memories the search returned but `maxTokens` left out, in rank order.
	 * Their number is the one the "omitted" line of `context` gives.
	 */
	omitted: MemoryWithScore[];
}

/**
 * Input for {@link BoundMemoryClient.prune}, and the selectors and options
 * {@link PruneInput} adds to a scope. At least one selector must be
 * effective; `false` flags and empty arrays do not count.
 */
export interface BoundPruneInput {
	/** Match memories whose `expiresAt` is in the past. */
	expired?: boolean | undefined;
	/** Match memories that have been superseded (`supersededBy !== null`). */
	superseded?: boolean | undefined;
	/** Match memories created strictly before this date. */
	createdBefore?: Date | undefined;
	/**
	 * Match memories last accessed strictly before this date. A memory that
	 * was never accessed counts from its `createdAt`, so one created after
	 * the date is kept.
	 */
	notAccessedSince?: Date | undefined;
	/** Match memories of these kinds. */
	kinds?: readonly MemoryKind[] | undefined;
	/** Match memories that include all of these tags. */
	tags?: readonly string[] | undefined;
	/** Match memories at or below this importance. */
	maxImportance?: ImportanceLevel | undefined;
	/**
	 * Count what would be pruned without deleting anything.
	 * @defaultValue `false`
	 */
	dryRun?: boolean | undefined;
	/**
	 * Optional cancellation signal. A pre-aborted signal prevents storage work.
	 * In-flight Postgres pruning requests server-query cancellation, but a
	 * deletion that has already committed cannot be undone.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * The selectors and options of {@link PruneInput}.
 *
 * @deprecated Use {@link BoundPruneInput}, the same type. Kept through 1.x.
 */
export type PruneSelectors = BoundPruneInput;

/**
 * Input for {@link MemoryClient.prune}: a {@link ScopeSelector}, or
 * `allNamespaces: true` for the whole installation, plus at least one
 * selector. Selectors are combined with AND.
 */
export type PruneInput<DefaultNamespace extends boolean = false> =
	BoundPruneInput &
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
	/** `true` when {@link BoundPruneInput.dryRun} was set. */
	dryRun: boolean;
}

/**
 * Options of {@link MemoryClient.pruneAuditLog} besides its scope.
 */
export interface PruneAuditLogOptions {
	/**
	 * Delete events strictly before this time. Same filter as
	 * {@link ListAuditLogOptions.before}, so a `listAuditLog` call with it
	 * shows what would go.
	 */
	before: Date;
	/**
	 * Most events one statement deletes; an integer from 1 to 10,000. On
	 * Postgres each batch is its own statement and commits on its own, so a
	 * large backlog never runs as one long transaction.
	 * @defaultValue `1000`
	 */
	batchSize?: number | undefined;
	/**
	 * Count what would be deleted without deleting anything.
	 * @defaultValue `false`
	 */
	dryRun?: boolean | undefined;
	/**
	 * Optional cancellation signal, checked before each batch. Batches that
	 * already committed stay deleted; the call then throws `"ABORTED"`.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Input for {@link MemoryClient.pruneAuditLog}: a {@link ScopeSelector}, or
 * `allNamespaces: true` for the whole installation, plus `before`.
 */
export type PruneAuditLogInput<DefaultNamespace extends boolean = false> =
	PruneAuditLogOptions &
		(
			| {
					scope: ScopeSelectorInput<DefaultNamespace>;
					allNamespaces?: never;
			  }
			| { allNamespaces: true; scope?: never }
		);

/** Result returned by {@link MemoryClient.pruneAuditLog}. */
export interface PruneAuditLogResult {
	/**
	 * Number of selected events older than `before`. Equals `deletedCount`
	 * for normal runs.
	 */
	matchedCount: number;
	/** Number of events deleted; `0` for `dryRun` runs. */
	deletedCount: number;
	/** `true` when {@link PruneAuditLogOptions.dryRun} was set. */
	dryRun: boolean;
}

/**
 * Input for {@link MemoryClient.findDuplicates}: a nearest-neighbor
 * cosine-similarity scan of the memories visible at a scope. Read-only.
 */
export interface FindDuplicatesInput<DefaultNamespace extends boolean = false>
	extends ScopedReadOptions {
	/** Scope to scan; see {@link MemoryScope} for shared memories. */
	scope: ScopeInput<DefaultNamespace>;
	/**
	 * Cosine-similarity cutoff in `[0, 1]`. Pairs whose similarity is at
	 * or above this value are returned. @defaultValue `0.95`
	 */
	threshold?: number | undefined;
	/**
	 * Maximum number of duplicate pairs to return, ordered by descending
	 * similarity. @defaultValue `100`
	 */
	limit?: number | undefined;
	/**
	 * Nearest neighbors compared per memory, 1 to 100. A pair is found when
	 * either memory is among the other's `neighbors` nearest. On Postgres the
	 * neighbors come from the HNSW index, which is approximate, so a pair can
	 * be missed. @defaultValue `10`
	 */
	neighbors?: number | undefined;
	/** Restrict the scan to these kinds. */
	kinds?: readonly MemoryKind[] | undefined;
	/** Require both memories in the pair to include all of these tags. */
	tags?: readonly string[] | undefined;
	/** Include superseded memories in the scan. @defaultValue `false` */
	includeSuperseded?: boolean | undefined;
	/** Include expired memories in the scan. @defaultValue `false` */
	includeExpired?: boolean | undefined;
	/**
	 * Optional cancellation signal. In-memory scans check it cooperatively;
	 * Postgres requests cancellation of the active duplicate-search query.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Input for {@link ExperimentalMemoryClient.findDuplicatesPage}: one page of
 * {@link MemoryClient.findDuplicates}, comparing up to `batchSize` memories
 * in id order after `cursor`. Pass the same fields on every page of a run.
 *
 * @experimental May change or be removed in a minor release.
 */
export interface FindDuplicatesPageInput<
	DefaultNamespace extends boolean = false,
> extends Omit<FindDuplicatesInput<DefaultNamespace>, "limit"> {
	/**
	 * Memories whose neighbors this page compares, 1 to 1,000. Each is
	 * compared with every memory of the scope, so a page returns at most
	 * `batchSize × neighbors` pairs. @defaultValue `500`
	 */
	batchSize?: number | undefined;
	/**
	 * Where to continue: the {@link DuplicatePage.nextCursor} of the previous
	 * page, unchanged. Omit it for the first page.
	 */
	cursor?: string | undefined;
}

/**
 * One page of duplicate pairs from
 * {@link ExperimentalMemoryClient.findDuplicatesPage}.
 *
 * @experimental May change or be removed in a minor release.
 */
export interface DuplicatePage {
	/**
	 * Pairs this page owns, most similar first, then by ids. A pair belongs
	 * to the page of the memory whose neighbors contain the other one, or of
	 * the smaller id when both do, so a run of pages returns each pair once.
	 * The order holds within the page only.
	 */
	pairs: DuplicatePair[];
	/**
	 * Opaque cursor for the next page, or `null` when this page compared the
	 * last memories. Pass it back unchanged as
	 * {@link FindDuplicatesPageInput.cursor}.
	 */
	nextCursor: string | null;
	/** Memories whose neighbors this page compared. */
	compared: number;
}

/**
 * A pair of memories that are likely duplicates, returned once: `a` is the
 * memory with the smaller id.
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
 * What an {@link AuditEvent} records. Mnemocyte writes only these five
 * today; a minor release may add event types, so a `switch` over them needs
 * a `default`.
 */
export type AuditEventType =
	| "memory.created"
	| "memory.updated"
	| "memory.deleted"
	| "memory.pruned"
	| "memory.superseded";

/**
 * A single audit-log entry recording a change.
 */
export interface AuditEvent {
	/** Unique identifier: a UUIDv7 string. */
	id: string;
	/** Scope of the change. */
	scope: MemoryRecordScope;
	/** What changed. Stored in the `description` column on Postgres. */
	type: AuditEventType;
	/** JSON-compatible structured details persisted by value with the change. */
	metadata: JsonObject;
	/** When the change was recorded. */
	timestamp: Date;
}

/**
 * Options of {@link MemoryClient.listAuditLog} besides its scope.
 */
export interface ListAuditLogOptions {
	/**
	 * Page size, ordered newest first; an integer from 1 to 1,000.
	 * @defaultValue `50`
	 */
	limit?: number | undefined;
	/**
	 * `nextCursor` from the previous page. Omit for the first page. Pass the
	 * same selector and filters on every page.
	 */
	cursor?: string | undefined;
	/**
	 * Only return events strictly before this time. A filter, not a page
	 * position: events at exactly this time are excluded.
	 */
	before?: Date | undefined;
	/**
	 * Only return events strictly after this time. A filter, not a page
	 * position: events at exactly this time are excluded.
	 */
	after?: Date | undefined;
	/**
	 * Only return events about this memory: those whose
	 * `metadata.memoryId` is this id. Events that name it in another field
	 * (`deletedWith`, `supersededBy`, `restoredIds`) and `memory.pruned`
	 * events, which carry no id, are left out. Combine it with the scope or
	 * with `allNamespaces: true`. On Postgres it needs migration
	 * `0004_audit_memory_id`.
	 */
	memoryId?: string | undefined;
	/**
	 * Optional cancellation signal. In-memory scans check it cooperatively;
	 * Postgres requests cancellation of the active audit-log query.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Input for {@link MemoryClient.listAuditLog}: a {@link ScopeSelector}, or
 * `allNamespaces: true` for the whole installation. The selector works like
 * `prune`'s: `{ namespace }` lists every entity, and `entityId`, `agentId`
 * and `sessionId` narrow it.
 */
export type ListAuditLogInput<DefaultNamespace extends boolean = false> =
	ListAuditLogOptions &
		(
			| {
					scope: ScopeSelectorInput<DefaultNamespace>;
					allNamespaces?: never;
			  }
			| { allNamespaces: true; scope?: never }
		);

/** Result of {@link MemoryClient.listAuditLog}. */
export interface ListAuditLogResult {
	/** Events newest first, by `timestamp` then `id`. */
	events: AuditEvent[];
	/**
	 * Opaque cursor for the next page, or `null` when this page is the last.
	 * Pass it back unchanged as {@link ListAuditLogOptions.cursor}.
	 */
	nextCursor: string | null;
}

/**
 * Input for {@link MemoryClient.consolidate}: mark each memory in
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
	mergeTags?: boolean | undefined;
	/**
	 * Optional cancellation signal. On Postgres it cancels the running
	 * statement; the consolidation is one statement, so a cancel before it
	 * finishes writes nothing.
	 */
	signal?: AbortSignal | undefined;
}

/**
 * Result returned by {@link MemoryClient.consolidate}.
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
	BoundStatsInput &
		(
			| { scope: ScopeSelectorInput<DefaultNamespace>; allNamespaces?: never }
			| { allNamespaces: true; scope?: never }
		);

/**
 * Input for {@link BoundMemoryClient.stats}: {@link StatsInput} without
 * `scope` and `allNamespaces`.
 */
export interface BoundStatsInput {
	/**
	 * Optional cancellation signal. In-memory scans check it cooperatively;
	 * Postgres requests cancellation of the active count query.
	 */
	signal?: AbortSignal | undefined;
}

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
 * to narrow caught values. These codes can come from any method that does
 * the work named; a method's own `@throws` lists the codes particular to
 * it:
 *
 * - `"VALIDATION"`: malformed input, including an unknown key.
 * - `"ABORTED"`: the input's `signal` aborted.
 * - `"DB"`: a driver or Postgres failure. `"MIGRATION"`: the tables are
 *   missing, out of date or not usable; `migrate` creates or upgrades them.
 * - `"EMBEDDING"` and `"TIMEOUT"`: the embedder failed or timed out. Only
 *   `add`, `addMany`, `search`, `context`, and `update` with new `content`
 *   embed text.
 * - `"CONFIG"` with reason `"MODEL_MISMATCH"` or `"DIMENSIONS_MISMATCH"`:
 *   on Postgres, the embedder differs from the one the installation
 *   recorded. Checked by the methods that embed and by `findDuplicates`.
 *
 * `DefaultNamespace` is `true` for a client created with
 * {@link MemoryConfig.namespace}: its scopes may then omit `namespace`.
 *
 * @example
 * ```ts
 * import { createMemory } from "mnemocyte";
 *
 * const memory = createMemory({ namespace: "my-app", embedder });
 * const user = memory.for({ entityId: "user_123" });
 * await user.add({ content: "Prefers short, direct answers." });
 * ```
 */
export interface MemoryClient<DefaultNamespace extends boolean = false> {
	/**
	 * Store one memory and return it. With a `key` that already exists in the
	 * scope, the existing memory is updated in place instead.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * await user.add({ content: "Prefers short, direct answers." });
	 * // With a key, a second add updates the same memory.
	 * await user.add({ key: "reply-style", content: "Prefers bullet points." });
	 * ```
	 */
	add(input: AddInput<DefaultNamespace>): Promise<Memory>;
	/**
	 * Store several memories of one scope: embed them in batches of the
	 * embedder's `maxBatch`, then write them all or none. Returns them in
	 * input order.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * await user.addMany({
	 *   memories: [
	 *     { content: "Lives in Lisbon." },
	 *     { content: "Is vegetarian.", kind: "preference" },
	 *   ],
	 * });
	 * ```
	 */
	addMany(input: AddManyInput<DefaultNamespace>): Promise<Memory[]>;
	/**
	 * Rank the memories visible at the scope against `query` with hybrid
	 * vector and keyword search.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * const results = await user.search({ query: "food", limit: 5 });
	 * for (const { content, score } of results) console.log(score, content);
	 * ```
	 */
	search(input: SearchInput<DefaultNamespace>): Promise<MemoryWithScore[]>;
	/**
	 * Return one memory by id or key, or `null` when there is none.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * const style = await user.get({ key: "reply-style" });
	 * ```
	 */
	get(input: GetInput<DefaultNamespace>): Promise<Memory | null>;
	/**
	 * Page through the memories visible at the scope, newest first.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * let cursor: string | undefined;
	 * do {
	 *   const page = await user.list({ cursor });
	 *   console.log(page.memories.length);
	 *   cursor = page.nextCursor ?? undefined;
	 * } while (cursor);
	 * ```
	 */
	list(input: ListInput<DefaultNamespace>): Promise<ListResult>;
	/**
	 * Change fields of one memory and return it. Content changes re-embed it.
	 *
	 * @throws {MnemocyteError} `"NOT_FOUND"` if no memory with that id is
	 * visible at the scope; `"CONFLICT"` with reason `"KEY_IN_USE"` if the
	 * new key is already used in the memory's scope.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * await user.update({ id, content: "Lives in Porto.", tags: ["home"] });
	 * ```
	 */
	update(input: UpdateInput<DefaultNamespace>): Promise<Memory>;
	/**
	 * Delete one memory. When it is a consolidation survivor, `dependents`
	 * says what happens to the memories consolidated into it. Resolves with
	 * the ids it deleted and restored.
	 *
	 * @throws {MnemocyteError} `"NOT_FOUND"` if no memory with that id is
	 * visible at the scope; `"CONFLICT"` with reason `"HAS_DEPENDENTS"` when
	 * it is a consolidation survivor and `dependents` is `"reject"` (the
	 * default), or with reason `"HIDDEN_DEPENDENTS"` when a dependent is not
	 * visible at the scope. Nothing is deleted on any error.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * await user.delete({ id });
	 * // A survivor of consolidate: make its duplicates active again.
	 * await user.delete({ id: survivorId, dependents: "restore" });
	 * ```
	 */
	delete(input: DeleteInput<DefaultNamespace>): Promise<DeleteResult>;
	/**
	 * Delete every memory in a scope, and the scope's audit events, in one
	 * statement. `{ namespace, entityId }` erases the entity across all agents
	 * and sessions.
	 *
	 * @throws {MnemocyteError} `"CONFLICT"` with reason `"HAS_DEPENDENTS"`
	 * when a memory outside the scope still references a memory inside it as
	 * its consolidation survivor.
	 *
	 * @example
	 * ```ts
	 * // Erase one user across all agents and sessions.
	 * const { deletedCount } = await memory
	 *   .for({ entityId: "user_123" })
	 *   .deleteScope();
	 * ```
	 */
	deleteScope(
		input: DeleteScopeInput<DefaultNamespace>,
	): Promise<DeleteScopeResult>;
	/**
	 * Search and render the results as a prompt-ready string within a token
	 * budget. Returns `""` when no memory matches.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * const context = await user.context({
	 *   query: "How should I reply?",
	 *   maxTokens: 800,
	 * });
	 * const system = `You are a helpful assistant.\n\n${context}`;
	 * ```
	 */
	context(input: ContextInput<DefaultNamespace>): Promise<string>;
	/**
	 * Bulk-delete memories that match a scope selector and at least one other
	 * selector. Pass `dryRun: true` to count without deleting.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` without a scope (or
	 * `allNamespaces: true`) or without a selector; `"CONFLICT"` with reason
	 * `"HAS_DEPENDENTS"` when a non-dry-run prune selects a memory that still
	 * has consolidation dependents. The prune deletes nothing in that case.
	 *
	 * @example
	 * ```ts
	 * // Nightly: drop expired memories across the whole installation.
	 * await memory.prune({ allNamespaces: true, expired: true });
	 * // One user's low-importance memories untouched for 90 days.
	 * await memory.for({ entityId: "user_123" }).prune({
	 *   notAccessedSince: new Date(Date.now() - 90 * 86_400_000),
	 *   maxImportance: "low",
	 * });
	 * ```
	 */
	prune(input: PruneInput<DefaultNamespace>): Promise<PruneResult>;
	/**
	 * Return pairs of near-identical memories visible at the scope, most
	 * similar first. Each memory is compared with its nearest neighbors.
	 * Read-only.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * const pairs = await user.findDuplicates({ threshold: 0.97 });
	 * for (const { a, b, similarity } of pairs) {
	 *   console.log(similarity, a.content, b.content);
	 * }
	 * ```
	 */
	findDuplicates(
		input: FindDuplicatesInput<DefaultNamespace>,
	): Promise<DuplicatePair[]>;
	/**
	 * Mark likely duplicates as superseded by one survivor, optionally merging
	 * their tags into it. Idempotent for memories that already point to the
	 * survivor. Emits one `"memory.superseded"` audit event per newly
	 * superseded memory when audit is enabled.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` for empty or duplicate
	 * `supersededIds` or a `survivorId` inside `supersededIds`;
	 * `"NOT_FOUND"` if a memory is not visible at the scope; `"CONFLICT"`
	 * with reason `"CONSOLIDATION_CHANGED"` if the survivor is itself
	 * superseded (before or during the call) or a memory points to a
	 * different survivor. Nothing is written on any error.
	 *
	 * @example
	 * ```ts
	 * const user = memory.for({ entityId: "user_123" });
	 * for (const { a, b } of await user.findDuplicates()) {
	 *   await user.consolidate({ survivorId: a.id, supersededIds: [b.id] });
	 * }
	 * ```
	 */
	consolidate(
		input: ConsolidateInput<DefaultNamespace>,
	): Promise<ConsolidateResult>;
	/**
	 * One page of the audit events a scope selector (or `allNamespaces:
	 * true`) selects, newest first. Page with `nextCursor`.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` without a selector (or
	 * `allNamespaces: true`), or for a `cursor` that is not a `nextCursor`
	 * of this method.
	 *
	 * @example
	 * ```ts
	 * // One memory's history.
	 * const { events } = await memory
	 *   .for({ entityId: "user_123" })
	 *   .listAuditLog({ memoryId: id });
	 * for (const { type, timestamp } of events) console.log(timestamp, type);
	 * ```
	 */
	listAuditLog(
		input: ListAuditLogInput<DefaultNamespace>,
	): Promise<ListAuditLogResult>;
	/**
	 * Delete audit events older than `before` that a scope selector (or
	 * `allNamespaces: true`) selects, in batches of `batchSize`. Memories are
	 * not touched, and the deletion records no audit event. Pass
	 * `dryRun: true` to count without deleting.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` without a scope (or
	 * `allNamespaces: true`), without a valid `before`, or with a
	 * `batchSize` outside 1–10,000; `"ABORTED"` when the signal aborts
	 * between batches, after the earlier batches committed.
	 *
	 * @example
	 * ```ts
	 * // Keep 30 days of audit events.
	 * await memory.pruneAuditLog({
	 *   allNamespaces: true,
	 *   before: new Date(Date.now() - 30 * 86_400_000),
	 * });
	 * ```
	 */
	pruneAuditLog(
		input: PruneAuditLogInput<DefaultNamespace>,
	): Promise<PruneAuditLogResult>;
	/**
	 * Count memories for a scope selector or the whole installation.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` without a scope (or
	 * `allNamespaces: true`); `"ABORTED"` when the signal aborts.
	 *
	 * @example
	 * ```ts
	 * const { memoryCount } = await memory
	 *   .for({ entityId: "user_123" })
	 *   .stats();
	 * const total = await memory.stats({ allNamespaces: true });
	 * ```
	 */
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
	 * import { createMemory } from "mnemocyte";
	 *
	 * const memory = createMemory({ namespace: "my-app", store, embedder });
	 * const userMemory = memory.for({ entityId: userId });
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
	 * {@link MemoryClient.findDuplicates} in pages, so each call is bounded
	 * and a run can be resumed: a page compares up to `batchSize` memories
	 * after the cursor, in id order, with every memory of the scope, and
	 * returns the pairs it owns. Same rules as `findDuplicates`, with no
	 * `limit`; the pages of a run return each pair once. Read-only.
	 *
	 * Each page reads the scope again, so memories added, changed or
	 * superseded between pages can make a pair come twice or not at all.
	 *
	 * @example
	 * ```ts
	 * let cursor: string | undefined;
	 * do {
	 *   const page = await memory.experimental.findDuplicatesPage({
	 *     scope,
	 *     cursor,
	 *   });
	 *   await review(page.pairs);
	 *   cursor = page.nextCursor ?? undefined;
	 * } while (cursor);
	 * ```
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` for a `cursor` that is not a
	 * `nextCursor` of this method, or the inputs `findDuplicates` rejects.
	 */
	findDuplicatesPage(
		input: FindDuplicatesPageInput<DefaultNamespace>,
	): Promise<DuplicatePage>;
	/**
	 * {@link MemoryClient.context}, plus the memories it rendered and the
	 * ones the token budget left out, for citations and debugging. The
	 * `context` string is the one `context()` returns for the same input;
	 * `explain: true` adds each memory's score breakdown.
	 *
	 * @example
	 * ```ts
	 * const { context, memories } =
	 *   await memory.experimental.contextWithMemories({ scope, query });
	 * const sources = memories.map((m) => m.id);
	 * ```
	 *
	 * @throws {MnemocyteError} the errors {@link MemoryClient.context} throws.
	 */
	contextWithMemories(
		input: ContextWithMemoriesInput<DefaultNamespace>,
	): Promise<ContextWithMemoriesResult>;
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
/**
 * Input for {@link BoundExperimentalMemoryClient.contextWithMemories}.
 *
 * @experimental May change or be removed in a minor release.
 */
export type BoundContextWithMemoriesInput = Omit<
	ContextWithMemoriesInput,
	"scope"
>;
/** Input for {@link BoundMemoryClient.findDuplicates}. */
export type BoundFindDuplicatesInput = Omit<FindDuplicatesInput, "scope">;
/**
 * Input for {@link BoundExperimentalMemoryClient.findDuplicatesPage}.
 *
 * @experimental May change or be removed in a minor release.
 */
export type BoundFindDuplicatesPageInput = Omit<
	FindDuplicatesPageInput,
	"scope"
>;
/** Input for {@link BoundMemoryClient.listAuditLog}. */
export type BoundListAuditLogInput = ListAuditLogOptions;
/** Input for {@link BoundMemoryClient.consolidate}. */
export type BoundConsolidateInput = Omit<ConsolidateInput, "scope">;
/** Input for {@link BoundMemoryClient.pruneAuditLog}. */
export type BoundPruneAuditLogInput = PruneAuditLogOptions;

/**
 * A client bound to one scope, from {@link MemoryClient.for}. Its methods
 * take no `scope` field and reject one at runtime with `"VALIDATION"`, as
 * they reject `allNamespaces`: operations across namespaces stay on the
 * unbound client. Reads and changes by id see the bound scope plus shared
 * memories, as on the unbound client; `deleteScope`, `prune`, `stats`,
 * `listAuditLog` and `pruneAuditLog` select within the bound scope, where
 * an omitted `agentId` or `sessionId` matches any value.
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
	delete(input: BoundDeleteInput): Promise<DeleteResult>;
	/**
	 * Delete every memory in the bound scope, and its audit events. A scope
	 * without `agentId` or `sessionId` erases the entity across all agents
	 * or sessions; see {@link MemoryClient.deleteScope}.
	 */
	deleteScope(input?: BoundDeleteScopeInput): Promise<DeleteScopeResult>;
	/** {@link MemoryClient.context} at the bound scope. */
	context(input: BoundContextInput): Promise<string>;
	/** {@link MemoryClient.prune} within the bound scope. */
	prune(input: BoundPruneInput): Promise<PruneResult>;
	/** {@link MemoryClient.findDuplicates} at the bound scope. */
	findDuplicates(input?: BoundFindDuplicatesInput): Promise<DuplicatePair[]>;
	/** {@link MemoryClient.consolidate} at the bound scope. */
	consolidate(input: BoundConsolidateInput): Promise<ConsolidateResult>;
	/** {@link MemoryClient.listAuditLog} within the bound scope. */
	listAuditLog(input?: BoundListAuditLogInput): Promise<ListAuditLogResult>;
	/** {@link MemoryClient.pruneAuditLog} within the bound scope. */
	pruneAuditLog(input: BoundPruneAuditLogInput): Promise<PruneAuditLogResult>;
	/** {@link MemoryClient.stats} within the bound scope. */
	stats(input?: BoundStatsInput): Promise<MemoryStats>;
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
	/**
	 * {@link ExperimentalMemoryClient.findDuplicatesPage} at the bound
	 * scope.
	 */
	findDuplicatesPage(
		input?: BoundFindDuplicatesPageInput,
	): Promise<DuplicatePage>;
	/**
	 * {@link ExperimentalMemoryClient.contextWithMemories} at the bound
	 * scope.
	 */
	contextWithMemories(
		input: BoundContextWithMemoriesInput,
	): Promise<ContextWithMemoriesResult>;
}
