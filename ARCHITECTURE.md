# Mnemocyte Architecture

> This is the canonical architecture document for Mnemocyte. It describes the current MVP architecture and the planned path toward a production-ready package.

## Current Status

Mnemocyte currently exposes an MVP public API through `createMnemocyte()`. The client supports an in-memory backend when `databaseUrl` is omitted and a Postgres/pgvector backend when `databaseUrl` is provided.

The package is ESM-only for now. CommonJS is intentionally not advertised unless the build later emits and tests a real CJS artifact.

## Goals

- **Maintainability:** each module has one responsibility and clear boundaries.
- **TypeScript-first DX:** public types are exported from `mnemocyte` and APIs are easy to evolve before v1.
- **Minimal infrastructure:** Postgres with pgvector is the default persistence and vector search backend.
- **Realistic agent memory:** prioritize reliable recall, provenance, lifecycle, and debuggability over speculative intelligence.
- **Package correctness:** npm metadata, exports, build output, and docs must match what is actually shipped.

## Non-Goals

- No separate vector database for the MVP.
- No stable CommonJS export until CJS output is produced and tested.
- No hidden schema creation from the client constructor.
- No unimplemented methods in the stable public API.
- No full autonomous memory consolidation in the MVP.

## Package Strategy

Mnemocyte should remain ESM-only until there is a strong reason to dual-publish.

```json
{
  "type": "module",
  "files": ["dist", "migrations"],
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs"
    }
  },
  "types": "./dist/index.d.mts",
  "scripts": {
    "build": "tsdown src/index.ts",
    "dev": "tsdown src/index.ts --watch",
    "checktypes": "tsc --noEmit",
    "lint": "biome lint --write",
    "format": "biome format --write",
    "test:retrieval": "pnpm build && node test/retrieval/quality.test.mjs",
    "test:integration": "pnpm build && node test/integration/postgres.test.mjs",
    "bench:retrieval": "pnpm build && node test/benchmarks/retrieval.bench.mjs",
    "pack:dry": "pnpm pack --dry-run",
    "prepublishOnly": "pnpm build && pnpm checktypes && pnpm pack:dry"
  }
}
```

If CommonJS support is added later, the package must emit `dist/index.cjs` and CI must validate both `import("mnemocyte")` and `require("mnemocyte")`.

## Runtime Dependencies

Use `postgres` for the database driver. In this document, `postgres` means the postgres.js npm package, not PostgreSQL itself.

```json
{
  "dependencies": {
    "drizzle-orm": "^0.45.2",
    "postgres": "^3.4.7"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.15",
    "@types/node": "^25.7.0",
    "drizzle-kit": "^0.31.0",
    "tsdown": "^0.22.0",
    "typescript": "^6.0.3"
  }
}
```

## TypeScript Strategy

The package should keep strict type checking and explicit ESM behavior.

Current strict options worth keeping:

- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `verbatimModuleSyntax`
- `isolatedModules`
- `declaration`
- `declarationMap`

Before production, choose a stable Node target policy. `nodenext` is acceptable while the package is early, but a library should document the supported Node range and test it in CI.

## Module Structure

```text
src/
├── index.ts                  # public API exports only
├── client.ts                 # createMnemocyte() factory
├── types.ts                  # public types
├── errors.ts                 # typed error hierarchy
│
├── db/
│   ├── index.ts              # postgres.js + drizzle setup
│   ├── schema.ts             # drizzle table definitions
│   └── queries/
│       ├── memories.ts       # memory CRUD and retrieval filters
│       └── events.ts         # event CRUD
│
├── embed/
│   ├── types.ts              # Embedder interface
│   ├── index.ts              # provider factory
│   └── providers/
│       ├── openai.ts         # OpenAI-compatible embeddings
│       └── ollama.ts         # local Ollama embeddings
│
├── retrieval/
│   ├── index.ts              # retrieval orchestration
│   ├── vector.ts             # pgvector search
│   ├── lexical.ts            # PostgreSQL full-text search
│   └── scorer.ts             # score fusion
│
├── memory/
│   ├── shared.ts             # validation, mapping, embedding helpers
│   ├── in-memory.ts          # in-memory MVP backend
│   └── postgres.ts           # Postgres-backed production backend
│
└── context/
    ├── builder.ts            # buildContext()
    ├── formatter.ts          # safe markdown/plain/xml formatting
    └── tokens.ts             # token counting abstraction
```

Layering rule: lower-level modules must not import higher-level modules. For example, `db/` must not import from `memory/`, and `retrieval/` must not import from `context/`.

## Public API Direction

Use object parameters rather than positional APIs. This keeps the API evolvable before v1 without adding breaking positional arguments.

```ts
import { createMnemocyte } from "mnemocyte";

const client = createMnemocyte({
databaseUrl: process.env.DATABASE_URL!,
embedder: {
model: "text-embedding-3-small",
dimensions: 1536,
async embed(texts) {
return embedWithProvider(texts);
},
},
});

await client.remember({
entityId: "user_123",
content: "Prefers short, direct answers.",
type: "preference",
source: "chat",
confidence: 0.9,
});

const memories = await client.recall({
entityId: "user_123",
query: "How should I respond?",
limit: 5,
types: ["preference", "instruction"],
});

await client.close();
```

## Core Public Types

```ts
export type MemoryType = "fact" | "preference" | "instruction" | "backstory" | "episode" | "session";
export type ImportanceLevel = "low" | "normal" | "high" | "critical";
export type ContextFormat = "markdown" | "plain" | "xml";

export interface MnemocyteConfig {
databaseUrl?: string;
embedder: Embedder;
defaults?: {
limit?: number;
minScore?: number;
};
retrieval?: RetrievalConfig;
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

export interface MnemocyteClient {
remember(input: RememberInput): Promise<Memory>;
rememberMany(inputs: RememberInput[]): Promise<Memory[]>;
recall(input: RecallInput): Promise<MemoryWithScore[]>;
forget(input: { entityId: string; memoryId: string }): Promise<void>;
forgetAll(input: { entityId: string }): Promise<void>;
stats(input?: { entityId?: string }): Promise<EntityStats | GlobalStats>;
close(): Promise<void>;
}
```

Do not expose `$db` or `$config` as stable public API. If an escape hatch becomes necessary, expose it under an explicitly unstable namespace.

## Error Model

Use typed errors so consumers can recover from expected failures.

```ts
export class MnemocyteError extends Error {
constructor(
message: string,
readonly code: "CONFIG" | "VALIDATION" | "DB" | "EMBEDDING" | "NOT_FOUND" | "MIGRATION",
readonly cause?: unknown,
) {
super(message);
this.name = "MnemocyteError";
}
}
```

## Database Architecture

Postgres is the source of truth. pgvector is used for vector similarity search. Migrations are first-class and must be explicit; the main client constructor must not silently create extensions or tables.

### Schema Baseline

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE mnemocyte_memories (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  content text NOT NULL,
  type text NOT NULL DEFAULT 'fact',
  importance text NOT NULL DEFAULT 'normal',
  tags text[] NOT NULL DEFAULT '{}',
  source text,
  metadata jsonb NOT NULL DEFAULT '{}',
  confidence real NOT NULL DEFAULT 1.0,
  embedding vector(1536),
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  superseded_by text REFERENCES mnemocyte_memories(id),
  superseded_at timestamptz,
  expires_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mnemocyte_events (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  timestamp timestamptz NOT NULL DEFAULT now()
);
```

### Index Baseline

```sql
CREATE INDEX mnemocyte_memories_entity_idx ON mnemocyte_memories (entity_id);
CREATE INDEX mnemocyte_memories_entity_type_idx ON mnemocyte_memories (entity_id, type);
CREATE INDEX mnemocyte_events_entity_time_idx ON mnemocyte_events (entity_id, timestamp DESC);
CREATE INDEX mnemocyte_memories_fts_idx ON mnemocyte_memories USING gin (to_tsvector('english', content));
CREATE INDEX mnemocyte_memories_embedding_hnsw_idx ON mnemocyte_memories USING hnsw (embedding vector_cosine_ops);
```

HNSW is the preferred production default when build time and memory are acceptable. IVFFlat is also valid, but it needs workload-specific tuning and should be created after the table has representative data.

### Embedding Dimension Policy

The MVP supports one embedding dimension per installation. Store `embedding_model` and `embedding_dimensions` on every memory so mismatches are detectable and future migrations are possible.

Supporting multiple embedding dimensions in one database should be treated as a later production feature, likely through separate columns, tables, or partitions.

## Write Path

MVP write flow:

1. Validate input.
2. Embed content.
3. Verify embedding count and dimension.
4. Insert the complete memory row.
5. Return the stored memory.

Do not hold a database transaction open while calling an external embedding API. If asynchronous embedding is needed later, model it explicitly with an `embedding_status` field and retry/repair tooling.

## Retrieval Architecture

Retrieval uses a shared canonical filter object so vector and lexical paths cannot diverge.

```ts
export interface MemoryFilter {
entityId: string;
types?: MemoryType[];
tags?: string[];
before?: Date;
after?: Date;
includeSuperseded?: boolean;
includeExpired?: boolean;
}
```

### Vector Search

Use cosine distance with pgvector:

```sql
SELECT *, 1 - (embedding <=> $1::vector) AS vector_score
FROM mnemocyte_memories
WHERE entity_id = $2 AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

### Lexical Search

Use PostgreSQL full-text search for lexical retrieval. Do not call this BM25; PostgreSQL `ts_rank` is useful, but it is not BM25.

```sql
SELECT *,
  ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) AS lexical_score
FROM mnemocyte_memories
WHERE entity_id = $2
  AND to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)
ORDER BY lexical_score DESC
LIMIT $3;
```

### Score Fusion

Fusion combines vector, lexical, recency, importance, confidence, and access-count signals. Weights are configurable through `MnemocyteConfig.retrieval`, and detailed explanations are only returned when requested.

## Context Builder

The context builder assembles model-ready memory context. It must treat memory content as untrusted input.

Requirements:

- Escape XML output.
- Safely delimit Markdown/plain output.
- Support a default heuristic token counter.
- Allow callers to provide a model-specific token counter.
- Trim deterministically by priority and token budget.

```ts
export interface TokenCounter {
count(text: string): number;
}
```

## Connection Lifecycle

The client owns the postgres.js connection when it creates it from `databaseUrl`, so it must expose `close()`.

Later, support caller-managed database clients for apps that already own pools.

## Production Concerns

Before a production release, add:

- migration documentation
- integration tests against Postgres + pgvector
- package export smoke tests
- CI across supported Node versions
- provider timeouts and abort signals
- retry/rate-limit handling for embedding providers
- observability hooks
- typed errors
- safe deletion and pruning policy
- retrieval evaluation fixtures
- npm provenance or trusted publishing workflow

## Implementation Roadmap

### Phase 0 — Package Truthfulness

- Keep package exports aligned with shipped files.
- Keep README explicit about current stub status.
- Keep this architecture document canonical.
- Run `pnpm checktypes` and `pnpm pack --dry-run` before publishing.

### Phase 1 — MVP API

- Implement public types.
- Implement object-parameter `remember`, `rememberMany`, `recall`, `forget`, `forgetAll`, `stats`, and `close`.
- Support custom embedder first.
- Add typed errors and validation.
- Add unit and type tests.

### Phase 2 — Postgres Persistence

- Add Drizzle schema. ✅
- Add explicit migrations. ✅
- Add postgres.js connection lifecycle. ✅
- Add pgvector-backed vector recall query helpers. ✅
- Wire the public client to Postgres persistence. ✅
- Add integration tests. ✅

### Phase 3 — Retrieval Quality

- Add PostgreSQL full-text lexical retrieval. ✅
- Add score fusion and optional explanations. ✅
- Add recency, confidence, and access-count signals. ✅
- Add retrieval quality fixtures and benchmarks. ✅

### Phase 4 — Context Builder

- Add markdown/plain/XML formatting. ✅
- Add XML escaping and safe untrusted-content boundaries. ✅
- Add pluggable token counter. ✅
- Add deterministic token-budget trimming. ✅

### Phase 5 — Production Hardening

- Add provider retries, timeouts, and abort signals.
- Add observability hooks.
- Add pruning policies.
- Add release CI with provenance or trusted publishing.
- Add Node compatibility matrix.

### Phase 6 — Experimental Maintenance

- Add consolidation only under an experimental namespace.
- Add conflict detection and deduplication.
- Add audit logs for merges and deletes.
- Add MCP/adapters after the core package is stable.

## Issue Checklist

- [ ] Fix exports whenever build outputs change.
- [ ] Keep package ESM-only until CJS is emitted and tested.
- [ ] Implement object-parameter public API.
- [x] Add explicit migrations and document setup.
- [ ] Store embedding model and dimensions.
- [ ] Add client `close()`.
- [x] Apply one canonical retrieval filter to all retrieval paths.
- [ ] Use `lexical` / `fts` terminology instead of BM25 for `ts_rank`.
- [ ] Add typed errors.
- [x] Keep `client.ts` as a thin backend wiring layer.
- [ ] Add package export smoke tests.
- [x] Add Postgres + pgvector integration tests.
- [x] Add safe context formatting and token counting.
- [ ] Keep consolidation out of stable API until implemented.
