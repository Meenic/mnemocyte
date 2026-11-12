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
creates or closes it. This has landed: `SqlExecutor` (`query`, plus
`transaction` and/or `batch`), and `postgresStore({ client })` detecting
postgres.js, a node-postgres `Pool`, PGlite and Drizzle over them by shape
(decision 21); see
[features/postgres.md](./features/postgres.md#client-detection). libSQL
later gets its own store. We write our own interface instead of using
Kysely: it is two methods, adds no dependency, and a query builder does not
help with vector or full-text SQL, which is where dialects differ.

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

This has landed: scopes (`namespace`, `entityId`, optional `agentId` and
`sessionId`), keyed upserts, `get`, `list`, `update` and `deleteScope` are
described in [features/scopes.md](./features/scopes.md). Field names carry
over from 0.5 except `type`, now `kind`.

Still to come, bound scopes. Repeating `{ namespace, entityId }` on every
call is noise and lets a call drift to the wrong user:

```ts
const memory = createMemory({ namespace: "my-app", store, embedder });
const userMemory = memory.for({ entityId: user.id });

await userMemory.add({ content: "Prefers short, direct answers." });
const context = await userMemory.context({ query: userMessage });
```

- `namespace` on `createMemory` is a default; a scope that names its own
  namespace wins, so multi-tenant apps keep per-call namespaces.
- `memory.for(scope)` returns a client with the same methods, minus the
  `scope` field. `deleteScope()` on it erases the bound scope; `prune` and
  `stats` select within it. Operations that need `allNamespaces` exist only
  on the unbound client, so a bound client cannot reach past its scope.
- Methods keep a single object parameter. Positional forms such as
  `add("text")` are rejected: they make later options a breaking change.

## Write path

Size caps, chunked embedding outside any transaction and chunked inserts in
one transaction have landed (see
[features/postgres.md](./features/postgres.md#chunked-inserts) and
[features/embedders.md](./features/embedders.md)). Still to come:

- Embedding chunks follow the embedder's `maxBatch` and pass
  `purpose: "document"` (`feat/embedder-purpose`); today the chunk size is a
  fixed 100.
- Audit events in the same transaction (or statement) as the write they
  record, when audit is on. Today they are written best-effort after the
  write commits, for every write path (`fix/audit-atomic`).

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

Postgres specifics: the vector query uses pgvector 0.8 iterative index scans,
so filters cannot silently empty the result. This has landed; see
[features/postgres.md](./features/postgres.md#filtered-vector-search).

## Context

This has landed: `context({ scope, query, maxTokens, format })` keeps the
formats and the token-budget guarantee and no longer echoes the query; see
[features/retrieval.md](./features/retrieval.md#context).

## Maintenance

`prune` requiring a scope or `allNamespaces: true` has landed (see
[features/maintenance.md](./features/maintenance.md#prune)). Still to come:

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
2. `memoryTools({ memory })`: `searchMemories`, `saveMemory`,
   `forgetMemory` built with `tool()`, from a bound client
   (`memory.for(scope)`). The scope is bound on the server when the tools are
   created; the model never supplies `entityId`, so a prompt injection cannot
   reach another user's memories.
3. `memoryMiddleware({ memory })`: from a bound client, a language model
   middleware for `wrapLanguageModel` whose `transformParams` adds
   `context()` output to the prompt. Saving after a response is an opt-in hook the app controls; the
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

## Setup

Setup stays explicit (see decision 20): nothing is created when a client is
built, and every step that touches the schema is a call or command the user
runs.

The target flow is three steps: install, export `memory` from a
`memory.ts`, run `npx mnemocyte migrate`. No `migrate` call sits in app code.

- **`migrate` options.** Landed: `migrate({ memory })`, `createExtension`
  and `dryRun` are described in
  [features/postgres.md](./features/postgres.md#the-migrate-runner).
- **CLI.** A `mnemocyte` bin. It loads the app's own `memory.ts` from the
  project root, `lib/`, `src/` or `src/lib/` (or `--config <path>`) and
  uses its exported `memory`, so the CLI and the app share one client and
  one embedder. Node 22.18, the minimum, strips TypeScript types by default,
  so the file loads with `import()`; a `module.register` resolve hook adds
  the extensionless relative imports and tsconfig `paths` that type
  stripping does not resolve, without a loader dependency.
  - `migrate` applies what is missing. When pgvector is not enabled it asks
    before running `createExtension`, and on No prints the
    `CREATE EXTENSION` line for an admin; `--yes` answers for CI and
    `--dry-run` maps to `dryRun`.
  - `check` reports the pgvector version (0.8.0 or later is required), the
    applied migrations and the installed dimensions, and exits non-zero on
    a problem.
  - `sql` prints the fresh-install schema without a database.
  - Without a memory file, `--dimensions <n>` and `DATABASE_URL` with the
    optional `postgres` peer; without the peer the CLI exits with an
    install hint. Arguments are parsed with `node:util` `parseArgs`.
  - PGlite opens its data folder from one process at a time, so the CLI
    cannot migrate it while the app runs; PGlite users call
    `migrate({ memory })` from code instead.
- **Getting started.** One guide from an empty folder to a first `context()`
  call: install, `.env`, `memory.ts` with a tab per driver, `npx mnemocyte
  migrate`, a bound scope. Docker on the CI image for a local Postgres, and
  the in-memory backend for prototypes.

After 1.0:

- **Drizzle schema export.** `mnemocyte generate --adapter drizzle` writes
  the tables as a Drizzle schema the user adds to `drizzle.config.ts`, so
  `drizzle-kit` owns the migrations. `migrate` already adopts a schema
  installed outside it; the open question is keeping a generated schema in
  step with later Mnemocyte migrations.
- **`schemaName`.** Tables in a schema other than `public`. Every query and
  migration needs schema-qualified names, and the tracking table moves with
  them.

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
4. **Database access:** our own small `SqlExecutor`, not Kysely.
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
    `batch`. (2026-11-12) The recall vector search is a read that needs two
    statements in one transaction (`set_config`, then the query); it uses
    `transaction` until `batch` exists, then moves to it. (2026-11-12,
    landed) `batch(statements)` runs statements in order in one transaction
    and returns one rows array per statement; `transaction` became
    optional, an executor needs at least one of the two, and stores prefer
    `batch`. `addMany` is all or nothing: every embedder call finishes
    first, then all insert chunks commit together. (2026-11-12) On
    postgres.js 4.1+ the adapter's `batch` is `sql.batch`, one round trip
    whose single Sync makes it one implicit transaction, instead of
    pipelining inside `sql.begin` (`BEGIN`, the statements, `COMMIT`).
    Inside a transaction it keeps the savepoint, because a failed
    `sql.batch` there aborts the outer transaction; 3.x and 4.0 keep
    `sql.begin`.

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
    `feat/scoped-api` together with `createMnemocyte`, so users take one
    breaking change instead of two. Access writes are started before search
    resolves, so the driver already has the statement when the caller ends
    their client. Lost writes on serverless platforms are acceptable for
    counts that do not affect ranking; an optional `waitUntil` hook can be
    added later if that changes.
20. **Explicit setup, no runtime migrations** (2026-11-12): pg-boss and
    Graphile Worker migrate on start by default; Better Auth checks the
    schema at first use and creates it only through its CLI or
    `getMigrations`. We follow Better Auth: the client stays free of schema
    side effects (missing tables already surface as `"MIGRATION"` errors),
    and setup gets shorter through `migrate` options and a CLI instead.
    Migrating on start would fail under a restricted runtime role and make
    every schema change an implicit part of starting the app. Like Better
    Auth's `auth.ts`, the CLI loads the app's own `memory.ts`, to reuse its
    client and embedder; there is no separate config format.
21. **Clients detected by shape** (2026-11-12): `postgresStore(client)`
    takes postgres.js, `pg`, Drizzle and PGlite clients directly instead of
    through `nodePg()`, `pglite()` and similar wrappers, as Better Auth's
    `database: new Pool(...)` does. Setup code then names one thing, the
    client the app already has. Detection reads properties only and imports
    no driver, so the core keeps zero dependencies; checks run in a fixed
    order, and an unrecognised object is a `"CONFIG"` error that points to
    `SqlExecutor`. (2026-11-12, landed) The order is postgres.js, Drizzle
    (`$client`), PGlite, `pg` Pool, then `SqlExecutor`, which must come last
    because PGlite has its shape. A `pg.Client` is rejected: a transaction
    needs a connection of its own, which only a pool hands out. The input
    stays `postgresStore({ client })`, keeping the single-object-parameter
    rule; `postgresJs()` and `drizzleStore()` stay, not deprecated. `pg` and
    `@electric-sql/pglite` became optional peers like `postgres` and
    `drizzle-orm`, and the contract suite runs on PGlite in `pnpm test`.
