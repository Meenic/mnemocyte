# Architecture

The target design for Mnemocyte 1.0 and the decisions behind it. Nothing here
describes current behavior: what is built today is in
[DEVELOPMENT.md](./DEVELOPMENT.md) and [features/](./features/). When an item
below lands, its section moves there in the same PR.

## Principles

- **Your database, your embedder.** Memory lives in the application's own
  database. There is no service and no API key of ours.
- **Zero runtime dependencies in the core.** Database clients, AI SDK and
  framework integrations are optional peers behind subpaths.
- **Framework-agnostic.** The core is plain TypeScript; integrations are thin
  layers over the same client.
- **Explicit infrastructure.** Schema changes are migrations the user runs;
  the client never creates schema as a side effect.
- **Scoped by default.** Every read and write names a scope; global
  operations need an explicit opt-in.
- **Correct under concurrency.** Writes are atomic, races fail with typed
  errors, and nothing holds a transaction across a network call.
- **Honest about backends.** Each backend declares what it does differently
  instead of pretending to be identical.

## Layers

```txt
application
  └─ client (createMemory)          core: validation, fusion, context, lifecycle
       ├─ Embedder                  core contract; fetch-based or AI SDK adapters
       └─ MemoryStore (backend)     dialect SQL, schema, migrations, capabilities
            └─ SqlExecutor (driver) the user's own client: postgres.js, pg,
                                    Drizzle, PGlite, libSQL…
```

**Driver.** The user passes the client they already own; Mnemocyte never
creates or closes it:

```ts
interface SqlExecutor {
  query<Row>(sql: string, params: readonly unknown[], options?: { signal?: AbortSignal }): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
```

Adapters: `postgresJs(sql)`, `nodePg(pool)`, `drizzle(db)` (unwraps the
underlying client), `pglite(db)`, later `libsql(client)`. Each is a few dozen
lines and peer-depends on its driver. We write our own interface instead of
using Kysely: it is two methods, adds no dependency, and a query builder does
not help with vector or full-text SQL, which is where dialects differ.

**Backend (`MemoryStore`).** Owns its dialect's SQL, its migrations and a
capability declaration. The contract shrinks from 18 methods to about ten:
`insert`, `searchCandidates` (vector + lexical in one call), `get`, `list`,
`update`, `delete` (by scope and filter, atomic with the survivor policy),
`consolidate`, `appendAudit`, `listAudit`, `stats`, plus `migrate` and
`capabilities`. It stays internal until after 1.0.

**Capabilities.** Declared data, not feature flags:

```ts
interface StoreCapabilities {
  vectorSearch: "exact" | "approximate";
  filteredVectorSearch: "prefilter" | "postfilter" | "iterative";
  lexicalSearch: "bm25" | "ts_rank" | "none";
  locking: "row" | "database";
  maxDimensions: number;
}
```

The core uses them to choose fusion inputs (no lexical list when `none`) and
to warn; the shared contract tests use them to set expectations. Core logic
does not branch on them otherwise.

## Data model

A memory belongs to a **scope**:

```ts
interface MemoryScope {
  namespace: string;   // tenant or app; required
  entityId: string;    // who or what the memory is about
  agentId?: string;    // open decision, see below
  sessionId?: string;  // short-lived context
}
```

Scope columns are indexed together. Searching at a scope matches that scope
and, for optional fields, rows where the field is null (shared memories),
unless the query asks for an exact match. `deleteScope({ namespace, entityId
})` removes everything about an entity across agents and sessions in one
statement, which is what an erasure request needs.

Other fields carry over: `content`, `kind` (today's `type`), `importance`,
`tags`, `source`, `metadata` (JSON), `confidence`, `expiresAt`,
`supersededBy`/`supersededAt`, timestamps. New: an optional `key` for
idempotent upserts (`add` with an existing key updates in place). Ids become
UUIDs (`crypto.randomUUID()`, or `uuidv7()` in Postgres 18). `updatedAt`
changes only on writes.

## Write path

1. Validate and snapshot input (size caps on content, tags, metadata).
2. Embed outside any transaction, as documents, chunked to the embedder's
   `maxBatch`.
3. Insert in one transaction per batch, chunked under the driver's
   bind-parameter limit.
4. Audit events for the batch in the same transaction when audit is on.

## Recall

1. Embed the query as a query.
2. One `searchCandidates` call returns two ranked lists: vector (k nearest)
   and lexical (full-text), each with the same scope and filters.
3. **Reciprocal rank fusion (RRF)**: `score = Σ 1 / (k + rank)` over the lists
   a memory appears in, with `k = 60`. RRF uses positions, not raw scores, so
   `ts_rank`, BM25 and cosine never have to share a scale, and backends with
   different scoring still fuse the same way.
4. Small, configurable boosts for recency and importance, then `limit`.
5. Access tracking is opt-in, runs after the response is ready, ignores rows
   that disappeared, and never touches `updatedAt`.

Postgres specifics: the vector query runs in a transaction with
`SET LOCAL hnsw.iterative_scan = strict_order` and `hnsw.ef_search` at least
the candidate count, so filters cannot silently empty the result
(pgvector 0.8+). Full-text uses a generated `tsvector` column with a GIN
index.

## Context

`context({ scope, query, maxTokens, format })` keeps today's formats and the
hard token-budget guarantee. The query is no longer echoed into the output.

## Maintenance

- `prune` requires a scope or `allNamespaces: true`.
- Deleting a consolidation survivor is allowed when its dependents are
  deleted in the same call; `delete` of a lone survivor repoints dependents to
  null or rejects, chosen per call.
- `findDuplicates` uses a per-row k-nearest-neighbour query instead of a full
  self-join.
- `consolidate` graduates from `experimental` with its current locking
  design.
- Audit events get a retention option.

## Migrations

`await migrate({ store })` applies pending migrations from the backend:
a tracking table, an advisory lock so two app instances cannot migrate at
once, one transaction per migration, and the dimension and vector type
(`vector` up to 2,000 dimensions, `halfvec` up to 4,000) fixed at install.
The same SQL ships as plain files for teams that run migrations with `psql`
or `drizzle-kit`.

## Embedders

```ts
interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch?: number;
  embed(texts: readonly string[], options: { purpose: "query" | "document"; signal?: AbortSignal }): Promise<number[][]>;
}
```

`purpose` maps to each provider's asymmetric mode (Voyage `input_type`,
Cohere `input_type`, Google `taskType`); retrieval quality depends on it.
Shipped embedders are fetch-only: `openaiCompatible` (OpenAI, Mistral, local
servers with an OpenAI-shaped `/embeddings`), then Voyage, Cohere and Google.
Retries add jitter and honor `Retry-After`; provider error bodies are kept as
the `cause`.

## AI SDK integration

`mnemocyte/ai-sdk`, with `ai` as an optional peer dependency:

1. `aiSdkEmbedder(model)`: any AI SDK embedding model as an `Embedder`,
   through `embedMany`.
2. `memoryTools({ memory, scope })`: `searchMemories`, `saveMemory`,
   `forgetMemory` built with `tool()`. The scope is bound on the server when
   the tools are created; the model never supplies `entityId`, so a prompt
   injection cannot reach another user's memories.
3. `memoryMiddleware({ memory, scope })`: a language model middleware for
   `wrapLanguageModel` whose `transformParams` adds `context()` output to the
   prompt. Saving after a response is an opt-in hook the app controls; the
   library makes no hidden LLM calls.

Hosted alternatives (mem0's provider, Supermemory's tools) do the same jobs
through their own APIs; ours run against the app's database.

## Backends

| Backend | Vector | Full-text | Filtering with vectors |
|---|---|---|---|
| Postgres + pgvector | HNSW (approximate) | `ts_rank` | post-filter; iterative scans fix it |
| PGlite + pgvector | same as Postgres | same | same |
| libSQL / Turso | DiskANN via `vector_top_k` (approximate) | FTS5 `bm25` | join after `vector_top_k`; can return fewer than k |
| SQLite + sqlite-vec | `vec0`, brute force | FTS5 `bm25` | partition keys pre-filter |

Where hybrid results will differ between backends even with RRF:

- Different lexical candidates: Postgres `english` stemming and stop words
  versus FTS5 tokenizers (`unicode61`, optional `porter`); FTS5 needs user
  terms quoted.
- Different approximate neighbours (HNSW versus DiskANN versus exact).
- Different filtering stage, which changes how many candidates survive.

Shared contract tests therefore assert that expected memories appear in the
top k, never an exact order.

## Packaging

One package, `mnemocyte`, with subpaths: `mnemocyte` (core),
`mnemocyte/postgres` (backend and driver adapters), `mnemocyte/embedders/*`,
`mnemocyte/ai-sdk`. Drivers and `ai` are optional peer dependencies.

## Decisions

Dated 2026-10-26 unless noted.

1. **Packaging:** one package with subpaths until the backend contract is
   public or a second database backend lands; then split into a pnpm
   monorepo (`@mnemocyte/postgres`, …). Before that, separate packages would
   need exact version pins on each other and release machinery that does not
   exist yet.
2. **Backend order:** Postgres (postgres.js, Drizzle, PGlite, node-postgres)
   → 1.0 → libSQL → SQLite + sqlite-vec when it reaches a stable release
   (0.1.x alpha today) → others.
3. **1.0 covers:** core, Postgres with the four drivers, `migrate()`, the
   OpenAI-compatible and AI SDK embedders, and AI SDK memory tools. The semver
   promise covers the user-facing API; `MemoryStore` stays internal.
4. **Database access:** our own two-method `SqlExecutor`, not Kysely.
5. **Drizzle:** an optional driver adapter, not a runtime dependency.
6. **Scope:** `namespace` + `entityId` + optional `sessionId` as indexed
   columns. `agentId` is open (below).
7. **Fusion:** RRF over vector and lexical ranks, with small recency and
   importance boosts.
8. **Access tracking:** opt-in and fire-and-forget.
9. **Migrations:** an exported `migrate()` runner; the SQL files keep
   shipping.
10. **Embedders:** OpenAI-compatible and AI SDK in 1.0; Voyage, Cohere and
    Google in 1.x as demand shows.
11. **AI SDK saving:** an opt-in hook only for 1.0; no LLM extraction in the
    library. Extraction with the user's own AI SDK model is planned after
    1.0.
12. **In-memory backend:** kept, small, for a zero-dependency quick start.
    The shared contract tests run on PGlite and real Postgres.
13. **Minimum Node:** 22.18 until Node 22 reaches end of life (2027-04-30).
14. **Integration testing:** a Postgres + pgvector service container in CI
    for Postgres 17 and 18, plus PGlite for fast local runs.
15. **Releases:** manual `pnpm version`, then a tag-triggered GitHub Actions
    workflow publishes with provenance. Changesets only once there are
    several packages.

### Open: `agentId`

Question: should a memory carry an `agentId` next to `entityId`, for "a
memory about user Y held by agent X"?

Recommendation: **yes, as a nullable column in the first scope migration.**

- `entityId` is who the memory is about; `agentId` is who holds it. Null
  means shared by every agent.
- Search at `{ entityId, agentId: "x" }` returns x's memories plus shared
  ones; `exactAgent: true` returns only x's.
- `deleteScope({ namespace, entityId })` still erases the user across all
  agents, which is impossible if the agent is folded into `entityId` (for
  example `"x:user_y"`).
- Adding the column now costs one nullable column and a wider index. Adding
  it after 1.0 means a migration on every installation and a breaking change
  to the scope type.

Without it, apps that run several agents must either share every memory
between agents or encode the agent in `entityId` and lose cross-agent
erasure and per-user views.
