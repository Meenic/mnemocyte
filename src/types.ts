/**
 * Discriminator describing what kind of memory a {@link Memory} represents.
 *
 * - `"fact"` — a stable, objective statement.
 * - `"preference"` — a user/entity preference that should bias future responses.
 * - `"instruction"` — a directive the agent should follow.
 * - `"backstory"` — long-lived background context about the entity.
 * - `"episode"` — a discrete past event.
 * - `"session"` — short-lived context tied to a single session.
 *
 * @defaultValue `"fact"` when omitted on {@link RememberInput}.
 */
export type MemoryType =
	| "fact"
	| "preference"
	| "instruction"
	| "backstory"
	| "episode"
	| "session";

/**
 * Relative importance assigned to a memory. Influences retrieval ranking
 * via the `importance` score component.
 *
 * @defaultValue `"normal"` when omitted on {@link RememberInput}.
 */
export type ImportanceLevel = "low" | "normal" | "high" | "critical";

/**
 * Output format produced by {@link MnemocyteClient.buildContext}.
 *
 * - `"markdown"` — headings + bullet list (default; LLM-friendly).
 * - `"plain"` — newline-separated plain text.
 * - `"xml"` — structured tags, useful for models that parse XML reliably.
 *
 * @defaultValue `"markdown"`
 */
export type ContextFormat = "markdown" | "plain" | "xml";

/**
 * Identifies which backend a {@link MnemocyteClient} is using.
 *
 * Selected automatically by {@link createMnemocyte} based on whether
 * {@link MnemocyteConfig.databaseUrl} was provided.
 */
export type MnemocyteBackend = "in-memory" | "postgres";

/**
 * The set of public {@link MnemocyteClient} methods that emit
 * {@link MnemocyteObservation} events through {@link ObservabilityConfig.onEvent}.
 */
export type MnemocyteOperation =
	| "remember"
	| "rememberMany"
	| "recall"
	| "buildContext"
	| "forget"
	| "forgetAll"
	| "prune"
	| "stats"
	| "close";

/**
 * Lifecycle phase of a {@link MnemocyteObservation}.
 *
 * Every operation emits exactly one `"start"` event and exactly one of
 * `"success"` or `"error"` once it settles.
 */
export type MnemocyteObservationPhase = "start" | "success" | "error";

/**
 * A single observability event emitted by a {@link MnemocyteClient}.
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
	/** Entity ID associated with the operation, when applicable. */
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
	 * {@link MnemocyteObservation}. May be sync or async; the operation will
	 * not be delayed waiting for slow async hooks beyond the awaited dispatch.
	 */
	onEvent?: (event: MnemocyteObservation) => void | Promise<void>;
}

/**
 * Production-hardening knobs applied to outbound provider calls
 * (currently the {@link Embedder}). Mnemocyte applies a timeout, retries
 * on transient failures, and forwards `AbortSignal` cancellation to each
 * attempt. Every field is optional with conservative defaults; the
 * defaults disable retries and timeouts so existing setups are
 * unaffected unless they opt in.
 */
export interface ProviderResilienceConfig {
	/**
	 * Maximum time, in milliseconds, that a single provider attempt may
	 * run before a {@link MnemocyteError} with code `"TIMEOUT"` is thrown.
	 * Defaults to `0` which disables the timeout.
	 */
	timeoutMs?: number;
	/**
	 * Maximum number of retry attempts after the initial call. `0`
	 * disables retries (default).
	 */
	retries?: number;
	/** Base backoff delay (ms) used before the first retry. Defaults to `100`. */
	baseDelayMs?: number;
	/** Maximum backoff delay (ms) used between retries. Defaults to `2000`. */
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

/**
 * Configuration passed to {@link createMnemocyte}.
 */
export interface MnemocyteConfig {
	/**
	 * Postgres connection string. When set, the client uses the Postgres
	 * backend (requires the `pgvector` extension and the bundled migration).
	 * When omitted, an in-memory backend is used.
	 */
	databaseUrl?: string;
	/** Required embedder used to vectorise content for storage and retrieval. */
	embedder: Embedder;
	/** Default values applied to {@link RecallInput} when properties are omitted. */
	defaults?: {
		/** Default `limit` for {@link MnemocyteClient.recall}. */
		limit?: number;
		/** Default `minScore` cutoff for {@link MnemocyteClient.recall}. */
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
}

/**
 * Pluggable embedding provider. Wraps an external embedding API
 * (e.g. OpenAI, Cohere, a local model) in a small interface.
 *
 * Mnemocyte records {@link Embedder.model} and {@link Embedder.dimensions}
 * on every stored memory and uses them to detect incompatible vectors
 * (e.g. when the model is swapped).
 */
export interface Embedder {
	/** Stable identifier for the underlying model (e.g. `"text-embedding-3-small"`). */
	readonly model: string;
	/** Dimensionality of vectors returned by {@link Embedder.embed}. */
	readonly dimensions: number;
	/**
	 * Embed one or more texts. Implementations MUST return one vector per
	 * input, in the same order, each of length {@link Embedder.dimensions}.
	 *
	 * The optional `options.signal` is forwarded by Mnemocyte when the
	 * caller passes a `signal` on a {@link RememberInput} / {@link RecallInput}
	 * / {@link BuildContextInput}, or when Mnemocyte's own provider timeout
	 * fires. Implementations that integrate with `fetch` should forward
	 * the signal to it so requests can be cancelled promptly.
	 */
	embed(
		texts: readonly string[],
		options?: { signal?: AbortSignal },
	): Promise<number[][]>;
}

/**
 * A persisted memory record as returned by the client.
 *
 * Memories are immutable from the caller's perspective; updates produce a
 * new memory and link the previous one via {@link Memory.supersededBy}.
 */
export interface Memory {
	/** Unique identifier (UUID for Postgres backend). */
	id: string;
	/** Owning entity — typically a user, agent, or session ID. */
	entityId: string;
	/** Raw textual content of the memory. */
	content: string;
	/** Discriminator describing the kind of memory. */
	type: MemoryType;
	/** Relative importance assigned at write time. */
	importance: ImportanceLevel;
	/** Free-form tags used for filtering on {@link RecallInput.tags}. */
	tags: string[];
	/** Optional human-readable source attribution (e.g. `"chat:2024-04-12"`). */
	source: string | null;
	/** Arbitrary user-provided metadata persisted alongside the memory. */
	metadata: Record<string, unknown>;
	/** Confidence in `[0, 1]`. Used in retrieval ranking. */
	confidence: number;
	/** {@link Embedder.model} value at write time. */
	embeddingModel: string;
	/** {@link Embedder.dimensions} value at write time. */
	embeddingDimensions: number;
	/** ID of the memory that supersedes this one, or `null` if active. */
	supersededBy: string | null;
	/** Optional expiry; expired memories are filtered out by default. */
	expiresAt: Date | null;
	/** Last time this memory was returned by {@link MnemocyteClient.recall}. */
	lastAccessedAt: Date | null;
	/** Cumulative number of times this memory has been recalled. */
	accessCount: number;
	/** Creation timestamp. */
	createdAt: Date;
	/** Most recent update timestamp. */
	updatedAt: Date;
}

/**
 * Per-component scores produced during retrieval ranking. Each value is
 * normalised to `[0, 1]` before being combined via
 * {@link RetrievalScoreWeights}.
 */
export interface RetrievalScores {
	/** Cosine similarity between the query embedding and the memory embedding. */
	vector: number;
	/** Token-overlap (lexical) score between query and memory content. */
	lexical: number;
	/** Time-decay score based on {@link RetrievalConfig.recencyHalfLifeDays}. */
	recency: number;
	/** Pass-through of the memory's stored `confidence`. */
	confidence: number;
	/** Saturating score derived from `accessCount`. */
	access: number;
	/** Score derived from {@link ImportanceLevel}. */
	importance: number;
}

/**
 * Optional overrides for the per-component retrieval weights. Missing keys
 * fall back to library defaults. Weights need not sum to 1; the final
 * score is computed as a weighted sum of {@link RetrievalScores}.
 */
export interface RetrievalScoreWeights {
	/** Weight applied to {@link RetrievalScores.vector}. */
	vector?: number;
	/** Weight applied to {@link RetrievalScores.lexical}. */
	lexical?: number;
	/** Weight applied to {@link RetrievalScores.recency}. */
	recency?: number;
	/** Weight applied to {@link RetrievalScores.confidence}. */
	confidence?: number;
	/** Weight applied to {@link RetrievalScores.access}. */
	access?: number;
	/** Weight applied to {@link RetrievalScores.importance}. */
	importance?: number;
}

/**
 * Retrieval-ranking tuning. All fields are optional; sensible defaults are
 * used for any field that is omitted.
 */
export interface RetrievalConfig {
	/** Per-component score weights. See {@link RetrievalScoreWeights}. */
	weights?: RetrievalScoreWeights;
	/** Half-life (days) for the time-decay recency component. */
	recencyHalfLifeDays?: number;
	/** Access count at which the access score is considered saturated. */
	accessSaturation?: number;
	/**
	 * Multiplier applied to {@link RecallInput.limit} to determine how many
	 * candidates are fetched from the underlying store before re-ranking.
	 */
	candidateMultiplier?: number;
}

/**
 * Detailed scoring breakdown attached to each {@link MemoryWithScore} when
 * {@link RecallInput.explain} is `true`. Useful for debugging ranking and
 * tuning {@link RetrievalConfig}.
 */
export interface RetrievalExplanation {
	/** Raw vector similarity in `[0, 1]`. */
	vectorScore: number;
	/** Raw lexical-overlap score in `[0, 1]`. */
	lexicalScore: number;
	/** Raw recency score in `[0, 1]`. */
	recencyScore: number;
	/** Raw confidence score in `[0, 1]`. */
	confidenceScore: number;
	/** Raw access score in `[0, 1]`. */
	accessScore: number;
	/** Raw importance score in `[0, 1]`. */
	importanceScore: number;
	/** Additive multiplier applied for high-importance memories. */
	importanceBoost: number;
	/** Effective weights used for this query (defaults filled in). */
	weights: Required<RetrievalScoreWeights>;
	/** Final combined score — same value as {@link MemoryWithScore.score}. */
	finalScore: number;
}

/**
 * A {@link Memory} returned by {@link MnemocyteClient.recall}, annotated
 * with retrieval scores.
 */
export interface MemoryWithScore extends Memory {
	/** Final combined relevance score. Higher is better. */
	score: number;
	/** Per-component scores that produced {@link MemoryWithScore.score}. */
	scores: RetrievalScores;
	/**
	 * Full scoring breakdown when {@link RecallInput.explain} is `true`,
	 * `null` otherwise.
	 */
	explanation: RetrievalExplanation | null;
}

/**
 * Input for {@link MnemocyteClient.remember} and
 * {@link MnemocyteClient.rememberMany}.
 */
export interface RememberInput {
	/** Owning entity ID (e.g. user, agent, or session). */
	entityId: string;
	/** Raw textual content to store. Must be non-empty. */
	content: string;
	/** Memory kind. @defaultValue `"fact"` */
	type?: MemoryType;
	/** Relative importance. @defaultValue `"normal"` */
	importance?: ImportanceLevel;
	/** Free-form tags used for later filtering. */
	tags?: string[];
	/** Optional human-readable source attribution. */
	source?: string;
	/** Arbitrary metadata persisted alongside the memory. */
	metadata?: Record<string, unknown>;
	/** Confidence in `[0, 1]`. @defaultValue `1` */
	confidence?: number;
	/** Optional expiry; expired memories are filtered out by default. */
	expiresAt?: Date;
	/**
	 * Optional cancellation signal. Forwarded to the embedder; when
	 * aborted, the operation throws a {@link MnemocyteError} with code
	 * `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/**
 * Input for {@link MnemocyteClient.recall}.
 */
export interface RecallInput {
	/** Owning entity ID to search within. */
	entityId: string;
	/** Free-text query; embedded and matched against stored memories. */
	query: string;
	/** Maximum number of results. Falls back to {@link MnemocyteConfig.defaults}. */
	limit?: number;
	/** Minimum final score required for a memory to be returned. */
	minScore?: number;
	/** Restrict results to these memory types. */
	types?: MemoryType[];
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
	 * Optional cancellation signal. Forwarded to the embedder; when
	 * aborted, the operation throws a {@link MnemocyteError} with code
	 * `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/**
 * Pluggable token counter used by {@link MnemocyteClient.buildContext} to
 * enforce {@link BuildContextInput.maxTokens}. Plug in your model's real
 * tokenizer (e.g. `tiktoken`) for accurate budgeting; a simple word-based
 * heuristic is used when omitted.
 */
export interface TokenCounter {
	/** Return the number of tokens in `text`. */
	count(text: string): number;
}

/**
 * Input for {@link MnemocyteClient.buildContext}, which renders relevant
 * memories into a prompt-ready string.
 */
export interface BuildContextInput {
	/** Owning entity ID to search within. */
	entityId: string;
	/** Free-text query used to select relevant memories. */
	query: string;
	/** Output format. @defaultValue `"markdown"` */
	format?: ContextFormat;
	/** Optional token budget; memories are dropped from the tail until the budget fits. */
	maxTokens?: number;
	/** Maximum number of memories to consider. */
	limit?: number;
	/** Minimum retrieval score required. */
	minScore?: number;
	/** Restrict to these memory types. */
	types?: MemoryType[];
	/** Require results to include all of these tags. */
	tags?: string[];
	/** Include superseded memories. @defaultValue `false` */
	includeSuperseded?: boolean;
	/** Include expired memories. @defaultValue `false` */
	includeExpired?: boolean;
	/** Tokenizer used to enforce {@link BuildContextInput.maxTokens}. */
	tokenCounter?: TokenCounter;
	/**
	 * Optional cancellation signal. Forwarded to the underlying recall
	 * call and embedder; when aborted, the operation throws a
	 * {@link MnemocyteError} with code `"ABORTED"`.
	 */
	signal?: AbortSignal;
}

/**
 * Input for {@link MnemocyteClient.prune}. All fields are optional, but
 * at least one selector must be set; calling `prune({})` is rejected with
 * a `"VALIDATION"` {@link MnemocyteError} so memories cannot be deleted
 * accidentally. Specified filters are combined with AND semantics.
 */
export interface PruneInput {
	/** Restrict pruning to a single entity. */
	entityId?: string;
	/** Match memories whose `expiresAt` is in the past. */
	expired?: boolean;
	/** Match memories that have been superseded (`supersededBy !== null`). */
	superseded?: boolean;
	/** Match memories created strictly before this date. */
	createdBefore?: Date;
	/**
	 * Match memories whose `lastAccessedAt` is `null` or strictly before
	 * this date. Useful for evicting "cold" memories.
	 */
	notAccessedSince?: Date;
	/** Restrict pruning to these memory types. */
	types?: MemoryType[];
	/**
	 * Require memories to include all of these tags. Empty array is
	 * treated as no tag filter.
	 */
	tags?: string[];
	/**
	 * Match memories whose `importance` is at or below this level. For
	 * example, `"normal"` prunes `"low"` and `"normal"` but never `"high"`
	 * or `"critical"`. Useful for evicting low-value memories first.
	 */
	maxImportance?: ImportanceLevel;
	/**
	 * If `true`, count what would be pruned without deleting anything.
	 * @defaultValue `false`
	 */
	dryRun?: boolean;
	/** Optional cancellation signal. */
	signal?: AbortSignal;
}

/**
 * Result returned by {@link MnemocyteClient.prune}.
 */
export interface PruneResult {
	/** Number of memories that matched the prune filter. */
	matchedCount: number;
	/**
	 * Number of memories actually deleted. Equals `matchedCount` for
	 * normal runs and `0` for `dryRun` runs.
	 */
	deletedCount: number;
	/** `true` when {@link PruneInput.dryRun} was set. */
	dryRun: boolean;
}

/**
 * Stats for a single entity, returned by
 * {@link MnemocyteClient.stats} when an `entityId` is provided.
 */
export interface EntityStats {
	/** The entity these stats describe. */
	entityId: string;
	/** Total number of memories ever stored for this entity. */
	memoryCount: number;
	/** Memories that are neither expired nor superseded. */
	activeMemoryCount: number;
	/** Memories whose `expiresAt` has passed. */
	expiredMemoryCount: number;
	/** Memories that have been superseded by a newer one. */
	supersededMemoryCount: number;
}

/**
 * Stats aggregated across all entities, returned by
 * {@link MnemocyteClient.stats} when no `entityId` is provided.
 */
export interface GlobalStats {
	/** Number of distinct entities with at least one memory. */
	entityCount: number;
	/** Total number of memories across all entities. */
	memoryCount: number;
	/** Memories that are neither expired nor superseded. */
	activeMemoryCount: number;
	/** Memories whose `expiresAt` has passed. */
	expiredMemoryCount: number;
	/** Memories that have been superseded by a newer one. */
	supersededMemoryCount: number;
}

/**
 * The Mnemocyte client. Returned by {@link createMnemocyte}.
 *
 * Every method may throw {@link MnemocyteError}; use {@link isMnemocyteError}
 * to narrow caught values.
 */
export interface MnemocyteClient {
	/**
	 * Persist a single memory and return the stored record.
	 *
	 * @throws {MnemocyteError} `"VALIDATION"` for invalid input, `"EMBEDDING"`
	 * if the embedder fails, `"DB"` for storage failures.
	 */
	remember(input: RememberInput): Promise<Memory>;
	/**
	 * Persist multiple memories in one round-trip. Returns the stored records
	 * in the same order as `inputs`.
	 */
	rememberMany(inputs: readonly RememberInput[]): Promise<Memory[]>;
	/**
	 * Retrieve the most relevant memories for `input.query`, ranked by the
	 * configured {@link RetrievalConfig}.
	 */
	recall(input: RecallInput): Promise<MemoryWithScore[]>;
	/**
	 * Build a prompt-ready context string from the most relevant memories.
	 * Respects {@link BuildContextInput.maxTokens} when supplied.
	 */
	buildContext(input: BuildContextInput): Promise<string>;
	/**
	 * Delete a specific memory belonging to `entityId`.
	 *
	 * @throws {MnemocyteError} `"NOT_FOUND"` if the memory does not exist
	 * or does not belong to `entityId`.
	 */
	forget(input: { entityId: string; memoryId: string }): Promise<void>;
	/** Delete every memory belonging to `entityId`. */
	forgetAll(input: { entityId: string }): Promise<void>;
	/**
	 * Bulk-delete memories matching the filters on {@link PruneInput}.
	 *
	 * At least one filter must be specified; an empty input throws a
	 * `"VALIDATION"` {@link MnemocyteError} to avoid accidental full
	 * deletion. Pass `dryRun: true` to count without deleting.
	 *
	 * @example Evict expired or stale memories for an entity
	 * ```ts
	 * await client.prune({
	 *   entityId: "user_123",
	 *   expired: true,
	 * });
	 *
	 * await client.prune({
	 *   notAccessedSince: new Date(Date.now() - 30 * 24 * 3600 * 1000),
	 *   maxImportance: "normal",
	 * });
	 * ```
	 */
	prune(input: PruneInput): Promise<PruneResult>;
	/**
	 * Return statistics. With an `entityId`, returns {@link EntityStats};
	 * without one, returns {@link GlobalStats}.
	 */
	stats(input?: { entityId?: string }): Promise<EntityStats | GlobalStats>;
	/**
	 * Release any underlying resources (e.g. the Postgres connection pool).
	 * Safe to call multiple times. The client must not be used afterward.
	 */
	close(): Promise<void>;
}
