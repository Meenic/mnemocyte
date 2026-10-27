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
creates or closes it. The two-method `SqlExecutor` and the postgres.js adapter
have landed (see [features/postgres.md](./features/postgres.md)).

Adapters still to come: `nodePg(pool)`, `drizzle(db)` (unwraps the underlying
client), `pglite(db)`, later `libsql(client)`. Each is a few dozen lines and
peer-depends on its driver. We write our own interface instead of
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

The scope columns, `key` and UUID ids are in the schema (see
[features/postgres.md](./features/postgres.md#scope)); the public API still
takes only `entityId`. Searching at a scope matches that scope and, for
optional fields, rows where the field is null (shared memories), unless the
query asks for an exact match. `deleteScope({ namespace, entityId
})` removes everything about an entity across agents and sessions in one
statement, which is what an erasure request needs.

Other fields carry over: `content`, `kind` (today's `type`), `importance`,
`tags`, `source`, `metadata` (JSON), `confidence`, `expiresAt`,
`supersededBy`/`supersededAt`, timestamps. New: an optional `key` for
idempotent upserts (`add` with an existing key updates in place). `updatedAt`
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
3. Reciprocal rank fusion with recency and importance boosts, then `limit`.
   This has landed; see
   [features/retrieval.md](./features/retrieval.md#fusion-and-boosts).
4. Access tracking is opt-in, runs after the response is ready, ignores rows
   that disappeared, and never touches `updatedAt`. This has landed; see
   [features/retrieval.md](./features/retrieval.md#access-tracking).

Postgres specifics: the vector query runs in a transaction with
`SET LOCAL hnsw.iterative_scan = strict_order` and `hnsw.ef_search` at least
the candidate count, so filters cannot silently empty the result
(pgvector 0.8+).

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
6. **Scope:** `namespace` + `entityId` + optional `agentId` and `sessionId`
   as indexed columns (see 17).
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

16. **Atomic statements over interactive transactions** (2026-10-27): write
    paths are designed as single statements where possible. `transaction(fn)`
    holds a connection open across round trips, which stateless HTTP drivers
    (Neon HTTP, D1) cannot do. `SqlExecutor` keeps `transaction` for drivers
    that support it and gains an optional `batch` where one statement is not
    enough. Every write path is one statement today, `consolidate`
    included; chunked inserts in `fix/batch-writes` are the first that need
    `batch`.

17. **`agentId`** (2026-10-27): a nullable column next to `entityId`, added
    in the first scope migration (`0003`). `entityId` is who a memory is
    about, `agentId` who holds it; null means shared by every agent. Search
    at `{ entityId, agentId: "x" }` returns x's memories plus shared ones,
    and `exactAgent: true` only x's. `deleteScope({ namespace, entityId })`
    erases the user across all agents, which folding the agent into
    `entityId` would make impossible. Adding it after 1.0 would have meant a
    migration on every installation and a breaking scope type.
18. **UUIDv7 ids** (2026-10-27): generated in JavaScript, because Postgres
    has `uuidv7()` only from 18. Time-ordered ids keep primary-key inserts
    at the right edge of the btree; UUIDv4 would scatter them. Old text ids
    convert with `md5(id)::uuid` so applications can map stored ids.
19. **No `close()`** (2026-10-27): the client created by `createMemory` has
    no `close()`. Since `SqlExecutor` the caller owns the database client and
    Mnemocyte holds no connections or timers, so on Postgres `close()` closes
    nothing; like Drizzle, the client needs no shutdown call. Removed in
    `feat/scoped-api`, which already replaces `createMnemocyte`, so users take
    one breaking change instead of two. Until then `close()` stays and does
    not wait for access writes. Access writes are started before recall
    resolves, so the driver already has the statement when the caller ends
    their client. Lost writes on serverless platforms are acceptable for
    counts that do not affect ranking; an optional `waitUntil` hook can be
    added later if that changes.
