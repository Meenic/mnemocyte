# Mnemocyte Architecture

> This is the canonical architecture document for Mnemocyte. It describes the
> current package, the infrastructure boundaries it relies on, and the planned
> path toward adapter-based TypeScript infrastructure.

## Current Status

Mnemocyte currently exposes its public API through `createMnemocyte()`. The
client supports an in-memory backend when `databaseUrl` is omitted and a
Postgres/pgvector backend when `databaseUrl` is provided.

The package is ESM-only for now. CommonJS is intentionally not advertised unless the build later emits and tests a real CJS artifact.

The current package is intentionally explicit: callers supply the embedder, the
Postgres schema is applied through migrations, and the client does not hide
infrastructure setup behind constructor side effects.

## Goals

- **Maintainability:** each module has one responsibility and clear boundaries.
- **TypeScript-first DX:** public types are exported from `mnemocyte` and APIs are easy to evolve before v1.
- **Composable infrastructure:** callers should be able to bring their own
  embedder, database client, connection lifecycle, and runtime-specific
  adapters.
- **Minimal core:** Postgres with pgvector is the first persistence and vector
  search backend, not a mandate to adopt a separate vector database or agent
  framework.
- **Realistic agent memory:** prioritize reliable recall, provenance, lifecycle, and debuggability over speculative intelligence.
- **Package correctness:** npm metadata, exports, build output, and docs must match what is actually shipped.

## Non-Goals

- No separate vector database requirement in the core package.
- No stable CommonJS export until CJS output is produced and tested.
- No hidden schema creation from the client constructor.
- No unimplemented methods in the stable public API.
- No full autonomous memory consolidation in the core package.
- No provider lock-in. Official embedder factories are convenience adapters,
  not the only supported path.
- No broad backend expansion before a `MemoryStore` abstraction exists.

## Package Strategy

Mnemocyte remains ESM-only until there is a strong reason to dual-publish. The package ships:

- `dist/` — built root and subpath `.mjs` / `.d.mts` files (and source maps) produced by `tsdown`.
- `migrations/0000_initial.sql` — the only supported way to provision the Postgres schema.

The full, canonical `package.json` lives at the repository root. See it for the current `scripts`, `exports`, `engines.node`, and dependency pins (Drizzle ORM, `postgres`, `@biomejs/biome`, `tsdown`, Vitest, etc.). CI runs `test:ci` to enforce unit behavior, package exports, and exported type reachability from `mnemocyte`.

Future adapter packages should depend on the core rather than widening the core
surface. After the current `openaiEmbedder()` helper, the planned order is
configurable dimensions, `MemoryStore`, `drizzleStore(db)`, and then
`@mnemocyte/mcp`.

If CommonJS support is added later, the package must emit `dist/index.cjs` and CI must validate both `import("mnemocyte")` and `require("mnemocyte")`.

## Runtime Dependencies

Use `postgres` for the database driver. In this document, `postgres` means the postgres.js npm package, not PostgreSQL itself.

```json
{
  "dependencies": {
    "drizzle-orm": "^0.45.2",
    "postgres": "^3.4.9"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.15",
    "@types/node": "^25.9.0",
    "drizzle-kit": "^0.31.10",
    "tsdown": "^0.22.0",
    "typescript": "^6.0.3",
    "vitest": "4.1.6"
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
├── index.ts                  # public API re-exports only
├── client.ts                 # createMnemocyte() factory + Postgres dim validation
├── types.ts                  # public types
├── errors.ts                 # MnemocyteError + isMnemocyteError
├── observability.ts          # observe() helper that emits start/success/error events
├── resilience.ts             # withResilience helper (timeout + retry + abort)
│
├── db/
│   ├── index.ts              # postgres.js + drizzle setup (createDatabase)
│   ├── schema.ts             # drizzle table definitions (memories + events)
│   └── queries/
│       ├── memories.ts       # memory CRUD, recall, prune, dedup, consolidate SQL
│       └── events.ts         # audit-event CRUD
│
├── retrieval/
│   ├── index.ts              # hybridRecall orchestration
│   └── scorer.ts             # cosineSimilarity, lexical score, fused ranker
│
├── memory/
│   ├── shared.ts             # validation, mapping, embedding helpers (single + batch)
│   ├── in-memory.ts          # in-memory backend (with audit log array)
│   └── postgres.ts           # Postgres-backed backend
│
└── context/
    ├── builder.ts            # buildContext()
    ├── formatter.ts          # safe markdown/plain/xml formatting
    └── tokens.ts             # token counting abstraction
```

Embedder providers are deliberately represented by a small `Embedder`
interface. Callers pass an implementation explicitly. Official factories such
as `openaiEmbedder()` should remove boilerplate while preserving the same
contract. Additional provider integrations should stay in subpaths or adapter
packages rather than becoming hidden behavior in `createMnemocyte()`. The root
`mnemocyte` entrypoint must not import provider SDKs. `openaiEmbedder()` uses
`fetch` directly for the embeddings endpoint so no OpenAI SDK dependency is
required.

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

## Public Surface (0.1.x)

The source of truth is `dist/index.d.mts` plus any exported subpath declaration
files such as `dist/embedders/openai.d.mts`; this section is a fast index.

**Factory**
- `createMnemocyte(config: MnemocyteConfig): MnemocyteClient` — stable.

**Embedder helpers**
- `mnemocyte/embedders/openai`: `openaiEmbedder(options)` and
  `OpenAIEmbedderOptions`. This helper uses direct `fetch` calls and does not
  add an OpenAI SDK dependency.

**Errors**
- `MnemocyteError`, `isMnemocyteError`, `MnemocyteErrorCode` (`"CONFIG"`, `"VALIDATION"`, `"DB"`, `"EMBEDDING"`, `"NOT_FOUND"`, `"MIGRATION"`, `"TIMEOUT"`, `"ABORTED"`).

**Client (stable)**
- `remember(input)` / `rememberMany(inputs)`
- `recall(input)` — hybrid vector + lexical, with `RetrievalExplanation` when `explain: true`.
- `buildContext(input)` — markdown / plain / xml with token-budget trimming.
- `forget({ entityId, memoryId })`, `forgetAll({ entityId })`
- `prune(input: PruneInput)` — bulk-delete by `entityId` / `expired` / `superseded` / `createdBefore` / `notAccessedSince` / `types` / `tags` / `maxImportance` with `dryRun`.
- `findDuplicates(input)` — read-only pairwise scan returning `DuplicatePair[]`.
- `listAuditLog(input)` — newest-first, entity-scoped, with `before` / `after` / `limit`.
- `stats(input?)` — `EntityStats` or `GlobalStats`.
- `close()` — idempotent; further calls throw `"DB"`.

**Client (experimental, gated under `client.experimental.*`)**
- `experimental.consolidate(input)` — mark one or more memories as superseded by a survivor, with optional tag merge, idempotent for already-superseded losers, audited as `"memory.superseded"`.

**Config**
- `MnemocyteConfig`: `databaseUrl?`, `embedder` (required, must be 1536-d for Postgres), `defaults?`, `retrieval?`, `observability?`, `provider?` (resilience), `audit?` (`{ enabled }`).

**Types**
- `Memory` (canonical record, includes `supersededBy` and `supersededAt`), `MemoryWithScore`, `RetrievalScores`, `RetrievalExplanation`, `EntityStats`, `GlobalStats`.
- Input types: `RememberInput`, `RecallInput`, `BuildContextInput`, `PruneInput`, `FindDuplicatesInput`, `ListAuditLogInput`, `ConsolidateInput`.
- Result types: `PruneResult`, `ConsolidateResult`.
- Observability: `MnemocyteObservation`, `MnemocyteOperation`, `MnemocyteObservationPhase`, `MnemocyteBackend`, `ObservabilityConfig`.
- Resilience: `ProviderResilienceConfig`.
- Audit: `AuditConfig`, `AuditEvent`.

**Escape hatches**
- None. Internal helpers (`useDatabase`, `schema`, query builders) are not re-exported. If an unstable hatch is ever needed, expose it under `client.experimental.*`, never as a top-level export.

## Error Model

Use typed errors so consumers can recover from expected failures.

```ts
export class MnemocyteError extends Error {
constructor(
message: string,
readonly code:
| "CONFIG"
| "VALIDATION"
| "DB"
| "EMBEDDING"
| "NOT_FOUND"
| "MIGRATION"
| "TIMEOUT"
| "ABORTED",
readonly cause?: unknown,
) {
super(message);
this.name = "MnemocyteError";
}
}
```

`"TIMEOUT"` and `"ABORTED"` are emitted by the resilience layer; `"CONFIG"` covers both invalid embedder configuration and the Postgres-backend dimensionality check; `"VALIDATION"` covers per-call argument errors (including the explicit guard in `prune({})` and `consolidate({ supersededIds: [] })`).

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
CREATE INDEX mnemocyte_events_entity_time_idx ON mnemocyte_events (entity_id, timestamp);
CREATE INDEX mnemocyte_memories_embedding_hnsw_idx ON mnemocyte_memories USING hnsw (embedding vector_cosine_ops);
```

HNSW is the current bundled vector-search index. pgvector HNSW is approximate,
so production users should benchmark recall quality for their own corpus and
queries instead of treating top-K results as exact. HNSW also has operational
costs: index builds can use significant memory, and each write must update the
graph, increasing insert/update overhead compared with no vector index.
Postgres applies ordinary filters around vector search, so highly selective
`entity_id`, `type`, tag, time, or lifecycle filters may require query/session
tuning or a workload-specific migration.

IVFFlat is also valid for some large, steady-state tables, but it needs
representative data before index creation and workload-specific tuning. Do not
replace the bundled HNSW index blindly; benchmark HNSW, IVFFlat, and custom
filtered/partial indexes against real data volume, write rate, filters, and
latency targets.

The current migration does not include a full-text GIN expression index for
`to_tsvector('english', content)`. Lexical search is implemented with
PostgreSQL full-text search, but production deployments should add and benchmark
a matching expression index before relying on large lexical scans. Tag filters
currently use the `text[]` column without a bundled GIN index; add a tag index
only after measuring tag-heavy queries in the target workload.

### Embedding Dimension Policy

The current package supports one embedding dimension per installation. Store
`embedding_model` and `embedding_dimensions` on every memory so mismatches are
detectable and future migrations are possible.

`0.2.0` should add `mnemocyte_meta` as the installation-level source of truth
for the configured embedding dimension. Supporting multiple embedding
dimensions in one database should remain a later production feature, likely
through separate columns, tables, or partitions.

## Write Path

Current write flow:

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

Use cosine distance with pgvector. Recall queries should project only the
fields needed to build `Memory` plus the score; stored embeddings are used for
distance calculation but are not returned in the main candidate result set.

```sql
SELECT id, entity_id, content, type, importance, tags, source, metadata,
       confidence, embedding_model, embedding_dimensions, superseded_by,
       superseded_at, expires_at, last_accessed_at, access_count,
       created_at, updated_at,
       1 - (embedding <=> $1::vector) AS vector_score
FROM mnemocyte_memories
WHERE entity_id = $2 AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

### Lexical Search

Use PostgreSQL full-text search for lexical retrieval. Do not call this BM25;
PostgreSQL `ts_rank` is useful, but it is not BM25. Lexical candidate rows
also avoid returning embeddings; lexical-only candidates fetch embeddings
through a narrow `id, embedding` lookup when cosine rescoring needs them.

```sql
SELECT id, entity_id, content, type, importance, tags, source, metadata,
  confidence, embedding_model, embedding_dimensions, superseded_by,
  superseded_at, expires_at, last_accessed_at, access_count,
  created_at, updated_at,
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

The client owns the postgres.js connection when it creates it from `databaseUrl`, so it must expose `close()`. The current `createDatabase()` path uses postgres.js over TCP, parses common `sslmode` values, and disables prepared statements for pooler-style URLs (`:6543` or `pgbouncer=true`).

The planned `MemoryStore` and `drizzleStore(db)` milestones move
caller-managed database clients into the public architecture for apps that
already own pools or need runtime-specific Drizzle drivers.

## Production Concerns

Before a production release, add:

- migration documentation
- integration tests against Postgres + pgvector
- package export smoke tests ✅
- CI across supported Node versions ✅
- provider timeouts and abort signals
- retry/rate-limit handling for embedding providers
- observability hooks ✅
- typed errors ✅
- safe deletion and pruning policy
- retrieval evaluation fixtures
- full-text/search and filtered-vector index guidance
- npm provenance or trusted publishing workflow

## Implementation Roadmap

The historical MVP phases are complete enough to treat the current package as
the baseline. Future work is ordered around hardening first, then adapter-ready
storage boundaries.

### `0.1.x` - Maintenance

The planned hardening slice is complete for the `0.1.4` release. Future
`0.1.x` work should be limited to critical fixes or documentation corrections.

### `0.2.0` - Configurable Embedding Dimensions

- Add `mnemocyte_meta` with installation metadata such as
  `embedding_dimensions`.
- Parameterize the Postgres vector dimension instead of assuming
  `vector(1536)`.
- Validate the configured embedder against stored metadata on connect.
- Keep one vector dimension per installation.

### `0.3.0` - `MemoryStore`

- Extract storage primitives into a `MemoryStore` interface.
- Move shared orchestration into one core path.
- Reduce in-memory and Postgres backends to adapters.
- Defer any third backend until this boundary exists.

### `0.4.0` - `drizzleStore(db)`

- Let applications pass a caller-owned Drizzle database instance.
- Keep connection lifecycle ownership with the application.
- Verify and document supported Drizzle driver/runtime combinations before
  advertising them.

### `0.5.0` - `@mnemocyte/mcp`

- Ship MCP as a separate adapter package built on the same core primitives.
- Configure database and embedder explicitly.
- Expose memory tools only after the core storage and embedder contracts are
  stable enough to avoid a parallel implementation.

## Known limitations

- **Postgres embedding dimensionality is pinned to 1536.** The bundled migration creates `embedding vector(1536)`. `createMnemocyte` validates this up front and throws `MnemocyteError` code `"CONFIG"` before opening the connection pool, but the migration itself is not yet parameterized. `0.2.0` is planned to make this configurable with `mnemocyte_meta`.
- **`findDuplicates` on the in-memory backend is O(n²).** Acceptable for typical per-entity sizes; the Postgres backend uses a single pgvector self-join that scales better.
- **Hybrid recall on Postgres computes approximate lexical scores for vector-only candidates.** When a row appears only in the vector top-K, a JS-side substring-match lexical score is used instead of PostgreSQL's `ts_rank`. Similarly, lexical-only candidates get a JS-side cosine similarity from the stored embedding, fetched through a narrow follow-up lookup. These approximations are close but not identical to database-side scores. `candidateMultiplier` widens the candidate set to further reduce edge cases.
- **`forgetAll` does not cascade-delete the audit log** (intentional — the audit trail is sticky). Use `prune` against the `mnemocyte_events` table directly if you need to compact it.
- **`experimental.consolidate` is gated under `client.experimental.*`.** Members of that namespace may change between minor releases.

## Issue Checklist

- [x] Fix exports whenever build outputs change.
- [x] Keep package ESM-only until CJS is emitted and tested.
- [x] Implement object-parameter public API.
- [x] Add explicit migrations and document setup.
- [x] Store embedding model and dimensions.
- [x] Add client `close()`.
- [x] Apply one canonical retrieval filter to all retrieval paths.
- [x] Use `lexical` / `fts` terminology instead of BM25 for `ts_rank`.
- [x] Add typed errors.
- [x] Keep `client.ts` as a thin backend wiring layer.
- [x] Add package export smoke tests.
- [x] Add Postgres + pgvector integration tests.
- [x] Add safe context formatting and token counting.
- [x] Keep consolidation under `client.experimental.*` until it graduates.
