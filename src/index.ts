/**
 * Mnemocyte — persistent memory for TypeScript AI apps.
 *
 * The package is ESM-only. Use `import` rather than CommonJS `require`.
 *
 * @example Basic usage
 * ```ts
 * import { createMnemocyte } from "mnemocyte";
 *
 * const client = createMnemocyte({
 *   embedder: {
 *     model: "demo",
 *     dimensions: 3,
 *     async embed(texts) {
 *       return texts.map((text) => [text.length, 1, 0]);
 *     },
 *   },
 * });
 *
 * await client.remember({
 *   entityId: "user_123",
 *   content: "Prefers short, direct answers.",
 *   type: "preference",
 * });
 *
 * const memories = await client.recall({
 *   entityId: "user_123",
 *   query: "How should I respond?",
 *   limit: 5,
 * });
 *
 * await client.close();
 * ```
 *
 * @packageDocumentation
 */

export { createMnemocyte } from "./client.js";
export type { MnemocyteErrorCode } from "./errors.js";
export { isMnemocyteError, MnemocyteError } from "./errors.js";
export type {
	BuildContextInput,
	ContextFormat,
	Embedder,
	EntityStats,
	GlobalStats,
	ImportanceLevel,
	Memory,
	MemoryType,
	MemoryWithScore,
	MnemocyteBackend,
	MnemocyteClient,
	MnemocyteConfig,
	MnemocyteObservation,
	MnemocyteObservationPhase,
	MnemocyteOperation,
	ObservabilityConfig,
	ProviderResilienceConfig,
	PruneInput,
	PruneResult,
	RecallInput,
	RememberInput,
	RetrievalConfig,
	RetrievalExplanation,
	RetrievalScores,
	RetrievalScoreWeights,
	TokenCounter,
} from "./types.js";
