export type MemoryType =
	| "fact"
	| "preference"
	| "instruction"
	| "backstory"
	| "episode"
	| "session";

export type ImportanceLevel = "low" | "normal" | "high" | "critical";

export type ContextFormat = "markdown" | "plain" | "xml";

export type MnemocyteBackend = "in-memory" | "postgres";

export type MnemocyteOperation =
	| "remember"
	| "rememberMany"
	| "recall"
	| "buildContext"
	| "forget"
	| "forgetAll"
	| "stats"
	| "close";

export type MnemocyteObservationPhase = "start" | "success" | "error";

export interface MnemocyteObservation {
	operation: MnemocyteOperation;
	phase: MnemocyteObservationPhase;
	backend: MnemocyteBackend;
	timestamp: Date;
	durationMs?: number;
	entityId?: string;
	memoryId?: string;
	count?: number;
	error?: unknown;
}

export interface ObservabilityConfig {
	onEvent?: (event: MnemocyteObservation) => void | Promise<void>;
}

export interface MnemocyteConfig {
	databaseUrl?: string;
	embedder: Embedder;
	defaults?: {
		limit?: number;
		minScore?: number;
	};
	retrieval?: RetrievalConfig;
	observability?: ObservabilityConfig;
}

export interface Embedder {
	readonly model: string;
	readonly dimensions: number;
	embed(texts: readonly string[]): Promise<number[][]>;
}

export interface Memory {
	id: string;
	entityId: string;
	content: string;
	type: MemoryType;
	importance: ImportanceLevel;
	tags: string[];
	source: string | null;
	metadata: Record<string, unknown>;
	confidence: number;
	embeddingModel: string;
	embeddingDimensions: number;
	supersededBy: string | null;
	expiresAt: Date | null;
	lastAccessedAt: Date | null;
	accessCount: number;
	createdAt: Date;
	updatedAt: Date;
}

export interface RetrievalScores {
	vector: number;
	lexical: number;
	recency: number;
	confidence: number;
	access: number;
	importance: number;
}

export interface RetrievalScoreWeights {
	vector?: number;
	lexical?: number;
	recency?: number;
	confidence?: number;
	access?: number;
	importance?: number;
}

export interface RetrievalConfig {
	weights?: RetrievalScoreWeights;
	recencyHalfLifeDays?: number;
	accessSaturation?: number;
	candidateMultiplier?: number;
}

export interface RetrievalExplanation {
	vectorScore: number;
	lexicalScore: number;
	recencyScore: number;
	confidenceScore: number;
	accessScore: number;
	importanceScore: number;
	importanceBoost: number;
	weights: Required<RetrievalScoreWeights>;
	finalScore: number;
}

export interface MemoryWithScore extends Memory {
	score: number;
	scores: RetrievalScores;
	explanation: RetrievalExplanation | null;
}

export interface RememberInput {
	entityId: string;
	content: string;
	type?: MemoryType;
	importance?: ImportanceLevel;
	tags?: string[];
	source?: string;
	metadata?: Record<string, unknown>;
	confidence?: number;
	expiresAt?: Date;
}

export interface RecallInput {
	entityId: string;
	query: string;
	limit?: number;
	minScore?: number;
	types?: MemoryType[];
	tags?: string[];
	before?: Date;
	after?: Date;
	includeSuperseded?: boolean;
	includeExpired?: boolean;
	explain?: boolean;
}

export interface TokenCounter {
	count(text: string): number;
}

export interface BuildContextInput {
	entityId: string;
	query: string;
	format?: ContextFormat;
	maxTokens?: number;
	limit?: number;
	minScore?: number;
	types?: MemoryType[];
	tags?: string[];
	includeSuperseded?: boolean;
	includeExpired?: boolean;
	tokenCounter?: TokenCounter;
}

export interface EntityStats {
	entityId: string;
	memoryCount: number;
	activeMemoryCount: number;
	expiredMemoryCount: number;
	supersededMemoryCount: number;
}

export interface GlobalStats {
	entityCount: number;
	memoryCount: number;
	activeMemoryCount: number;
	expiredMemoryCount: number;
	supersededMemoryCount: number;
}

export interface MnemocyteClient {
	remember(input: RememberInput): Promise<Memory>;
	rememberMany(inputs: readonly RememberInput[]): Promise<Memory[]>;
	recall(input: RecallInput): Promise<MemoryWithScore[]>;
	buildContext(input: BuildContextInput): Promise<string>;
	forget(input: { entityId: string; memoryId: string }): Promise<void>;
	forgetAll(input: { entityId: string }): Promise<void>;
	stats(input?: { entityId?: string }): Promise<EntityStats | GlobalStats>;
	close(): Promise<void>;
}
