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
(decision 21), and `createMemory({ store })` taking the client itself with
the same detection and a lazily imported backend, so `postgresStore` is
optional (decision 23); see
[features/postgres.md](./features/postgres.md#client-detection). libSQL
has landed with a store of its own on its own small adapter, taking an
`@libsql/client` client or Drizzle over one the same two ways (decision
62); see [features/libsql.md](./features/libsql.md#clients). We write our
own interface instead of using
Kysely: it is two methods, adds no dependency, and a query builder does not
help with vector or full-text SQL, which is where dialects differ.

**Backend (`MemoryStore`).** This has landed (decision 61): the contract
went from 22 methods to 16 and declares its `capabilities` as data; see
[DEVELOPMENT.md](./DEVELOPMENT.md#store-contract). libSQL, the first
backend whose values could have called for a warning, declares an exact
prefiltered search, so no warning reads capabilities (decision 63); the
shared contract sets its expectations from them (decision 65).

## Data model

This has landed: scopes (`namespace`, `entityId`, optional `agentId` and
`sessionId`), keyed upserts, `get`, `list`, `update`, `deleteScope`, the
default namespace and bound clients (`memory.for(scope)`, decision 22) are
described in [features/scopes.md](./features/scopes.md). Field names carry
over from 0.5 except `type`, now `kind`.

Methods keep a single object parameter, bound ones included. Positional
forms such as `add("text")` are rejected: they make later options a
breaking change.

## Write path

Size caps, chunked embedding outside any transaction (chunks follow the
embedder's `maxBatch` and pass `purpose: "document"`) and chunked inserts in
one transaction have landed (see
[features/postgres.md](./features/postgres.md#chunked-inserts) and
[features/embedders.md](./features/embedders.md)), and so have audit events
written in the same statement as the write they record (see
[features/maintenance.md](./features/maintenance.md#audit-log)).

## Recall

1. Embed the query as a query (`purpose: "query"`). This has landed; see
   [features/embedders.md](./features/embedders.md).
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

This has landed: `prune` requiring a scope or `allNamespaces: true`,
survivor-aware deletes and their `DeleteResult` (decision 45), the
k-nearest-neighbor `findDuplicates` and its
pages (`experimental.findDuplicatesPage`, decision 35),
`consolidate` on the stable client (decision 30), audit retention
through `pruneAuditLog` (decision 32) and one memory's audit history
through `listAuditLog({ memoryId })` (decision 49); see
[features/maintenance.md](./features/maintenance.md).

## Embedders

The contract with `purpose` and `maxBatch`, `openaiCompatibleEmbedder`,
`ProviderError` with the provider's body as `cause`, and status-based
retries with jitter and `Retry-After` have landed (decision 25), and so
have the AI SDK embedder, `aiSdkEmbedder`, and fetch-only Voyage, Cohere
and Gemini API embedders (decision 29), and `headers` on every HTTP
embedder (decision 43); see
[features/embedders.md](./features/embedders.md).

## AI SDK integration

`mnemocyte/ai-sdk`, with `ai` as an optional peer dependency, ships
`aiSdkEmbedder` (see
[features/embedders.md](./features/embedders.md#aisdkembedder)),
`memoryTools({ memory })` (decision 26), `memoryMiddleware` and
`withMemory` with an opt-in `save` hook (decision 27), and extraction with
the user's own model through `save: { model }` and `extractMemories`
(decisions 24 and 28) today; see [features/ai-sdk.md](./features/ai-sdk.md).

Hosted alternatives (mem0's provider, Supermemory's tools) do the same jobs
through their own APIs; ours run against the app's database.

## Memory intelligence

The target design for the work after the drivers queue (decision 90).
Mnemocyte stays a library in the app's own database. A step that needs a
language model runs on the app's own model through `mnemocyte/ai-sdk`,
only when the app calls it or turns it on, and no step needs a service
running beside the app, a queue or a graph database. The core keeps
working with an embedder alone. Each part except entities is an item in
[ROADMAP.md](./ROADMAP.md#memory-intelligence), where the choices left
to its PR are listed; entities wait in its Later list.

- **Evaluation first.** A private workspace package runs LongMemEval and
  LoCoMo through the real pipeline (extraction, `context`, a chat model
  answering from it), plus product cases: recall@k, superseded facts,
  scope isolation. It runs by hand, never in CI, and its results record
  the models, the judge and the retrieval settings, so anyone can repeat
  a run. Each item that changes what is saved or found names the number
  it should move.
- **Re-embedding.** A supported switch to another embedding model, of
  the same size or another: vectors written in batches outside any
  transaction, resumable, with search on the old model until the switch
  completes.
- **Superseding during extraction.** Extraction may name memories it was
  shown that a new fact replaces, and Mnemocyte supersedes them through
  `consolidate` in the exact bound scope, so a changed fact no longer
  sits next to the old one.
- **Profiles.** A short description of an entity that is always in the
  prompt: `context` renders it before the search results, and extraction
  and a memory tool keep it current.
- **Time.** When something happened (`occurredAt`), next to when it was
  stored (`createdAt`); filters on it, a search of what was current at a
  past date, and dates in `context` output so a model can answer "when"
  questions.
- **Metadata filters.** A small `where` on `metadata` (equality, `in`,
  existence, `and` / `or`) on every backend.
- **Reranking.** A `Reranker` contract next to `Embedder`: fetch-based
  rerankers and one over the AI SDK's `rerank()`, applied to the fused
  candidates before `limit`, plus maximal marginal relevance (MMR), which
  spreads results without a network call.
- **Decay.** A recency half-life per kind and an opt-in boost from
  `accessCount` and `lastAccessedAt`, inside the boost formula, so they
  still never lift a poor match.
- **Reflection.** Duplicate groups from `findDuplicates` merged into a
  survivor the app's model writes, with the merged memories kept as its
  evidence, run from a scheduled job.
- **Observation.** A long conversation compressed into dated `episode`
  memories from messages the app passes in. Mnemocyte stores no chat
  history.
- **Batched extraction.** Extraction every few turns, or past a token
  threshold, instead of after every response.
- **Write guards.** A hook that can change or reject a memory before it
  is embedded, with a built-in redactor for common secret formats.
- **Reach.** A local inspector, checked Edge and browser runtimes,
  framework adapters as optional-peer subpaths, a local embedder, and
  Claude Code hooks for `@mnemocyte/mcp`.
- **Entities (later).** Names extracted with facts, kept in a link
  table, with entity overlap as a third ranked list in the fusion. No
  graph traversal.

## Backends

| Backend | Vector | Full-text | Filtering with vectors |
|---|---|---|---|
| Postgres + pgvector | HNSW (approximate) | `ts_rank` | post-filter; iterative scans fix it |
| PGlite + pgvector | same as Postgres | same | same |
| libSQL / Turso | exact scan of the scope (`vector_distance_cos`), no index yet | FTS5 `bm25` | pre-filter: the scope index and filters select the rows the scan ranks |
| SQLite + sqlite-vec | `vec0`, brute force | FTS5 `bm25` | partition keys pre-filter |

The libSQL row has landed (decisions 62 to 70); see
[features/libsql.md](./features/libsql.md). A DiskANN index was planned
for it, but `vector_top_k` ranks the whole table before the filters
(decision 63).

Where hybrid results will differ between backends even with RRF:

- Different lexical candidates: Postgres `english` stemming and stop words,
  every query word required, versus FTS5 tokenizers (`porter` by default,
  or `unicode61`), any word matching, no stop words; FTS5 needs user terms
  quoted (decision 64).
- Different neighbours: approximate on HNSW, exact on libSQL and in
  memory.
- Different filtering stage, which changes how many candidates survive.

Shared contract tests therefore assert that expected memories appear in the
top k, never an exact order.

## Setup

Setup stays explicit (see decision 20): nothing is created when a client is
built, and every step that touches the schema is a call or command the user
runs.

The flow is three steps: install, export `memory` from a `memory.ts`, run
`npx mnemocyte migrate`. No `migrate` call sits in app code.

- **`migrate` options.** Landed: `migrate({ memory })`, `createExtension`
  and `dryRun` are described in
  [features/postgres.md](./features/postgres.md#the-migrate-runner).
- **CLI.** Landed: the `mnemocyte` bin with `init`, `migrate`, `check` and `sql`
  loads the app's own memory file, or connects to `DATABASE_URL` without
  one (decision 36); see [features/cli.md](./features/cli.md).
- **`init`.** Landed: `mnemocyte init` writes a `memory.ts` that imports
  the app's own Drizzle client when it finds one (decision 98), else one
  for the driver found in `package.json` (decision 37), in `src/lib/` or
  `lib/` with `import "server-only"` for a Next.js app, and adds
  `OPENAI_API_KEY=` to `.env.local` or `.env`; see
  [features/cli.md](./features/cli.md#init).
- **`--json`.** Landed: `check --json` and `migrate --dry-run --json`
  print one JSON result for CI (decision 47); see
  [features/cli.md](./features/cli.md#--json).
- **Missing-schema errors.** Landed: the `"MIGRATION"` error for a missing
  table or column names `mnemocyte migrate` and links the Postgres
  guide, as described in [features/postgres.md](./features/postgres.md#errors).
- **Getting started.** Landed as
  [guide/getting-started.md](./guide/getting-started.md), which creates the
  schema with `npx mnemocyte migrate`.
- **`schemaName`.** Landed (decision 51):
  `postgresStore({ client, schemaName })` keeps the tables, the tracking
  table included, in one schema; see
  [features/postgres.md](./features/postgres.md#schema-name).
- **Drizzle schema export.** Landed (decision 52):
  `mnemocyte generate --adapter drizzle` writes the tables as a Drizzle
  schema, and drizzle-kit owns their migrations from then on; see
  [features/cli.md](./features/cli.md#generate).

## Packaging

One package, `mnemocyte`, with subpaths: `mnemocyte` (core),
`mnemocyte/postgres` (backend and driver adapters), `mnemocyte/libsql`
(landed, decision 62), `mnemocyte/store` and `mnemocyte/store/test`
(landed, decisions 72 and 73), `mnemocyte/embedders/*`, `mnemocyte/ai-sdk`.
Drivers, `@libsql/client`, `ai` and `vitest` are optional peer
dependencies.

After 1.0 (decision 1, revised 2026-11-15), a package is split out only when
it needs dependencies of its own or its own release cadence:

- **Backends.** A first-party backend that runs on the user's own client, as
  Postgres does, ships as a subpath of `mnemocyte` (`mnemocyte/libsql`). If
  SQLite needs the `sqlite-vec` package as a dependency of ours, rather than
  the user loading the extension on their own connection, it becomes a
  package of its own. Drizzle and Kysely stay in `mnemocyte` for the same
  reason: the user brings the driver, and the drivers are optional peers.
- **The CLI.** The `mnemocyte` bin stays in `mnemocyte` (decision 92): it
  has no dependencies of its own and imports internal modules, so in one
  package the CLI, the migrations and the client are always one version.
  It moves out only if it needs dependencies, and then pins `mnemocyte`
  exactly, as `auth` pins `better-auth`.
- **The public store contract.** Landed (decisions 72 and 73):
  `MemoryStoreV1` at `mnemocyte/store` and the contract suite at
  `mnemocyte/store/test`; see DEVELOPMENT.md, "Store contract". Third-party
  backends are their own packages with `mnemocyte` as a peer (`^1`). A
  separate contract package, as `@ai-sdk/provider` is for the AI SDK,
  follows only if third-party backends become common.
- **`@mnemocyte/mcp`.** Landed (decisions 84 to 89): the first separate
  package, at `packages/mcp/`, with the MCP SDK and the `mnemocyte-mcp`
  bin, and `mnemocyte` as a peer (`^1.1.0`), the way `@mastra/pg` takes
  `@mastra/core`; it uses only the public API, so it needs no exact pins.
  See [features/mcp.md](./features/mcp.md). The memory file loader it
  shares with the CLI is the private workspace package
  `@mnemocyte/loader`, which tsdown bundles into both (decision 93;
  [DEVELOPMENT.md](./DEVELOPMENT.md#structure)).
- **A first-party split.** If first-party code ever splits
  (`@mnemocyte/core`, `@mnemocyte/postgres`), `mnemocyte` stays an umbrella
  package that depends on them with exact pins, releases with them, and
  re-exports every current import path (`mnemocyte`, `mnemocyte/postgres`,
  `mnemocyte/embedders/*`, `mnemocyte/ai-sdk`, the CLI), as `better-auth`
  does with `@better-auth/core` and its adapters. That keeps the split
  non-breaking, so it can ship in a 1.x minor. The raw-client shortcut
  (`createMemory({ store: sql })`) then lives in the umbrella; the core
  alone takes a `MemoryStore` such as `postgresStore({ client })`.

## Decisions

Dated 2026-10-26 unless noted.

1. **Packaging:** one package with subpaths until the backend contract is
   public or a second database backend lands; then split into a pnpm
   monorepo (`@mnemocyte/postgres`, …). Before that, separate packages would
   need exact version pins on each other and release machinery that does not
   exist yet.
   (2026-11-15, revised) A second backend no longer triggers a split. The
   Postgres backend has no dependencies of its own (the user brings the
   driver), and the lazy `import()` of decision 23 already keeps it out of
   in-memory bundles, so a split would remove no dependency and no bundled
   code. First-party backends that run on the user's client ship as
   subpaths; a package is split out only when it needs dependencies of its
   own or its own release cadence (`@mnemocyte/mcp` first, with `mnemocyte`
   as a peer). If first-party code ever splits, `mnemocyte` stays an
   umbrella that re-exports every current import path, so the split is
   non-breaking.
   (2026-11-23) Re-tested against drizzle-orm, Prisma, better-auth, the AI
   SDK, Mastra and turbomem in decision 92: the rule holds, and the CLI
   stays the package's bin.
   Details and the public `MemoryStore` plan are in "Packaging" above.
2. **Backend order:** Postgres (postgres.js, Drizzle, PGlite, node-postgres)
   → 1.0 → libSQL → SQLite + sqlite-vec when it reaches a stable release
   (0.1.x alpha today) → others.
3. **1.0 covers:** core, Postgres with the four drivers, `migrate()`, the
   OpenAI-compatible and AI SDK embedders, and AI SDK memory tools. The semver
   promise covers the user-facing API; `MemoryStore` stays internal.
   (2026-11-14, revised by 39) 1.0 covers the core client and the in-memory
   backend; Postgres with the four drivers, `postgresStore` and
   `SqlExecutor` as documented; `migrate()`; every embedder (OpenAI,
   OpenAI-compatible, Voyage, Cohere, Gemini and the AI SDK one); the AI
   SDK tools, middleware, `withMemory` and extraction; and the CLI's
   commands, flags and exit codes, but not its text.
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
    Google in 1.x as demand shows. (Voyage, Cohere and Google landed
    before 1.0; see 29.)
11. **AI SDK saving:** an opt-in hook only for 1.0; no LLM extraction in the
    library. Extraction with the user's own AI SDK model is planned after
    1.0. (Superseded by 24.)
12. **In-memory backend:** kept, small, for a zero-dependency quick start.
    The shared contract tests run on PGlite and real Postgres.
13. **Minimum Node:** 22.18 until Node 22 reaches end of life (2027-04-30).
14. **Integration testing:** a Postgres + pgvector service container in CI
    for Postgres 17 and 18, plus PGlite for fast local runs.
15. **Releases:** manual `pnpm version`, then a tag-triggered GitHub Actions
    workflow publishes with provenance. Changesets only once there are
    several packages. (Superseded by 99.)

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
    `sql.begin`. (2026-11-13, landed) Audit events join their write's
    statement as a data-modifying `WITH` step that reads the write's
    `RETURNING`, on every write path, instead of a second statement or a
    transaction: what an event says (created or updated, which ids a delete
    removed or restored, per-entity prune counts) is only known from the
    write, and a `batch` cannot pass one statement's result to the next.
    `addMany` puts each chunk's events in that chunk's statement, so they
    commit with the chunks. A failed audit insert fails the call on both
    backends; the in-memory store adds its events in the same synchronous
    step as the change.

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
    (2026-11-13) Audit events of a `delete` or `prune` are the exception:
    the statement does not know how many it writes, so it builds UUIDv7s
    in SQL from the event time and `gen_random_uuid()` (`sqlUuidV7` in
    `src/db/sql.ts`). Every other id is still generated in JavaScript.
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
    rule; `postgresJs()` and `drizzleStore()` stay, not deprecated
    (reversed by decision 38: both were removed for 1.0). `pg` and
    `@electric-sql/pglite` became optional peers like `postgres` and
    `drizzle-orm`, and the contract suite runs on PGlite in `pnpm test`.
22. **Bound scopes** (2026-11-13): `createMemory({ namespace })` is a
    default a scope may override, and `memory.for(scope)` returns a
    `BoundMemoryClient` whose methods take no `scope`. It ships on the
    stable client, not under `experimental`: the shape was settled here
    first, and the AI SDK tools and middleware take a bound client, so an
    experimental path would leak into their API. The default is typed with
    a `DefaultNamespace` type parameter (`createMemory` overloads return
    `MemoryClient<true>` when `namespace` is set) rather than by making
    `namespace` optional everywhere, so a missing namespace stays a
    compile error on clients without a default. A bound method rejects a
    `scope` or `allNamespaces` field from untyped code with
    `"VALIDATION"` instead of ignoring it. Narrowing a bound client further
    (`user.for({ sessionId })`) is left out; it can be added without a
    breaking change.
23. **Clients in `createMemory`** (2026-11-13): `createMemory({ store })`
    also takes a database client and runs decision 21's detection, so
    setup names one thing, as Better Auth's `database: new Pool()` does.
    This revisits 21's "the input stays `postgresStore({ client })`":
    `postgresStore` stays, and a store config from it is recognised before
    any client check. The Postgres backend loads lazily on first use with a
    dynamic `import()`, because a static import would put it in every
    in-memory user's bundle and top-level `await` would break `require()`;
    the PR measures both bundles to confirm the lazy load is worth it.
    (2026-11-13, landed) Measured with a Rolldown-bundled consumer: the
    lazy load keeps startup at 15.0 KB gzipped against 26.1 KB for a
    static import, and the backend chunk (12.5 KB) loads on the first
    call. Detection stays in the root entry, so an unrecognised client is
    still a synchronous `"CONFIG"`; `migrate({ store })` takes a client
    too; `MemoryConfig.store` is widened to
    `MnemocyteStoreConfig | PostgresClient` instead of new overloads. A
    failed import is not cached.
24. **Extraction in 1.0** (2026-11-13): supersedes 11. mem0, Mastra and
    Supermemory all save from the conversation without app code; with only
    a bare hook, every Mnemocyte app would write its own extraction. The AI
    SDK middleware gets an opt-in `save: { model }` that runs the user's
    own model after the response and writes into the bound scope. It stays
    off by default and makes no call unless configured, so the library
    still has no model or provider of its own. (2026-11-13, landed; see
    28.)
25. **Embedder purpose, batches and retries** (2026-11-13, landed):
    `embed(texts, { purpose, signal })` takes a required options object with
    `purpose: "query" | "document"`; the core passes `"document"` from
    `add`, `addMany` and `update` and `"query"` from `search` and
    `context`. Embedders that ignore options keep compiling; code that calls
    `embed` directly must pass a purpose. `maxBatch` is optional and
    defaults to 100 in the core and in both shipped embedders: it counts
    texts, and OpenAI's 300,000-token request cap makes a larger default
    risky for long contents. The OpenAI-shaped embedder is named
    `openaiCompatibleEmbedder`, after `openaiEmbedder` and `aiSdkEmbedder`,
    and `openaiEmbedder` is a thin wrapper over the same code. Query and
    document hints differ by server (NIM `input_type`, Jina `task`, nomic
    and E5 text prefixes; Ollama, LM Studio, vLLM and Mistral have no
    field), so it takes per-purpose `prefix` and `body` and sends nothing
    by default; `dimensions` is sent only with `sendDimensions`, because
    vLLM rejects it for fixed-size models. Retries follow the OpenAI Node
    SDK: 2 retries, 500 ms doubling to 8 s, server waits honoured up to
    60 s (`maxRetryAfterMs`), with equal jitter (50–100% of the delay). The
    default rule reads `status` (408, 429, 500, 502, 503, 504) and network
    error codes along the `cause` chain, never messages; other
    `MnemocyteError`s than `"TIMEOUT"` no longer retry. Provider errors are
    a `ProviderError` (code `"EMBEDDING"`, `status`, `retryAfterMs`, the
    body as `cause`) that the core passes through unwrapped; its message
    leaves out the provider's free text, which can echo part of a key.
    (2026-11-13, landed) `aiSdkEmbedder` follows the same rules. `ai` is
    an optional peer at `^7.0.135` only: 7.0.135 is the first release whose
    `embedMany` takes `dimensions`, and supporting 6.x as well would need a
    second test run on another major without that option. It calls
    `embedMany` with `maxRetries: 0`, so one retry layer (the client's
    `provider` settings) applies instead of up to nine attempts per chunk.
    An `APICallError` or AI Gateway error with an HTTP status becomes a
    `ProviderError` (`retryAfterMs` from the response headers, the parsed
    error body as `cause`); other errors pass through. Google, Cohere and
    Voyage models get query and document hints by default (`taskType`,
    `inputType`), because Cohere's API embeds everything as a query unless
    told otherwise; `purposes` replaces them. Known-model dimensions are
    those the AI SDK provider docs state, and `Embedder.model` is the model
    id without the gateway's `provider/` prefix, so `openaiEmbedder`, a
    direct model object and a gateway string can share an installation.
    (2026-11-13, landed) `gemini-embedding-2` is a known model (3072) and,
    from a `google` provider (Gemini API, Vertex AI or a `google/…` gateway
    id), gets the retrieval text prefixes `googleEmbedder` sends instead of
    `taskType`: the Gemini API guide says the model cannot take `task_type`,
    and Vertex AI documents the same task instructions. What the API does
    with a `taskType` it is sent is not documented and was not tested. The
    prefixes count as built-in hints, so `purposes` replaces them too and
    keeps one meaning. `gemini-embedding-2-preview` is left out, as in
    `googleEmbedder`.
26. **Memory tools** (2026-11-13, landed): `memoryTools({ memory })` takes
    only a bound client (`"CONFIG"` otherwise) and returns
    `searchMemories`, `saveMemory` and `forgetMemory`. No input has a scope
    field, and one sent anyway fails validation with a message that the
    scope is fixed, so the model learns it cannot widen it. Schemas use the
    AI SDK's `jsonSchema()` with our own `validate` instead of zod: no new
    peer and no zod major to support, and `jsonSchema()` alone validates
    nothing. `searchMemories` takes `query`, `limit` (1–20, default 5) and
    `kinds`, and returns id, content, kind, importance, tags, `createdAt`
    and a rounded score; metadata, keys, sources and scopes stay out of the
    model's context. `saveMemory` sets only `content`, `kind` and
    `importance`, with `source: "saveMemory"`; a model-chosen `key` could
    overwrite a keyed memory the app wrote, and tags may drive app logic.
    `forgetMemory` deletes by id with the bound client's visibility, so
    shared memories of the entity are reachable, and returns
    `{ forgotten: false }` for `"NOT_FOUND"`; other errors are thrown and
    reach the model as AI SDK tool errors. Each tool forwards the call's
    `abortSignal`. There are no options besides `memory`: the result is a
    plain object, so apps drop or reword a tool by destructuring and
    spreading, and approval belongs to the AI SDK's `toolApproval`
    (tool-level `needsApproval` is deprecated in AI SDK 7).
    `MemoryTools` is a type alias so it is assignable to `ToolSet`.
27. **Memory middleware** (2026-11-13, landed): `memoryMiddleware` and
    `withMemory({ model, memory })` take only a bound client. Before each
    model call `transformParams` runs `context()` on the text of the last
    user message (a `query` callback can replace it) and forwards the
    call's `abortSignal`. The context goes, under a one-line preamble that
    calls it background and not instructions, into the last user message
    by default, with `placement: "system"` as the option: context that
    changes every turn at the system position breaks providers' prefix
    caching of the conversation, and memories can hold user-derived text
    (including what `saveMemory` stored) that should not get system
    authority; the AI SDK's own RAG example also uses the last user
    message. A system message goes after the leading system messages,
    because Anthropic and Google reject later ones. `context()` now returns
    `""` when nothing matches, so the middleware can add nothing, instead
    of a second search-and-format path. Defaults stay `context()`'s (1200
    tokens, markdown) and are set through a `context` option. Because
    `transformParams` runs per step, the last query's context is cached in
    the middleware, which is created per request. A failed `context()`
    goes to an `onError({ phase, error })` option and the call runs without
    memory (fail open); aborts are thrown. The hook is
    `save: (turn) => void | Promise<void>`, so extraction can widen it to
    `save: { model }`; it gets `{ memory, prompt, text, finishReason }`
    once after the final step (never after `"tool-calls"`, `"error"` or
    `"interrupted"`, nor a stream with an `error` part), is not awaited,
    and reports failures to `onError`, since the middleware cannot reach
    the client's `onEvent`. `withMemory` takes model objects only:
    `wrapLanguageModel` does, and resolving strings would copy AI SDK
    internals; the error points to `gateway("provider/model")`.
28. **Extraction** (2026-11-13, landed): `save` on `memoryMiddleware` and
    `withMemory` is a function or `{ model, instructions, maxMemories,
    timeout, waitUntil }`, not both; a hook that wants both calls the
    exported `extractMemories`, which runs the same extraction and returns
    the stored memories. Facts are matched by key, not by a similarity
    threshold: before the model call one `search` shows the model up to 20
    memories, with the keys of earlier extractions in the exact bound
    scope, and it reuses a key to update a fact or makes a new snake_case
    one. Keys are stored as `extracted:<key>`, so an app key is never
    overwritten, and one keyed `addMany` writes them; its
    `ON CONFLICT DO UPDATE` keeps concurrent extractions of a fact in one
    row, where a check-then-insert on a threshold would race. A threshold
    was rejected because `search` embeds with `purpose: "query"`, whose
    cosine to stored documents is not comparable to a document-to-document
    one for asymmetric embedders, and because cut-offs differ between
    embedding models. Memories without a key (app or `saveMemory`) are
    shown but never updated. The model sees the user messages of the
    final turn, the assistant message before them and the response, never
    system messages or tool results (third-party text), and returns
    `{ memories: [{ key, content, kind, importance }] }` through
    `generateText` with `Output.object` (AI SDK 7 deprecates
    `generateObject`) and a `jsonSchema()` with our own `validate`; every
    property is required so OpenAI's strict mode accepts it. Kinds are
    `fact`, `preference`, `instruction` and `backstory` (episodes and
    session notes are not lasting facts), importance `low` to `high`
    (`critical` stays the app's), at most 10 per turn by default (20 at
    most). The built-in prompt can be extended with `instructions` but not
    replaced, so its rules against storing secrets and assistant-only
    claims stay. Failures go to `onError({ phase: "save" })`, not a new
    `onEvent` operation: the middleware cannot reach the client's
    `onEvent` (27), and the search and write already report there. The
    extraction has its own `timeoutMs` (30 s) instead of the request's
    `abortSignal`, which has nothing left to cancel. `waitUntil` receives
    a promise that never rejects, for serverless platforms. A
    `"provider/model"` string is accepted, unlike `withMemory`'s `model`,
    because `generateText` resolves it. The extraction call carries
    `providerOptions.mnemocyte.extraction`, and the middleware passes such
    calls through, so a model wrapped with memory given as the extraction
    model cannot recurse.
29. **Voyage, Cohere and Gemini embedders** (2026-11-13, landed):
    `voyageEmbedder`, `cohereEmbedder` and `googleEmbedder` in
    `mnemocyte/embedders/voyage`, `/cohere` and `/google` share one
    `fetch` core with `openaiCompatibleEmbedder` (`createFetchEmbedder`:
    purpose check, signal, `ProviderError`, response checks), so retries,
    timeouts and `maxBatch` work as for the others. The core is shared
    instead of the OpenAI-shaped request because Voyage rejects
    `encoding_format: "float"` and none of the three takes `dimensions`.
    The name is `google`, after the roadmap and the AI SDK provider key,
    and it calls the Gemini API (`generativelanguage.googleapis.com`, key
    in the `x-goog-api-key` header so it never sits in a URL). Vertex AI is
    left out: it needs hourly OAuth access tokens, a `:predict` shape and
    one text per request for `gemini-embedding-001`; `aiSdkEmbedder`
    covers it. Keys default to `VOYAGE_API_KEY`, `COHERE_API_KEY` and
    `GEMINI_API_KEY`, one name each. Known models come from each
    provider's docs: a model that can shorten its vectors accepts the
    sizes listed (Voyage 256 to 2048, Cohere's v4 and v5 lists, Gemini 128
    to 3072), which are then sent; a fixed-size model accepts only its own
    size; an unknown model requires `dimensions`, which is not sent,
    because a fixed-size model would reject it. Gemini vectors shorter
    than 3072 are not normalized: storage compares by cosine, which
    ignores length. `gemini-embedding-2` does not take `taskType`, so it
    gets the retrieval prefixes Google gives for it; other Gemini models
    get `taskType`. `truncate` defaults to `true` and is always sent: the
    32,000-character content cap passes Cohere v3's 512-token and
    `gemini-embedding-001`'s 2,048-token contexts, truncating is Voyage's
    and Cohere's default, and Gemini documents none. `maxBatch` stays
    unset (100) for Voyage, whose 1,000-input cap is not the binding limit
    (120K tokens per request for the large models); it is 96 for Cohere,
    its documented limit, which larger values may not pass; and 100 for
    Gemini, whose `batchEmbedContents` has no documented limit (100 is the
    deprecated `batchEmbedText`'s). Cohere's `embedding_types: ["float"]`
    is always sent because its docs disagree on whether it is required.
    Gemini fields go in `embedContentConfig`; the top-level `taskType`,
    `title` and `outputDimensionality` are deprecated in the v1beta
    discovery document. A Google error's canonical `status` labels the
    `ProviderError` message (its `code` is numeric); Voyage's `detail` and
    Cohere's `message` are free text and stay out. No provider documents
    `Retry-After` or `RetryInfo`, so none is read.
30. **Stable consolidation** (2026-11-13, landed): `consolidate` moved to
    `MemoryClient` and `BoundMemoryClient` with its one-statement
    `SELECT … FOR UPDATE` design unchanged. `experimental.consolidate`
    stays as a deprecated alias until 1.0, so 0.8 breaks nothing (removed
    with decision 38).
    `delete` takes `dependents: "reject" | "restore" | "delete"`, default
    `"reject"`. `"delete"` goes beyond the per-call choice planned here
    (repoint to null or reject) because `forgetMemory` needs it: search
    shows only survivors, so a model could never forget a memory that
    duplicates were merged into. It deletes transitively, since a
    consolidation does not stop a loser from being a survivor itself. A
    dependent the call cannot see blocks `"restore"` and `"delete"`, so a
    delete never writes outside its visibility. `prune` now deletes a
    survivor selected with all its dependents, like `deleteScope`.
    `findDuplicates` takes each memory's `neighbors` nearest (default 10,
    at most 100) through a `LATERAL` join instead of a self-join: the
    HNSW index answers it per memory, so results are approximate on
    Postgres; an exact mode was left out, since a later run after
    consolidating finds what one missed. The index plan was measured on
    PGlite (see features/maintenance.md); server numbers come with
    `chore/benchmarks`. (2026-11-13) On a Postgres 18.6 server the planner
    takes the HNSW path only for large scopes: a 2,000-memory scope of
    132,000 reads its rows once per memory (exact, 29 s), and forcing HNSW
    there was slower (52 s) and found 189 of 200 pairs; a 30,000-memory
    scope takes 149 s through HNSW with an index larger than the cache. The
    design stands, but `findDuplicates` over a large scope is a background
    job of minutes.
31. **Non-blocking observability** (2026-11-13, landed): `onEvent` is called
    synchronously and never awaited, so a slow async hook cannot delay or
    fail a call. Failures (a throw, or a rejection caught on the returned
    promise) go to an optional `observability.onError({ error, event })`
    and are dropped when it is unset: a library writing to the console is
    noisy and cannot be turned off, and silence alone would hide a broken
    exporter. A throwing `onError` is ignored. Events keep invocation order
    (`start`, then `success` or `error`) and are not serialized: chaining
    each event on the previous hook's promise would give non-overlapping
    handlers, but a hook that never settles would queue every later event
    for the life of the call. A synchronous hook still blocks while it
    runs, and serverless platforms may cut off un-awaited work, so apps
    flush their exporter themselves. The AI SDK middleware and tools only
    call client methods, so they inherit this.
32. **Audit retention as a method** (2026-11-13, landed): the roadmap
    asked for a retention option; it became an explicit method,
    `pruneAuditLog({ scope | allNamespaces, before, batchSize, dryRun })`,
    which apps call from a scheduled job. Retention applied automatically
    needs either a timer, which decision 19 rules out, or a delete inside
    every audited write, which would make writes pay for old history and
    add a step to the one-statement audit `WITH` of decision 16. `before`
    is a `Date`, the same strict filter as `listAuditLog`'s `before`, so a
    listing previews the prune. On Postgres it deletes in batches of
    `batchSize` (default 1,000, at most 10,000), one statement each,
    committing one by one: a large first run never holds one long
    transaction, and an abort keeps the batches already deleted. Batches
    walk `mnemocyte_events_scope_time_idx` in order and each resumes after
    the last event of the one before (keyset pagination); restarting from
    the beginning walked the dead index entries of every earlier batch,
    which made an all-namespaces run quadratic in the backlog (8.4 s
    against 3.4 s for 500,000 old events on PGlite). No new index: a
    `(timestamp)` btree sped up restarting batches (0.35 s against 0.85 s
    on 200,000 events), but keyset batches read the scope index in order,
    within about 12% of its buffers per batch, and it would cost 4.5 MB
    per 200,000 events and an insert on every audited write (see
    features/maintenance.md). The prune records no audit event, like
    `deleteScope`; observability reports its count. (2026-11-13) Confirmed
    on a Postgres 18.6 server with 1,000,000 events: every batch is one
    index descent and 1,000 entries in order (7.9 s for 500,000 events
    across namespaces), and with a `(timestamp)` index the planner keeps
    the same plan (8.7 s), so it stays out.
33. **`hnsw.ef_search` stays at pgvector's default** (2026-11-14, landed):
    the roadmap asked for a higher floor than `max(40, limit)` for
    filtered vector search, and the maintainer chose a fixed floor, not
    configurable. Measured on Postgres 18.6 and pgvector 0.8.7, a higher
    value raises recall only while the planner keeps the HNSW scan:
    pgvector's cost estimate grows the scan's startup cost with
    `ef_search`, and under a `LIMIT` the planner then reads the scope and
    sorts, exact but 45–340 ms instead of 1–5 ms. 200 kept HNSW at 1,536
    dimensions (99.2% of the exact rows against 87.8%) and switched the
    3,072-dimension dataset to a 143 ms sequential scan; 300 did the
    reverse. The switch point depends on each table's statistics, so no
    fixed value is safe, and a per-client option would ask users to
    re-measure their own table. The default stays, with the numbers in
    features/postgres.md. `hnsw.iterative_scan = relaxed_order`, which the
    cost estimate does not read, was the next lever (decision 34).
34. **`relaxed_order` for the search vector query** (2026-11-14, landed):
    the maintainer chose to adopt it if recall rose, the planner kept HNSW
    and latency stayed within the noise (median and p90 within the larger
    of 10% and 1 ms), and to give `findDuplicates` the same bar. A
    `strict_order` scan drops rows that a later pass finds closer than rows
    it already returned; `relaxed_order` keeps them, out of order, so the
    query runs in a materialized CTE and is sorted again
    (`ORDER BY "vectorDistance" + 0`, since Postgres 17+ otherwise treats
    the CTE's output as already sorted). Measured with both orderings on
    the same index build (Postgres 18.6, pgvector 0.8.7, `ef_search` 40, 20
    queries): 82.7% → 95.8% of the exact rows at 1,536 dimensions, 61.7% →
    80.7% with a `kinds` filter and 89.8% → 91.8% at 3,072, every query on
    HNSW in both, medians within 0.3 ms or faster and p90 lower (24 → 5 ms,
    122 → 35 ms, 10.7 → 2.5 ms). With a `kinds` filter at 3,072 the planner
    chose a sequential scan for both (100%, 44 and 46 ms). At every other
    `ef_search` the plans matched `strict_order`'s, so the CTE leaves the
    planner's choice alone. `findDuplicates` stays on `strict_order`: on
    the benchmark's 2,000-memory entity the planner reads the scope index,
    where the setting does nothing (200 of 200 pairs for both), so nothing
    was measured on its HNSW path; that is a roadmap item.
    (2026-11-14, landed) `findDuplicates` moved to `relaxed_order` under the
    same bar, without a CTE: its pairs are thresholded, grouped and sorted
    afterwards, so the order of a memory's neighbors does not matter. On
    the same entity with the scope index dropped (HNSW per memory, same
    index build, median of 3 after a warm-up): 187 → 200 of 200 pairs,
    30.1 → 21.2 s (slowest 30.1 → 21.4 s), the same plan with the same cost
    estimates.
35. **`findDuplicates` in pages by a cursor** (2026-11-14, landed): a
    30,000-memory scope took 84–149 s in one statement that cannot be
    resumed. The maintainer chose a cursor over a time budget: a page
    compares a fixed `batchSize` of memories in id order, so pages are the
    same on both backends and testable, and a caller who wants a deadline
    stops between pages; a budget would need several statements per call
    and give pages that depend on timing. It starts as
    `experimental.findDuplicatesPage` returning `{ pairs, nextCursor,
    compared }`, and the stable `findDuplicates` is unchanged. A pair
    belongs to the page of the memory whose neighbors contain the other (the
    smaller id's when both do); a page re-runs the nearest-neighbor search
    of a smaller-id neighbor to skip pairs an earlier page returned, so a
    run returns each pair once without state between calls. Pages have no
    `limit` and sort only their own pairs; a global order is the caller's,
    which keeps a page bounded by `batchSize × neighbors`.
    Measured on the 30,000-memory entity (Postgres 18.6, pgvector 0.8.7):
    52 pages of 500 at 1.33 s each (slowest 1.46 s), 68.7 s in all
    against 51.3 s for one statement, every pair once and the best 1,000
    equal to one `findDuplicates` call's; the re-check costs 5% of a page.
36. **The CLI loads the app's memory file with Node alone** (2026-11-14,
    landed): the maintainer chose type stripping plus a resolve hook over
    requiring a build, the names `migrate`, `check` and `sql` with
    `--config`, loading `./.env` when present, and a `check` that fails
    on anything that makes the app throw. The hook is
    `module.registerHooks` (synchronous, in the current thread, from Node
    22.15), not the `module.register` this document first named: Node
    26 deprecates `module.register` at run time (DEP0205) and prints a
    warning on every run, and CI runs Node 26. The hook asks Node to
    resolve first and acts only when that fails, so it cannot change how
    an installed package resolves; it adds extensionless and
    `.js`-for-`.ts` relative imports, folder index files and tsconfig
    `paths`. Syntax that needs a compiler (enums, parameter properties,
    `.tsx`) is not supported and fails with a message that points to
    `--config <built .js>`: transforming it would need a TypeScript
    compiler as a dependency. The bin reads `.env` itself because the
    memory file reads `process.env` while it loads and `npx` gives no
    place for Node's own `--env-file`; a variable that is already set
    wins. Node also reads `--env-file` from a script's arguments, so a
    missing file is reported by Node (exit 9) before the bin runs; the
    flag keeps the name users know from Node. Without a memory file the
    bin resolves the app's `postgres` package at run time and imports it
    by path, so the build has no driver import and the package keeps zero
    dependencies. `check` reads through a new internal
    `MemoryStore.inspectInstallation`, which reuses the runner's own
    catalog reads, so `check` and `migrate` cannot disagree about a
    schema; a database it cannot read exits 2, a problem exits 1. The bin
    ends with `process.exit`, since it cannot close the app's client.
    `registerHooks` is "active development" on Node 22 and type stripping
    a release candidate there; both are covered by a package test that
    runs the built bin on every CI Node version. (Revised by decision 97:
    `server-only` is the one specifier mapped before Node resolves it.)
37. **`init` picks Drizzle first and writes the guide's files** (2026-11-14,
    landed): the maintainer chose, for `mnemocyte init`, that `drizzle-orm`
    wins over a plain driver and wraps the one next to it (`postgres`,
    then `pg`, then PGlite), since a Drizzle app's database handle is its
    `db`; without Drizzle `postgres` wins as the guide's default. With no
    driver it writes the in-memory file, so the app runs at once. Each
    file is a `memory.ts` block of the getting-started guide, with
    `namespace` from `package.json` `name`, and a unit test holds the
    two together; Drizzle over `pg` and over PGlite gained blocks there.
    `init` appends `OPENAI_API_KEY=` to `.env`, creating the file when
    needed, and only prints a note about `.gitignore`. The file goes in
    the project root, the first folder the CLI searches; an existing
    memory file anywhere the CLI searches is kept, and files are created
    with `O_EXCL`, so `init` never overwrites.
38. **1.0 freeze review** (2026-11-14): the maintainer chose, for the
    surface 1.0 freezes:
    - `namespace` keeps its name. It already reads as "tenant or app" in
      the docs, and a rename would touch every scope of every app for no
      change in behaviour.
    - `search` and `findDuplicates` keep returning arrays. Only
      `listAuditLog`, which pages, becomes an object with an opaque
      `nextCursor`, like `list`.
    - Unknown option keys throw `"CONFIG"`. TypeScript flags a misspelled
      key only in an object literal; from JavaScript, or with options built
      elsewhere, a misspelled `baseURL` today sends content to the
      provider's default endpoint. Rejecting unknown keys after 1.0 would be
      a breaking change. (Landed with `fix/strict-options`: the config, its
      nested settings objects, `postgresStore`, the embedders and the AI SDK
      options are checked by `assertKnownKeys`, and a key set to `undefined`
      counts as absent. `baseUrl` became `baseURL`, the AI SDK's spelling,
      and the extraction `timeout` became `timeoutMs`; the error for either
      old name says what replaced it.)
    - `postgresJs()`, `drizzleStore()` and `mnemocyte/stores/drizzle` go
      in 1.0 rather than staying deprecated through 1.x. They break the
      single-object rule, and `store: client` covers them (decision 23).
      (Landed with `chore/drop-legacy-surface`, together with the
      `experimental.consolidate` alias, the schema template, the renderer
      and the journal leaving the tarball. A Drizzle instance annotated as
      `PostgresJsDatabase`, which omits `$client`, passes `db.$client`;
      the maintainer chose that over a `drizzle-orm` type import.)
    - Errors gain a `reason` for the cases one `code` covers, and
      `isMnemocyteError` checks a `Symbol.for` brand. The AI SDK
      (`isInstance`) and Better Auth (`isAPIError`) both use a guard
      because `instanceof` fails across duplicate package copies.
      (Landed with `feat/error-reasons`: 14 reasons, unique across codes,
      each a case the caller handles differently; `new MnemocyteError`
      takes one object whose type requires a reason for those three
      codes. The brand is on the prototype. Codes, reasons,
      `MnemocyteOperation`, `MnemocyteBackend` and `AuditEventType` may
      gain members in a minor; the other unions only in a major.)
    The resulting items landed before 1.0.0 (see CHANGELOG.md). The
    review's additive findings are items in ROADMAP.md.
39. **What semver leaves out** (2026-11-14): the maintainer chose, with
    `docs/v1`:
    - The promise excludes the internal `MemoryStore` contract, anything
      under `experimental.*`, error message text, the CLI's output text,
      the exact wording of `context()` output, and `score` values and
      ranking. The `context()` formats, their fencing guarantee and the
      token budget stay covered, and so do result shapes; retrieval tuning
      may reorder results in a minor.
    - `experimental.findDuplicatesPage` stays experimental in 1.0. It
      landed the day of the freeze (decision 35) with no use in the field
      yet; graduating it later is additive.
    - The upgrade path from 0.5 lives in its own guide page,
      `docs/guide/upgrading.md`, one section per release, and the docs drop
      their pre-1.0 wording in `docs/v1` rather than in the release PR.
    The final export review found no change beyond decisions 38 and 39.
    (2026-11-15, revised with `docs/api-review`) The promise also leaves out
    the wording of the text `mnemocyte/ai-sdk` gives the model (tool and
    field descriptions, the middleware's preamble line, the extraction
    prompt), as it does `context()` wording; tool names, input fields and
    results stay covered. `MemoryPrompt`, `MemoryLanguageModel`,
    `MemoryWrappedModel`, `MemoryFinishReason` and `AiSdkProviderOptions`,
    and the `ai` types other AI SDK types use, follow the installed `ai`
    peer. The experimental exemption names its root exports
    (`FindDuplicatesPageInput`, `BoundFindDuplicatesPageInput`,
    `DuplicatePage`, `ExperimentalMemoryClient`,
    `BoundExperimentalMemoryClient`) and the `"findDuplicatesPage"`
    member of `MnemocyteOperation`.
40. **Time filters name their field** (2026-11-15, landed): the maintainer
    chose, with `fix/created-filters`, to rename `search`'s `before` /
    `after` to `createdBefore` / `createdAfter`, the name `prune` already
    used. A memory has four times (`createdAt`, `updatedAt`,
    `lastAccessedAt`, `expiresAt`), so a bare `before` on `list` or
    `context` after 1.0 would be ambiguous; an audit event has one, so
    `listAuditLog` and `pruneAuditLog` keep `before` / `after`. The old
    names throw `"VALIDATION"` naming the new ones rather than being
    ignored, which would widen the search. The check stays through 1.x;
    since decision 41 it is the `renamed` map of `search`'s key check.
41. **Method inputs reject unknown keys** (2026-11-15, landed): the
    maintainer chose, with `fix/strict-inputs`, to extend decision 38 from
    options to method inputs before 1.0, since adding it later would break
    callers. An ignored key fails open: a misspelled `kinds` widens a
    search, a scope `sessionID` makes `deleteScope` erase every session, a
    selector `entityID` makes `prune` cover the namespace, and
    `migrate({ dryrun: true })` applies the migrations.
    - The code is `"VALIDATION"`, without a reason: it is a bad call, not a
      bad setup, nothing was embedded or stored, and decision 40's renamed
      keys already throw it. Reasons stay on `"CONFIG"`, `"CONFLICT"` and
      `"MIGRATION"` only.
    - Checked: every method input (plain, default-namespace and bound
      clients, `experimental.findDuplicatesPage`, `migrate`), `scope`
      (including `for()`) and each `addMany` memory. Not checked inside:
      `metadata`, which is the caller's JSON, `tokenCounter`, which may be
      a class instance, and `signal`. A key set to `undefined` counts, as
      in decision 38.
    - The key check runs first, so a misspelled required key reports
      itself rather than the missing field. Bound inputs reach it through
      the core; bound `stats()` passes its input on so any key throws.
    - A minor may add an optional key; code using it fails on an older
      version with `"VALIDATION"` instead of running without it.
42. **Matching input names** (2026-11-15, landed): the maintainer chose,
    with `feat/input-aliases`, `BoundPruneInput` for the bound `prune`
    input, matching the `Bound…Input` of every other bound method, and
    `AiSdkPurposeHints` for the AI SDK embedder's `purposes`, pairing with
    the embedders' `PurposeHint` / `PurposeHints` under the entry's `AiSdk`
    prefix; the embedders' names stay. The old names, `PruneSelectors` and
    `AiSdkPurposeOptions`, are `@deprecated` type aliases through 1.x and
    go in 2.0. The new names are the interfaces, so hovers show them; the
    cost is that the old names can no longer be augmented as interfaces.
    `BoundMemoryClient.prune` takes `BoundPruneInput`, the same type as
    before.
43. **Embedder headers: ours win** (2026-11-15, landed): the maintainer
    chose, with `feat/embedder-headers`, to give `openaiEmbedder`,
    `voyageEmbedder`, `cohereEmbedder` and `googleEmbedder` the `headers`
    option `openaiCompatibleEmbedder` has, with the same rule: names are
    lower-cased, and `content-type` and the header that carries `apiKey`
    (`authorization`, or `x-goog-api-key` for Gemini) replace a caller's
    copy. The gateways checked keep their own key out of the provider's
    slot (Cloudflare AI Gateway's `cf-aig-authorization`, Portkey's
    `x-portkey-api-key`) or take it in `authorization`, where it can be
    passed as `apiKey` (LiteLLM, Helicone), so none needs to replace ours.
    Letting a caller replace the key header, or rejecting a clash with
    `"CONFIG"`, would make the four differ from `openaiCompatibleEmbedder`,
    and changing the rule later would break callers. On Gemini a caller's
    `authorization` is not ours and is sent next to `x-goog-api-key`.
    Headers are checked with `new Headers()` when the embedder is created,
    so a name or value `fetch` would reject throws `"CONFIG"` instead of a
    `TypeError` on the first call; the error names the header but carries
    neither its value nor the `TypeError`, which quotes it. Left open: a
    gateway that holds the provider key itself (Cloudflare's stored keys,
    Portkey's managed providers) still gets an `authorization` or
    `x-goog-api-key` from the four, which require a key.
44. **Embedder fetch: the fetch type** (2026-11-15, landed): the maintainer
    chose, with `feat/embedder-fetch`, to type the `fetch` option of the
    five HTTP embedders as `typeof globalThis.fetch`, the AI SDK's
    `FetchFunction`, so the function an app passes to `createOpenAI({ fetch })`
    or a `vi.fn<typeof fetch>()` fits unchanged. A narrower
    `(input: string, init: RequestInit) => Promise<Response>` would also
    accept a wrapper that types its first parameter as `string`, but would
    freeze the call shape for 1.x; the docs promise a string URL and an
    `init` instead. It is checked at creation (a function, else `"CONFIG"`)
    and called without a receiver, since a browser `fetch` called on another
    object throws. `aiSdkEmbedder` takes none: it receives a built model, and
    AI SDK providers already take `fetch` (`createGateway` for model strings).
45. **Delete returns ids** (2026-11-15, landed): the maintainer chose, with
    `feat/delete-result`, to have `delete` resolve with
    `DeleteResult { deletedIds, restoredIds }` instead of `void`:
    - Ids only, not the memories. Both stores already return them, and so
      do the `memory.deleted` events; returning memories would mean
      `RETURNING *` from both CTEs, and a `"delete"` over a large tree
      would send all its content back to a caller who usually needs ids.
      `get` fetches a restored memory when one is wanted.
    - On the stable client, not under `experimental`: a stable method's
      return value cannot move there without a second method, and the shape
      matches the store and audit payloads already shipped.
    - A 1.x minor. Code that awaits `delete` is unchanged; TypeScript
      flags only code that restates the old type (a `Promise<void>`
      annotation, a function typed to return one, a hand-written
      `MemoryClient` fake), which the CHANGELOG names.
    `deletedIds` lists the memory first, then the rest by id; `restoredIds`
    is by id. The Postgres store lower-cases the requested id, since
    `isUuid` accepts either case and the database returns lower case.
    `forgetMemory` keeps returning `{ forgotten }`.
46. **Context with its memories** (2026-11-16, landed): the maintainer
    chose, with `feat/context-memories`, a new method,
    `experimental.contextWithMemories`, returning
    `ContextWithMemoriesResult { context, memories, omitted }`:
    - A method, not an option on `context`. An option would make
      `context` return a string or an object depending on its input, which
      needs overloads or conditional types and complicates every wrapper;
      `context(): Promise<string>` and the AI SDK middleware that calls it
      stay as they are.
    - Full `MemoryWithScore` records in both lists, not ids as in
      decision 45: the search has already loaded them, so they cost
      nothing, and `score` and `scores` are what citations and debugging
      need. `memories` followed by `omitted` is the search result in rank
      order, so nothing the search found is hidden. The input adds
      `explain`, passed to the search.
    - Under `experimental`. The `omitted` list and `explain` have no use
      in the field yet; graduating the method is additive, as decision 39
      says of `findDuplicatesPage`. It is its own `"contextWithMemories"`
      operation, with `count` = `memories.length`.
    `buildContext` returns the result and `context` keeps only the
    string, so the two methods cannot render differently. Access tracking
    (resolved 2026-11-17, `fix/context-track-access`): both methods mark
    only `memories`, not `omitted`. The search hands its visibility back
    through a `deferAccess` callback instead of starting the write, and the
    context call starts the same single access statement after the token
    budget, so it costs no extra round trip. Marking inside the search SQL
    was rejected: the budget is counted in the client after ranking, and
    it would make every search a write. `search` still marks every result.
    The maintainer chose a `Fixed` CHANGELOG entry, since omitted memories
    never reached the prompt.
47. **CLI JSON output** (2026-11-16, landed): the maintainer chose, with
    `feat/cli-json`, a `--json` flag on `check` and `migrate --dry-run`
    that prints one JSON object on one line, last on stdout, with the exit
    codes unchanged:
    - Stable from the start, unlike `experimental.*`: CI is the reason it
      exists. Semver covers field names, their types and the codes;
      `message` text stays out, as decision 39 says of error messages and
      the CLI's text. Minors may add fields and codes.
    - camelCase fields and an envelope of `command`, `ok`, `target` and
      `backend`. `check` reports `installation` (migration lists always
      present, `null` for what is missing) and `problems` and `notes` as
      `{ code, message }`, with UPPER_SNAKE codes like `MnemocyteError`'s,
      one per branch of `evaluateInstallation`. The `migrate` plan is
      `MigrateResult` plus `upToDate`.
    - Errors after parsing also print JSON (`error.message`, `code` and
      `reason` of the first `MnemocyteError` in the chain, `causes`), and
      the text still goes to stderr. A bad command line prints none.
    - `migrate --json` needs `--dry-run`: a real run may ask on stdout.
      Allowing it later, without a prompt, is additive. `init` and `sql`
      get no `--json`, and no roadmap item is added until someone asks.
48. **`init --embedder`** (2026-11-16, landed): the maintainer chose, with
    `feat/init-embedder`, a `--embedder` flag on `init` with two values,
    `openai` (the default, unchanged output) and `openai-compatible`:
    - No hosted embedders yet (Voyage, Cohere, Gemini). Each needs its own
      template, key variable and hint; adding a value later is additive,
      and no roadmap item is added until someone asks.
    - `openai-compatible` writes the getting-started Ollama embedder as it
      stands: `baseURL` `http://localhost:11434/v1`, `nomic-embed-text`,
      768 dimensions and the `search_query: ` and `search_document: `
      prefixes. Ollama's own embeddings page now shows `embeddinggemma`;
      moving to it would change the guide too, so it is its own change.
    - No `.env` variable for it. Ollama's OpenAI-compatible API needs no
      key ("required but ignored" in its docs), and an empty variable
      would suggest one is needed. `.env` is not written; the "Next" list
      says to pull the model, or to change `baseURL`, `model` and
      `dimensions` first for another server.
    - No interactive prompt, so `init` behaves the same in a terminal, a
      script and CI, and `--dry-run` shows exactly what a run does. A
      prompt when the flag is missing and stdin is a terminal would be
      additive.
49. **Audit history by memory id** (2026-11-16, landed): the maintainer
    chose, with `feat/audit-memory-id`, the first migration after 1.0:
    - `mnemocyte_events.memory_id uuid GENERATED ALWAYS AS (…) STORED`,
      computed from `metadata.memoryId` with a UUID-pattern guard, instead
      of a column the client writes. No write path names it, so a 1.1
      client works on a 1.0 schema and a 1.0 client on a 1.1 schema, in
      either deploy order and for `psql` users. Writing it from the client
      would fail every audited write of an app upgraded before `migrate`
      runs, a break in a minor; detecting the column at run time would
      need a cached catalog probe that goes stale when `migrate` runs
      while the app is up, leaving null ids the backfill never sees.
    - The backfill is the rewrite that adds the column, inside the
      migration, with no separate step. It holds `ACCESS EXCLUSIVE` on
      `mnemocyte_events` for the rewrite and the index build: 8.5 s and
      1.1 s for 1,000,000 events (150 MB) on a laptop, against 19.6 s and
      1.5 s for a plain column filled by one `UPDATE`, which also left
      316 MB until `VACUUM`.
    - Index `mnemocyte_events_memory_idx` on `(memory_id, timestamp, id)`,
      not partial. Memory ids are unique across the installation, so a
      leading `memory_id` is selective at any selector, `allNamespaces`
      included; `(timestamp, id)` gives the page order with no sort and
      keyset pages for long histories. Measured on 1,000,000 events: 0.05–
      0.07 ms for a 5-event memory at every selector (45–65 ms across a
      namespace or all of them without it), 0.14 ms for a 500-event one
      across namespaces and 1–2 ms within a scope, where the planner
      prefers a bitmap scan and a sort. 56 MB, against 12.8 MB for a
      deduplicated `(memory_id)` that sorts every page, and 36 ms against
      17 ms for inserting 1,000 events with random ids (see
      features/maintenance.md).
    - No `CREATE INDEX CONCURRENTLY` and no runner change: the runner
      applies each migration in one transaction, where it cannot run, and
      the rewrite in the same step already holds the strongest lock. A
      non-transactional step type stays out until someone asks.
    - `listAuditLog` takes `memoryId?: string`, matching the event's
      subject (`metadata.memoryId`) only; `deletedWith`, `supersededBy` and
      `restoredIds` are not matched. A non-UUID returns an empty page on
      Postgres, as `get` returns `null`. The id stays in `metadata`, the
      column's source and a stable payload, and `AuditEvent` gets no
      top-level field.
50. **Text search configuration at install time** (2026-11-16, landed):
    the maintainer chose, with `feat/text-search-config`:
    - The configuration is recorded only in `content_tsv`'s generated
      expression, `to_tsvector('<name>'::regconfig, content)`, read back
      with `pg_get_expr`. A `mnemocyte_meta` column would need a migration
      and could disagree with the column after a manual `ALTER`, and a
      client that read it would fail keyword search on a 1.1 schema until
      `migrate` ran, a break in a minor. Every 1.x schema has the column,
      so 1.1 and newer clients work in either deploy order while the
      installation uses `english`. A 1.1 client builds its query with
      `websearch_to_tsquery('english', …)` whatever the column uses, so on
      `simple` its keyword matches are lost without an error. Every
      process must run 1.2 before a non-`english` configuration is picked
      (fresh install or `text-search`), and before a `schemaName`, which
      1.1 ignores. The guide and `mnemocyte text-search`'s output say so
      (`fix/mixed-version-text-search-docs`).
    - `mnemocyte text-search` reads `inspectInstallation()` and, when the
      migrations are not recorded (`psql` or drizzle-kit), adds a note to
      the dry run, the question and the result: if drizzle-kit manages the
      tables, change the language with `generate --adapter drizzle
      --text-search-config` instead, because changing the column leaves
      drizzle-kit's schema file behind. It does not refuse: a `psql`
      installation is also untracked, and the command is its tested path
      (`fix/text-search-drizzle-schema-notes`). `--json` is unchanged.
    - `migrate({ textSearchConfig })` and `--text-search-config` on
      `migrate`, `check` and `sql`. It sets a fresh install; on an existing
      one a different configuration is `"CONFIG"`
      (`TEXT_SEARCH_CONFIG_MISMATCH`) and nothing runs. `english` stays the
      default for new installs: switching to `simple` in a minor would
      give English users weaker recall (no stemming) without asking.
    - Changing it is `setTextSearchConfig()` from the root and
      `mnemocyte text-search <name>`, not a numbered migration (one
      sequence for every installation cannot carry a per-installation
      value) and not only manual SQL (the version split, the lock and the
      `ANALYZE` belong in one tested place; the guide still shows the SQL).
      It runs under the migration advisory lock with every migration
      applied: `SET EXPRESSION` on Postgres 17+, `DROP` and `ADD COLUMN`
      plus the GIN index on 15 and 16, then `ANALYZE`. Both rewrite the
      table and rebuild every index, HNSW included; the timings are in
      features/postgres.md. The CLI asks before the rewrite.
    - The store reads the configuration once, before its first keyword
      search, and caches it; the query passes it as `$n::regconfig`. A
      process that did not run the change keeps the old configuration until
      it restarts (weaker matches, no errors), which the docs and the
      command's output say. A lookup inside every keyword statement would
      avoid that at a cost on every search.
    - The in-memory backend matches substrings and has no configuration:
      `migrate` ignores the option and `setTextSearchConfig` returns `null`
      names with `changed: false`.
51. **Tables in a schema of their own** (2026-11-16, landed): the
    maintainer chose, with `feat/schema-name`:
    - `schemaName` is an option of `postgresStore()` only. `migrate`,
      `setTextSearchConfig` and the CLI's memory file take it from the
      store, so it is set in one place and cannot disagree;
      `createMemory({ store: sql })` stays the shortcut for the default.
      Without a memory file the CLI takes `--schema` on `migrate`, `check`,
      `sql` and `text-search`; with one, `--schema` may only repeat the
      store's name.
    - `migrate` creates a missing schema on a fresh install, under the lock
      and in the install's transaction, with no flag (`createExtension`
      has one because it needs a superuser; this needs `CREATE` on the
      database). The result gains `schemaCreated`.
    - Names match `^[a-z_][a-z0-9_]*$`, up to 63 characters, not `pg_…`,
      checked when `postgresStore` is called (`"CONFIG"`), and are always
      double-quoted in SQL. Lower case only, so they work unquoted in
      `psql`; widening later is not a break.
    - The tracking table moves with the tables, so each schema is its own
      installation. The advisory lock key stays one for every schema:
      migrations are rare, and a key per schema would stop a 1.1 client
      and a newer one from excluding each other on the default
      installation unless the newer one took both keys.
    - Queries and catalog reads name the schema; the bundled migrations
      and the template stay bare and run after a `SET LOCAL search_path`
      that puts the schema first, so `psql` users can still apply the
      files and later migrations need no placeholders. Only the self
      foreign key's `"public"` is replaced. Placeholders in every
      migration would have made the SQL files unusable without rendering.
    - `migrate` does not move an installation. A fresh install into a
      named schema throws `"CONFIG"` (`INSTALLATION_ELSEWHERE`) while the
      bare table name resolves to another schema, so adding `schemaName`
      to an existing app does not silently start an empty installation.
      The guide shows the `ALTER TABLE … SET SCHEMA` move; a second
      installation next to one on `search_path` comes from
      `mnemocyte sql --schema` and is adopted. An opt-out flag stays out
      until someone needs it.
    - Without `schemaName` the SQL is the text 1.1 sent and no migration
      was added, so 1.1 and newer clients share an installation in either
      deploy order.
52. **drizzle-kit owns a generated schema** (2026-11-16, landed): the
    maintainer chose, with `feat/drizzle-schema-export`:
    - `mnemocyte generate --adapter drizzle` writes `mnemocyte-schema.ts`
      (`--out` for another path). It replaces only a file that starts with
      its own header, says when nothing changed, and creates a new file
      with `wx`. It also refuses its own file when the embedding size or
      schema differs, because drizzle-kit would `ALTER` the column or move
      the tables while the installation row keeps the old size.
    - The size, text search configuration and schema come from the flags
      or the memory file, exactly as for `sql`. It never reads a database.
      For an existing file the configuration is the one in its
      `content_tsv` line unless `--text-search-config` is passed, because
      `english` over a `simple` file makes drizzle-kit drop and re-add the
      column (fix/drizzle-generate-keep-config).
    - drizzle-kit owns these tables: no `mnemocyte_migrations`, and
      `mnemocyte migrate` is not run on them (it would adopt, then apply
      the next migration that drizzle-kit also applies). Upgrades are
      `generate` again, then `drizzle-kit generate`. The other split,
      drizzle-kit creating and `migrate` upgrading, would make every
      upgrade's `drizzle-kit generate` emit a duplicate `ALTER` to delete
      by hand.
    - The output is plain text: no code imports drizzle-orm. It targets
      the optional peer's range (`^0.45.4`); drizzle-kit 0.31.11 is a dev
      dependency only, for the tests. drizzle-orm 1.0 is a release
      candidate and waits until it is stable.
    - drizzle-orm cannot express three parts of `fresh-install.sql`, so the
      command prints them as SQL for two custom migrations
      (`drizzle-kit generate --custom`): pgvector before the tables, and
      the `NULLS NOT DISTINCT` partial unique key index plus the
      `installation` row after them. `nullsNotDistinct` exists only on
      unique constraints in 0.45.4 and 1.0.0-rc.5, and a constraint cannot
      have the `WHERE "key" IS NOT NULL` that the `ON CONFLICT` arbiter
      needs. Writing those files into drizzle-kit's folder would mean
      writing its journal, whose format changes in 1.0.
    - `drizzle-kit push` is documented as unsupported: it drops the key
      index, which is not in the schema files (a test shows it).
    - A new text search configuration is a drop and add of `content_tsv`
      in drizzle-kit, which loses the GIN index while its snapshot still
      lists it. `generate` notices the changed expression and prints the
      `CREATE INDEX` and `ANALYZE` to append to that migration; a test
      applies both and compares the catalog with a fresh install.
53. **Repository layout** (2026-11-20, landed): the maintainer chose, with
    `chore/repo-tidy`. The last two points landed there, the rest with
    `chore/workspace-layout` (2026-11-21), which kept `docs/`,
    `CHANGELOG.md` and `migrations/` where this list puts them; see
    DEVELOPMENT.md, "Structure". The one change: `scripts/check-links.ts`
    stays in a root `scripts/` folder, since it checks the whole
    repository's Markdown, not the package (decision 75).
    - The root keeps only what is about the whole repository: `apps/`,
      `packages/`, `examples/`, `docs/`, `.github/`, `.vscode/`, the
      dotfiles (`.gitignore`, `.gitattributes`, `.editorconfig`),
      `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
      `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `biome.json`, the private
      workspace `package.json`, `pnpm-workspace.yaml` and
      `pnpm-lock.yaml` (and, from decision 91, a `tsconfig.json` for the
      root `scripts/`).
    - The published package moves to `packages/mnemocyte/` with its
      `src/`, `test/`, `migrations/`, `scripts/` (but `check-links.ts`)
      and build, test and
      TypeScript configs; the site moves to `apps/site/`. `@mnemocyte/mcp`
      then lands as `packages/mcp/`. Libraries go under `packages/`, things
      that are run or deployed under `apps/`.
    - `examples/` stays at the root, where GitHub readers look for it, and
      becomes a workspace package that depends on `"mnemocyte":
      "workspace:*"`, the way an app installs it.
    - `CHANGELOG.md` stays at the root; whether `@mnemocyte/mcp` gets a
      changelog of its own is asked in `feat/mcp-server` (it does,
      decision 84).
    - The move is its own PR, `chore/workspace-layout`, right before
      `feat/mcp-server`, so the MCP PR changes only MCP.
    - Inside `src/`, the entry files stay at the root (tsdown names the
      output after them) and their private modules sit in a folder:
      `src/ai-sdk/` for the AI SDK entry, `src/embedders/internal/` for
      the shared HTTP embedder code. tsdown builds every file matching
      `src/embedders/*.ts` as an export, so shared embedder code never sits
      directly in `src/embedders/`.
    - `.claude/` (local agent settings) is gitignored, and the committed
      `.vscode/settings.json` hides build output and local results such as
      `bench-results/` from the explorer.
54. **CI runs the jobs a PR's files need** (2026-11-21, landed): the
    maintainer chose, with `chore/ci-paths`, one `ci.yml` whose first job
    diffs the PR and sets an output per job group, job-level `if`s, and a
    final `CI ok` job, over a separate `site.yml` with built-in
    `on.pull_request.paths`. Built-in path filters skip whole workflows,
    so the split could only separate the site from the library: a
    `README.md` or `test/**` change would still run the package lint and
    the four Postgres jobs, and per-job lists would need four workflow
    files, three `uses:` jobs in the release and a badge per file. One
    workflow keeps the lists in one file, the README badge, the release's
    `uses:` and the docs on `ci.yml`, and gives a single `CI ok` check for
    a future ruleset (a skipped workflow's checks stay Pending; a skipped
    job reports success). The cost is a bash step that must learn new
    top-level paths, and one short job (a runner and a two-commit
    checkout) before the others start.
55. **All four Postgres jobs on pull requests** (2026-11-21, landed): the
    maintainer chose, with `chore/ci-matrix`, to keep Postgres 17 and 18
    with postgres.js 3 and 4 on every PR that changes their files, over
    running only Postgres 18 with postgres.js 4 on PRs and the full matrix
    on `main`. The four jobs run in parallel in 1 to 1.5 minutes, shorter
    than the slowest Node job, so the smaller set would not make a PR's CI
    finish sooner. The repository is public, so standard runners cost no
    Actions minutes. A bug that shows on one driver or server version
    would first fail on `main`, after the merge.
56. **github-slugger for Markdown anchors** (2026-11-21, landed): the
    maintainer chose, with `chore/docs-links`, `github-slugger` 2 as a
    dev dependency for the anchors `scripts/check-links.ts` checks, over
    slug rules written by hand and the lychee binary. GitHub documents
    only basic rules, and `github-slugger` aims to match GitHub's anchors
    and is what rehype-slug uses; it is ESM with no dependencies, and it
    never reaches the npm tarball. Hand-written rules would let the Links
    job skip `pnpm install`, but the Unicode edge cases (symbols such as
    `→`, emoji) would be ours to keep right. lychee checks Markdown
    anchors with `--include-fragments`, but its docs call its slugs
    "similar to" GitHub's, not the same, and it is a downloaded Rust
    binary in CI. The cost is an install step in the Links job (1 to 4
    seconds from the store cache).
57. **The release removes a stale `next`** (2026-11-21, landed): the
    maintainer chose, with `chore/release-checks`, to turn on "Allow npm
    dist-tag" for the trusted publisher so the publish job can run
    `pnpm dist-tag rm mnemocyte next` after a final release, over keeping
    it a manual step. The option is off by default and separate from
    publish access; it lets `release.yml` in the `npm` environment add,
    move or remove this package's tags. pnpm 12.12.1 and newer does the
    OIDC exchange for `dist-tag` itself, so the runner's npm (11.19.1 on
    Node 24.22.3, below the 11.21.0 npm needs) is not involved. The step removes
    `next` only when it is not ahead of the release, and only warns on
    failure, because the version is already published and a re-run would
    fail on the publish. The cost is a wider token: a compromised publish
    job could also move or remove tags, though it could already publish a
    new version under `latest`.
58. **Actions pinned to commit SHAs, updated by Dependabot** (2026-11-21,
    landed): the maintainer chose, with `chore/release-checks`,
    full-length SHA pins with the release in a comment in `ci.yml` and
    `release.yml`, and Dependabot for `github-actions` only with a 7-day
    cooldown, over a workflow lockfile (`.github/workflows/actions.lock`).
    GitHub's "Secure use reference" ranks the lockfile first, but its
    main gain over SHA pins is pinning transitive actions, and
    `actions/checkout`, `pnpm/action-setup` and `actions/setup-node` are
    JavaScript actions that use none. The lockfile needs the
    `gh actions-lock` extension for every `uses:` change and a `--verify`
    check in CI, and its docs do not say it is generally available. SHA
    pins are readable in the YAML and meet GitHub's "Require actions to
    be pinned to a full-length commit SHA" policy. The costs: Dependabot
    alerts skip SHA-pinned actions, a Dependabot PR every week or so, and
    SHA diffs that need the comment to read. Revisit when the lockfile is
    generally available or an action becomes a composite action that
    uses other actions.
59. **The release's CI run skips the Site job** (2026-11-21, landed): the
    maintainer chose, with `chore/release-checks`, a `release` input on
    `ci.yml`'s `workflow_call` that `release.yml` sets and the `Changes`
    job reads, over running every job on the tagged commit. The site is
    not in the npm tarball, and its only input from outside `site/`,
    `CHANGELOG.md`, was checked on the release PR and on the push to
    `main`, so a site failure should not block a publish. `Links` stays,
    since `README.md` ships in the tarball.
60. **Contract tests start PGlite from a saved data folder** (2026-11-21,
    landed): with `chore/contract-time`, the `contract` project's global
    setup saves one initialized PGlite data folder and every contract
    database starts from it with `loadDataDir`, over resetting one
    migrated PGlite per file between tests or `clone()`. Without
    `loadDataDir` PGlite runs initdb on every start (about 0.75 s, against
    0.2 s for a load and 30 ms for `CREATE EXTENSION` plus `migrate`), and
    the files that open a database per test need different starting
    points (no extension, an older schema, another schema name, a text
    search configuration), which a reset would have to undo table by
    table. In PGlite 0.5.16 `clone()` is `dumpDataDir("none")` plus a
    `loadDataDir` start, so it costs the same and needs a running source,
    one more initdb per test file. The five PGlite runs of the store
    contract also moved to a file each, since one file runs on one
    worker.
61. **The store contract shrinks to 16 methods** (2026-11-21, landed): the
    maintainer chose, with `refactor/store-contract`, 16 required methods
    over the "Layers" sketch of about ten. `vectorSearch` and
    `lexicalSearch` became `searchCandidates`; `getMemory`,
    `getMemoryByKey` and `loadConsolidationTargets` became `get`;
    `deleteMemory`, `deleteScope` and `prune` became `delete` with a
    `target`; `findDuplicatePairs` and `findDuplicatePage` became
    `findDuplicates` with a `mode`, so `experimental.findDuplicatesPage`
    keeps no store method of its own. `markAccessed` and `pruneAudit` stay
    apart rather than folding into `update` and `delete`: an access bump
    never sets `updatedAt` and touches many ids, and audit retention
    commits in batches, so either would blur the contract it joined.
    Duplicates stay in the store, since the core could find them only with
    one search per memory. The sketch's `appendAudit` is dropped: audit
    events are written by the statement they record. `inspectInstallation`,
    `setTextSearchConfig` and `ensureEmbeddingCompatibility` stay required
    for now; making them optional for third-party backends is left to
    `feat/public-store-contract`, where such backends appear, rather than
    putting fallbacks in the lazy store and four callers today. Every
    method takes one input object, so the contract follows the
    single-object rule before it becomes public. The in-memory backend
    declares `lexicalSearch: "overlap"`, a value added to the sketch's
    union: its keyword score is query-term overlap, and `"none"` would
    switch its lexical list off and change results. It declares
    `locking: "database"` because each call runs to completion without
    interleaving, and `maxDimensions: Number.POSITIVE_INFINITY`. Postgres
    declares `"approximate"`, `"iterative"`, `"ts_rank"`, `"row"` and 4,000.
    No warning reads capabilities yet: neither backend would trigger one,
    and a warning channel would be new public API. Renaming methods breaks
    a store from an older installed copy of the package passed to this
    copy's `createMemory`; it now fails at once with `"CONFIG"`
    (`assertStoreContract`), while `migrate()` and the CLI, which use only
    methods that kept their shape, still accept it.
62. **libSQL entry and clients** (2026-11-21, landed): the maintainer
    chose, with `feat/libsql-store`, `libsqlStore({ client })` at
    `mnemocyte/libsql` and `createMemory({ store: client })` /
    `migrate({ store: client })` with the client itself, as decisions 21
    and 23 do for Postgres. The client is an `@libsql/client` `Client` from
    any entry point and URL, or a Drizzle instance over one
    (`drizzle-orm/libsql` sets `db.$client`), recognised by `execute`,
    `batch`, `transaction`, `executeMultiple` and a string `protocol`.
    `@libsql/client` `^0.18.0` (2026-09-02) is an optional peer and a dev
    dependency. The backend runs on its own adapter over the client, not
    on `SqlExecutor`: libSQL takes `?NNN` placeholders and SQLite SQL,
    which a Postgres-shaped executor would only disguise. Turso's
    rewritten-engine clients (`@tursodatabase/database`,
    `@tursodatabase/serverless`) are left out: their docs list no vector
    functions. `MnemocyteBackend` gained `"libsql"`, which "Stability"
    allows in a minor. `libsqlStore` takes no `schemaName`.
63. **libSQL vector search is exact, and nothing warns on postfilter**
    (2026-11-21, landed): the maintainer chose, with `feat/libsql-store`,
    an exact scan over the rows the scope index selects
    (`vector_distance_cos`, filters first) over the planned DiskANN index.
    `vector_top_k` has no filter argument; the documented pattern joins
    after it, and it ranks the whole table, while a Mnemocyte table holds
    every user's memories, so for one user among many the top k would
    mostly belong to others and the result would be empty, not just short.
    Taking more candidates only makes that less likely. Capabilities are
    therefore `"exact"`, `"prefilter"`, `"bm25"`, `"database"` and 65,536.
    With no backend at `"postfilter"`, no warning was added and no channel
    became public API; if an index lands with it, the warning would be a
    field on the `search` success event of `onEvent` (vector candidates
    returned against requested), not `console.warn`. The scan's cost
    grows with the scope: about 0.5 s at 10,000 memories of 1,536
    dimensions on a local file (features/libsql.md has the table); the
    index waits in ROADMAP.md ("Later").
64. **FTS5 with porter, terms quoted and joined with OR** (2026-11-21,
    landed): the maintainer chose `porter unicode61 remove_diacritics 2`
    as the default tokenizer, matching Postgres's `english` default, and
    `unicode61 remove_diacritics 2` as the other choice, named `porter`
    and `unicode61` in `textSearchConfig`. Each whitespace-separated query
    term is an FTS5 string with `"` doubled, so operators and syntax in
    user text are words; terms are joined with `OR`, because FTS5 has no
    stop words and requiring every term would drop rows over "the";
    `bm25` ranks rows with more and rarer terms higher. At most 64 distinct
    terms. The score is `-bm25()`. `setTextSearchConfig` and
    `mnemocyte text-search` rebuild the FTS5 table in one write batch
    rather than being left out: unlike Postgres, no memory row is
    rewritten.
65. **Shared contract expectations come from capabilities** (2026-11-21,
    landed): the maintainer chose, with `feat/libsql-store`, one shared
    contract (`test/contract/shared.ts`) that every database backend runs
    through the public client, with the Postgres-only checks left in
    `suite.ts`. A check that a backend's declared behaviour changes reads
    `capabilities` from the store: a selective filter keeps the vector
    list full unless `filteredVectorSearch` is `"postfilter"`. Search
    results are compared as sets or by membership in the top k, never by
    a full order, since `ts_rank`, `bm25` and overlap scores differ.
66. **`F32_BLOB` up to 65,536 dimensions, sent as blobs** (2026-11-21,
    landed): the maintainer chose `F32_BLOB(N)` at every size, the type
    Turso's docs suggest starting with, and `maxDimensions` 65,536,
    libSQL's documented limit. `migrate()` now checks `dimensions`
    against the store's `maxDimensions` after resolving the store (still
    4,000 on Postgres and for the CLI's `--dimensions`). Vectors go to
    libSQL as float32 blobs rather than JSON text, which it parsed again
    for every row a search compared (97 against 43 ms per 1,000 rows).
67. **libSQL writes are single write batches** (2026-11-21, landed): every
    multi-statement write is one `batch(…, "write")` (`BEGIN IMMEDIATE`)
    whose first statement reads what the later ones check and repeat as
    conditions, so SQLite's missing data-modifying `WITH` and
    `FOR UPDATE` need no interactive transaction. On a local file an
    interactive transaction made concurrent writes fail at once with
    `SQLITE_BUSY` (9 of 10 in a probe, a busy timeout did not help:
    the driver is synchronous), while batches serialize. Only `migrate`
    uses a transaction.
68. **CI runs libSQL on files; a server run is manual for now**
    (2026-11-21, landed): the maintainer chose `@libsql/client` on a
    temporary `file:` database in the `contract` project, so every Node
    job runs it without a service; not `:memory:`, whose single connection
    rejects calls while a transaction holds it. The shared contract ran
    once by hand on a libSQL server
    (`ghcr.io/tursodatabase/libsql-server:d6c75af`; its newest tags are
    commit SHAs)
    through `test/integration/libsql-remote.test.ts`, which found that the
    server's own SQL parser rejects aggregate `ORDER BY`; the SQL avoids
    it. A CI job is `chore/libsql-remote-ci` in ROADMAP.md.
    (2026-11-21, revised) CI now runs the server suite on every PR that
    changes its files, in a job of its own (decision 71).
69. **The CLI reaches libSQL through the memory file** (2026-11-21,
    landed): the maintainer chose `migrate`, `check` and `text-search`
    for libSQL, through a memory file only. `DATABASE_URL` stays
    postgres.js; `sql`, `generate --adapter drizzle` and `init` stay
    Postgres-only; `--schema` exits 2 with a libSQL store. `check` tells
    the backends apart by `sqliteVersion` in the report.
70. **Exact duplicates are computed in JavaScript** (2026-11-21, landed):
    `findDuplicates` on libSQL reads the scope's embeddings and runs the
    in-memory store's exact algorithm, now shared in
    `memory/duplicates.ts` and computing each pair once. In SQL,
    `vector_distance_cos` between two stored rows cost about 37 µs at
    1,536 dimensions: the self-join took 59 s for 1,000 memories, against
    1.2 s now. It still grows with the square of the scope, so large
    scopes use `experimental.findDuplicatesPage`.
71. **The libSQL server suite in a CI job of its own, pinned by digest**
    (2026-11-21, landed): the maintainer chose, with
    `chore/libsql-remote-ci`, a `libSQL server integration` job with a
    sqld service container, over a step in the Postgres jobs, which would
    run it four times (or tie it to one matrix cell) and report a server
    failure as a Postgres one. It runs on Node 24 only, since it tests
    the Hrana protocol and the server's SQL parser, not Node, and on the
    Postgres file list, since the suite reaches `test/fixtures/` and
    `test/helpers.ts` through the shared contract and `migrations/libsql/`
    through the bundle in `src/`. The image is
    `ghcr.io/tursodatabase/libsql-server:d6c75af@sha256:6dd3eb27…`: the
    upstream workflow tags each `main` build `latest` and a short commit
    SHA, its builds after `d6c75af` (2026-08-23) failed, so that tag is
    the newest and has the same digest as `latest`, and the digest keeps a
    rebuilt, re-pushed tag from changing the image. Dependabot documents
    `github-actions` updates for `uses:` references only, not service
    images, and SHA tags have no order to compare, so the pin is bumped by
    hand when `latest` moves (the check is in DEVELOPMENT.md). The image
    has no `curl` or `wget`, so the runner polls `GET /health` instead of
    a `--health-cmd`. The cost is one more runner and install per PR and a
    pin that only moves when someone looks. Revisit when upstream
    publishes versioned server tags again or the repository adopts an
    updater that tracks service-image digests.
72. **The public store contract is `MemoryStoreV1`** (2026-11-21, landed):
    the maintainer chose, with `feat/public-store-contract`, 12 required
    data methods and two optional ones. `migrate` and
    `ensureEmbeddingCompatibility` are optional: a store without schema has
    nothing to migrate, and the core answers as the in-memory store does
    (nothing applied, every embedder accepted). `inspectInstallation` and
    `setTextSearchConfig` stay out of V1, first-party only, over making
    them optional: `InstallationReport` (`pgvectorVersion`,
    `sqliteVersion`, `vectorType`) and `regconfig` names describe the
    Postgres and libSQL schemas, and publishing them would freeze those
    shapes under semver. Adding an optional member later is a minor;
    removing one is a major. The core supplies the fallbacks in one adapter,
    `fromMemoryStoreV1`, the way the AI SDK's `asLanguageModelV4` upgrades
    a `"v2"` or `"v3"` model (`ai` 7 accepts all three and throws
    `AI_UnsupportedModelVersionError` otherwise), so `client-core`,
    `migrate()` and the CLI keep calling required methods, which answers
    decision 61's concern about fallbacks in four callers. A store comes
    in through `defineMemoryStore({ store })`, a store config like
    `postgresStore()`'s, over detecting a store by shape in `createMemory`:
    it keeps the `store` union and the root entry as they are, and checks
    the store when the app starts. The envelope carries the raw V1 store
    under a `Symbol.for` key of its own, and the copy of the package that
    runs the client adapts it, so a store defined through another
    installed copy works, and a copy from before V1 rejects it with
    `"CONFIG"` instead of calling missing methods. An unknown
    `specificationVersion` is `"CONFIG"` with `"INVALID_OPTION"`, not a new
    reason: there is nothing for a caller to do but update. The internal
    name stays `MemoryStore`, now `MemoryStoreV1` plus `backend`,
    `schemaName`, `custom` and the two first-party methods. The V1 types are
    the declarations, named `MemoryStoreV1…` as `@ai-sdk/provider` names
    `LanguageModelV4…`, so a V2 can sit next to them; the backends keep
    their `Store…` names as aliases. `MnemocyteBackend` gained `"custom"`
    (open per "Stability"), and V1 stores declare a `name` for the CLI's
    messages. Helpers for JavaScript backends (audit event builders,
    visibility predicates, exact duplicate search) are left out until a
    backend author asks for them (ROADMAP, "Later").
73. **The contract suite ships on Vitest** (2026-11-21, landed): the
    maintainer chose, with `feat/public-store-contract`, `vitest` `^5.0.0`
    as an optional peer that `mnemocyte/store/test` imports at runtime,
    over a runner-agnostic suite that takes `describe`, `test` and
    `expect` from the caller: the fixtures use many Vitest matchers
    (`toMatchObject`, `rejects`, `expect.arrayContaining`), which a
    structural type would have to restate, and the repository's tests use
    Vitest `expect`. better-auth makes the same choice
    (`@better-auth/test-utils/adapter`, `vitest` `^4 || ^5` as a required
    peer). The range is `^5` only because that is the version tested. The
    suite and the fixtures it runs moved from `test/` to `src/store-test/`
    so they build with the package and share its chunks;
    `describeMemoryStoreContract({ name, store, failAuditWrites })` is the
    one entry point, `store` a function called inside the tests (after the
    caller's hooks), and the audit rollback test skips without
    `failAuditWrites`. The first-party runs call the same
    `registerSharedContract` with their own namespace cleanup. The tests it
    runs are outside semver, so a minor may add some; its options and
    exports are covered. `require()` of the entry works once `vitest` is
    installed, since require(esm) reaches Vitest's ES entry.
74. **One README, copied into the package at pack time** (2026-11-21,
    landed): the maintainer chose, with `chore/workspace-layout`, the root
    `README.md` as the only source, with relative links, and a `prepack`
    script (`scripts/copy-readme.ts`) that writes a gitignored copy into
    `packages/mnemocyte/` with every relative link turned into a
    `https://github.com/Meenic/mnemocyte/blob/main/…` URL, over
    `repository.directory` plus absolute links written by hand. GitHub
    shows a README only from `.github/`, the root or `docs/`, and resolves
    its relative links from that file; npm shows the tarball's README, and
    npm's docs say only that it renders it as GitHub Flavored Markdown,
    not how relative links resolve. Hand-written absolute links would also
    leave `test:links`, which skips URLs. Links point at `main`, like the
    URLs in `src/`, so a docs fix reaches npm readers without a release;
    the cost is that npm can show docs ahead of an older installed
    version. `repository.directory` is set anyway, as npm documents for
    monorepos. `LICENSE` is copied the same way: pnpm's `publish` page
    says it packs the workspace root's `LICENSE` when a package has none,
    but its `pack` page does not, and the `package` tests run `pnpm pack`.
    `pnpm pack --dry-run` lists the same 79 files as before the move. The
    copies stay after a pack, because `--dry-run` runs `prepack` but not
    `postpack`.
75. **Root scripts pass through to the package** (2026-11-21, landed): the
    maintainer chose, with `chore/workspace-layout`, a private root
    `package.json` whose scripts call `pnpm --filter mnemocyte <script>`
    for the commands in `AGENTS.md`, `CONTRIBUTING.md` and CI (`build`,
    `checktypes`, `test:ci`, `test:checks`, `test:integration`,
    `lint:package`, `pack:check`, the benches and a few more), over moving
    every caller behind `--filter`. The commands keep their names, so CI
    steps, docs and habits do not change, and `pnpm test` at the root runs
    `test:links`, the package's `test` and `test:examples`. Scripts about
    one file (`test:prune`, `test:exports`) stay in the package only.
    `lint`, `lint:fix` and `format` run Biome over the whole repository
    from the root, as before, and `test:links` runs the root
    `scripts/check-links.ts`, with `github-slugger` and Biome as the
    root's only dev dependencies (decision 91 adds `typescript` and
    `@types/node` to type-check it). `@mnemocyte/mcp` adds pass-throughs
    under its own names when it lands (landed: `build:mcp`,
    `checktypes:mcp`, `test:mcp`, `lint:package:mcp`, `pack:check:mcp`,
    and `build`, `checktypes` and `test` cover both packages).
76. **Neon's HTTP driver is a built-in client** (2026-11-22, landed with
    `feat/neon-http-driver`): the maintainer chose to recognise the
    `neon()` function and a Drizzle `neon-http` `db` rather than leave them
    to a hand-written `SqlExecutor`. Decision 16 already keeps every write
    path to single statements or a `batch`, so only `migrate` and
    `setTextSearchConfig` need an interactive transaction; the adapter is
    `query` plus `batch`. In `@neondatabase/serverless` 1.x the function
    has `query`, `unsafe` and `transaction` and no `begin` or `savepoint`,
    so it cannot be taken for postgres.js. CI tests it through
    `ghcr.io/timowilhelm/local-neon-http-proxy` in front of the pinned
    Postgres image, the setup Neon's local-development guide documents,
    pinned by digest as in decision 71; a Neon project with a CI secret
    would test the real service but ties every PR to an account, and unit
    tests with a fake would not catch a difference in results. The proxy
    is a community project with no releases, so the pin moves by hand.
    (2026-11-23, landed) The maintainer chose, with the PR: the job runs
    on `pgvector/pgvector:0.8.7-pg17` only, the version Neon's guide uses,
    since nothing says the proxy (built 2026-03-27) was tried with 18; a
    job of its own (`Neon HTTP integration`, Node 24, the Postgres file
    list), as decision 71 did for sqld, over a step in the Postgres
    matrix, which would run it four times and report a proxy failure as a
    Postgres one; and until `feat/cli-migrate-direct-connection`,
    `migrate` and `setTextSearchConfig` (dry runs included) keep throwing
    `"CONFIG"` on a store without `transaction`, with a message that names
    Neon's `neon()` and the ways out (Neon's `Pool`, or the CLI without a
    memory file), rather than opening a connection (the `neon()` function
    does not expose its connection string, and the client creates no
    connections) or migrating through `batch` (each step reads the
    tracking table under an advisory lock first). The proxy starts with
    `docker run` after Postgres is healthy rather than as a service,
    because it runs `psql` once at start and exits on failure. The peer
    range is `>=1.0` as the roadmap item set it, and
    `@neondatabase/serverless` 1.0.0 handles `query`, `transaction` and
    `fetchOptions` as 1.2.1 does. The rest is in
    [features/postgres.md](./features/postgres.md#client-detection) and
    DEVELOPMENT.md ("What CI runs").
77. **`migrate` opens its own connection for HTTP stores** (2026-11-22,
    landed with `feat/cli-migrate-direct-connection`): the maintainer chose
    this over a clear error. When the memory file's store has no
    `transaction`, the CLI connects with a Neon `Pool` on
    `DATABASE_URL_UNPOOLED` (set by Neon's Vercel integration), falling
    back to `DATABASE_URL`, for a Neon store, and with the `postgres`
    package as it does without a memory file otherwise. Dimensions, schema
    name and text search configuration still come from the memory file, so
    the app and the migration agree. `migrate({ memory })` in code keeps
    throwing for such a store: it cannot know a connection string.
    The memory file holds no text search configuration (it is an input of
    `migrate()` and `setTextSearchConfig()`, read back from the
    installation), so that part still comes from `--text-search-config`
    and the installation. (2026-11-24, landed) The maintainer chose, with
    the PR: with neither variable set the command exits 2 and names them,
    opening nothing, as it does for a missing driver package; since
    `neon()` hides its URL, the CLI compares `inspectInstallation()`
    through both connections before any change (exit 2 when they differ,
    nothing changed) and again after a real run (exit 1 when the app's
    client does not see the change), because a new Neon branch and its
    parent look the same until then, over a sentence in the guide only,
    which would let a wrong `.env.local` migrate another branch silently;
    `check` keeps reading through the app's client, since it only reads
    and that client is the one the app runs on; and a connection failure
    stays exit 1, as `migrate` on `DATABASE_URL` already is, named by the
    variable and never the URL. The store says what it needs through the
    internal `MemoryStore.directConnection` (`"neon"` or `"postgres"`), and
    `--json` plans gained `connection`. The rest is in
    [features/cli.md](./features/cli.md#stores-without-transactions).
78. **The CLI reads `.env.local` before `.env`** (2026-11-22, queued as
    `feat/cli-env-files`): the maintainer chose Next.js's order for these
    two files, skipping `.env.local` when `NODE_ENV` is `test` as Next.js
    does, and set variables still win. The `.env.$(NODE_ENV)` files are
    left out: the CLI runs outside a mode, and guessing one would pick a
    file the user did not mean. `--env-file` still replaces both.
    Landed with `feat/cli-env-files` (2026-11-24); the maintainer took
    these recommendations:
    - **Shared:** the order is `loadEnvFiles` in `@mnemocyte/loader`, used
      by both bins, which keep their own `--env-file` branch since their
      errors differ (`CliError` against `UsageError`), as decision 93 kept
      the load errors per package. `process.loadEnvFile` keeps a variable
      that is already set, so loading `.env.local` first makes it win
      over `.env`. Node's docs state this only on `main` since
      nodejs/node#67276 (2026-11-07), not yet in the 22, 24 or 26 docs,
      so the loader's tests hold it on each CI Node version. Only the
      real environment's `NODE_ENV` counts.
    - **`init` and a defined key:** a key either file defines is left as
      is, since an empty line added to `.env.local` would hide a key in
      `.env`. The output names the file that defines it, `.env.local`
      first; the key goes to `.env.local` when it exists, else to `.env`.
    - **`.gitignore` note:** checks the file `init` wrote to, with Git's
      `*` and `?` on a root-level line (`.env*`, `.env*.local`,
      `*.local`); negations are not followed.
    - **Saying which files were read:** `mnemocyte-mcp`'s startup line on
      standard error ends with them (`env .env.local, .env`, or `env
      none`), since MCP clients do not say which folder they start a
      server in. The CLI prints nothing new, so its output and `--json`
      stay as they were.

    Found while building: Next.js expands `$VAR` in its env files and
    Node's parser does not, so such a value reaches the CLI as written;
    the CLI guide lists it as a limit.
79. **The installation's size comes from the column** (2026-11-22, queued
    as `feat/installation-from-catalog`): the maintainer chose to read the
    embedding size and vector type from the embedding column's type
    modifier when the `mnemocyte_meta` row is missing, as the migration
    runner and `inspectInstallation` already do, and to write the row when
    the model is first recorded. A row is data, not schema, so this keeps
    the rule that the client creates no extensions, tables or indexes, and
    drizzle-kit installations lose one hand-written step.
80. **The key index becomes an expression index** (2026-11-22, queued as
    `feat/scope-key-expression-index`): the maintainer chose
    `(namespace, entity_id, coalesce(agent_id, ''), coalesce(session_id,
    ''), key) WHERE key IS NOT NULL`, the libSQL backend's shape, over
    storing `''` for a missing agent or session. Postgres infers a partial
    expression index as an `ON CONFLICT` arbiter when the target repeats
    its expressions and predicate, and scope fields are validated
    non-empty, so `''` cannot collide with a real value. drizzle-orm has
    `nullsNotDistinct` only on constraints, but can declare this index with
    `.on(...)` over SQL expressions and `.where(...)`. Storing `''` would
    rewrite the table and break clients on the previous version, which
    still insert `NULL`. The old index stays for one minor release, so
    those clients keep their `ON CONFLICT` target during a deploy; a write
    then maintains two indexes. This does not make `drizzle-kit push`
    safe: drizzle-orm issue #6386 (open, labeled fixed in beta) reports
    that push drops and re-creates an index mixing columns and an
    expression on every run, so push waits for drizzle-orm 1.0 (decision
    52). drizzle-kit 1.0 also manages every schema by default, where 0.x
    manages only `public`, so a schema of its own does not hide the tables
    from 1.0's push.
81. **`server-only` loads as an empty module in the CLI** (2026-11-22,
    landed with `feat/cli-server-only`, details in decision 97): the
    maintainer chose to map that one specifier in the CLI's resolve hook
    over loading the memory file with React's `react-server` condition,
    which would change how every package with such an export resolves
    (React itself among them). `server-only`
    exports `react-server` to an empty file and throws by default.
82. **HTTP 529 is retried** (2026-11-22, queued as `fix/retry-529`): the
    maintainer chose to add 529 to the built-in retry statuses for every
    embedder, not just OpenRouter's. OpenRouter's embeddings docs name 529
    for an overloaded provider, though its error list does not, and the
    status means "overloaded" wherever it is used, so retrying it is as
    safe as retrying 503.
83. **OpenRouter model ids drop the vendor prefix** (2026-11-22, queued as
    `feat/openrouter-embedder`): the maintainer chose to report
    `openai/text-embedding-3-small` as `text-embedding-3-small`, as
    `aiSdkEmbedder` does for AI Gateway ids, so an installation can move
    between a provider's own API, OpenRouter and the AI SDK without
    re-embedding. The cost: OpenRouter can serve an open model from
    several hosts, and does not say which one answered, so vectors under
    one id may differ slightly between hosts; the guide shows pinning with
    `routing`.
84. **`@mnemocyte/mcp` has a changelog of its own** (2026-11-23, landed
    with `feat/mcp-server`): the maintainer chose
    `packages/mcp/CHANGELOG.md` over sections in the root `CHANGELOG.md`.
    The package has its own version line (0.x next to `mnemocyte` 1.x),
    and the release check looks a version's heading up in one file; one
    file with two version lines would need prefixed headings and a parser
    that tells them apart. The root changelog's introduction points to it
    rather than an `[Unreleased]` entry, since any `Added` entry there
    makes the next `mnemocyte` release a minor. The file does not ship;
    the package README links to it on GitHub.
85. **The server loads the app's memory file** (2026-11-23, landed with
    `feat/mcp-server`): the maintainer chose the CLI's memory file over
    `DATABASE_URL` and flags, so the server uses the app's own store and
    embedder and needs no embedder flags (provider, model, dimensions,
    key) that could disagree with the app's. The CLI's resolve hook and
    tsconfig reader are internal, so `packages/mcp/src/loader/` holds
    byte-for-byte copies, with a test that fails when they differ, over
    exporting a loader from `mnemocyte`, which would be public API that
    only tools use and would tie this package to a newer `mnemocyte`.
    (Revised by decision 93: the copy becomes a private package bundled
    into both, `chore/shared-loader`.)
    The client is recognised by shape (`for`, `search`, `add`,
    `delete`), not the CLI's internal symbol. Found while building: MCP
    clients do not document which folder they start a stdio server in
    (Claude Code sets `CLAUDE_PROJECT_DIR`, Cursor has
    `${workspaceFolder}`), so `--project <dir>` sets the folder for the
    lookup, `.env`, `--config` and `--env-file`.
86. **The scope comes from flags only** (2026-11-23, landed with
    `feat/mcp-server`): the maintainer chose `--entity-id` (required),
    `--namespace`, `--agent-id` and `--session-id` over environment
    variables. Every MCP client config takes `args`, which keeps the scope
    visible in one place; a variable could come from the shell that
    started the client and quietly change whose memories the server
    reads. Without `--namespace`, the memory file's default namespace
    applies, as in `memory.for`. As with `memoryTools`, no tool input
    takes a scope field, and one sent is a tool error.
87. **stdio only** (2026-11-23, landed with `feat/mcp-server`): the
    maintainer chose stdio for the bin over Streamable HTTP too. A fixed
    scope behind an HTTP port lets whoever reaches the port use that
    user's memories; the 2026-07-28 specification says HTTP servers must
    check `Origin` and should authenticate, and the scope would have to
    come from that authentication, which is a design of its own
    (ROADMAP). For stdio the specification says to take credentials from
    the environment, which `.env` and the client's `env` do. The package
    exports `createMemoryMcpServer({ memory })` without a transport, so
    an app can serve it over its own authenticated HTTP.
88. **Search and save by default, forget opt-in** (2026-11-23, landed
    with `feat/mcp-server`): the maintainer chose the `memoryTools` set
    with its names, inputs and outputs, with `forgetMemory` listed only
    under `--allow-forget` and `--read-only` for search alone. A deletion
    cannot be undone (consolidated duplicates go with it) and some MCP
    clients run tools without asking, while `memoryTools` users have the
    AI SDK's approval step. The tools carry the specification's
    annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
    `openWorldHint: false`) and return structured content with an output
    schema plus the same JSON as text. They are written again in the
    package, since `mnemocyte/ai-sdk` needs `ai`.
89. **Bin, version and release** (2026-11-23, landed with
    `feat/mcp-server`): the maintainer chose the bin name `mnemocyte-mcp`,
    a first version of 0.1.0 (the SDK's v2 line and the flags may still
    change) and releases of its own on `mcp-vX.Y.Z` tags through the same
    `release.yml`, which reads the package from the tag. npm configures a
    trusted publisher only for an existing package, so the maintainer
    publishes 0.1.0 by hand; the steps are in DEVELOPMENT.md
    ("Releasing"). The SDK is v2 (`@modelcontextprotocol/server` 2.4,
    the stable line for the 2026-07-28 specification), not the v1
    `@modelcontextprotocol/sdk`. The peer range is `^1.1.0`, not `^1`:
    `forgetMemory` uses `delete({ dependents })`, added in 1.1.0.
90. **Memory intelligence as a library** (2026-11-23): after a
    comparison of mem0, Mastra, Zep and Graphiti, Letta, Hindsight,
    Supermemory, Honcho, Cognee, LangMem, turbomem and db0, the
    maintainer took the recommendation to add model-driven memory
    features as opt-in library calls on the app's own model, not to
    become a memory server. Hindsight and Supermemory lead on what they
    do with memories (background consolidation, profiles, contradiction
    handling, published benchmark scores; Hindsight also searches by
    time and reranks), but run as services beside a TypeScript app
    (Hindsight starts in process only in Python) and extract facts with
    a model on their side. Mastra's memory runs in process on the app's
    database, but is built for Mastra agents. Mnemocyte's place is
    memory in the app's own database for any TypeScript framework (the
    "Memory intelligence" section above). A feature that changes what is
    saved or found is measured with the eval harness first. Scores are
    published with the method to repeat them, not as a ranking: each
    vendor's numbers come from different models, judges and retrieval
    budgets. The README keeps no comparison table (ROADMAP.md,
    "Discoverability").
91. **Scripts are TypeScript that Node runs** (2026-11-23, landed with
    `chore/typescript-scripts`): the maintainer chose to turn the ten
    `.mjs` scripts (the root `scripts/check-links`, seven in
    `packages/mnemocyte/scripts/`, two in `packages/mcp/scripts/`) into
    `.ts` files that `node` runs directly, and to type-check them, over
    keeping plain JavaScript that no config covered. Node strips types by
    default from 22.18, the `engines` minimum, with no warning there or
    from 24.3, and the examples already run that way. Node reads no
    `tsconfig.json` and refuses to strip types under `node_modules`, which
    no script needs. Every package's own `tsconfig.json` includes its
    `scripts/`, so a script is checked against that package's
    dependencies and `paths`, and `pnpm checktypes` needs no build for
    them; a single root config was rejected because `bench-libsql`'s
    `mnemocyte` import would then resolve to `dist/`. The root gets a
    `tsconfig.json` for its own `scripts/` and `typescript` and
    `@types/node` as dev dependencies, at the versions the packages
    already use. `erasableSyntaxOnly` is on in both packages'
    `tsconfig.build.json`, so `src/`, the tests, the scripts and the
    README and JSDoc examples all keep to syntax type stripping can
    remove; four parameter properties became declared fields for it, one
    in `src/memory/duplicates.ts` (an internal class) and three in the
    Postgres benchmark helpers. The `@mnemocyte/mcp` test fixtures became
    `memory.ts` too: the lookup of `memory.mjs` is tested on the CLI's
    copy (`packages/mnemocyte/test/cli/resolve.test.ts`), and
    `packages/mcp/test/loader-copy.test.ts` keeps the server's list of
    file names equal to it (since `chore/shared-loader`, one lookup in
    `packages/loader/`, tested there; decision 93). The migrations stay
    `.sql`: they ship in the tarball for teams that run them with `psql`
    (guide/postgres.md), and the bundle scripts generate the code copy
    from them. With the scripts the site's static reference
    (`apps/site/design/reference/`) went too; the built site is the
    reference now.
92. **One package stays** (2026-11-23, `docs/architecture-review`): after
    comparing how established libraries ship a core, backends and a CLI,
    the maintainer kept `mnemocyte` as one package with the CLI as its
    bin and the backends as subpaths, and kept decision 1's split rule.
    What their manifests on npm showed that day:
    - `drizzle-orm` 0.45.4 has no `dependencies` and 29 peers, all
      optional; every dialect is a subpath. `drizzle-kit` 0.31.11 is apart
      and depends on `esbuild`, `tsx`, `@esbuild-kit/esm-loader` and
      `@drizzle-team/brocli`; its docs install it with `-D`.
    - `prisma` 7.10.1 (42 MB unpacked, six dependencies including
      `@prisma/engines`) is the CLI, installed with `--save-dev`;
      `@prisma/client` has one dependency and `prisma` as an optional peer
      (`*`). npm's `latest` for `prisma` was 8.0.0-rc.35 that day.
    - `better-auth` 1.7.27 has 17 dependencies (its five
      `@better-auth/*-adapter` packages, `@better-auth/core`, `kysely`,
      `zod`, `jose`, …) and 18 optional peers. The 1.5 release post says
      the adapters were extracted because it "reduces bundle size and
      allows adapters to be versioned independently", yet the umbrella
      depends on all of them and they release in lockstep. The CLI moved
      from `@better-auth/cli` (deprecated on npm) to `auth` 1.7.27, run as
      `npx auth@latest`, with 21 dependencies (Babel, Prettier, `c12`,
      `jiti`, …) and `better-auth` pinned exactly.
    - `ai` 7.0.180 depends on `@ai-sdk/provider`, `@ai-sdk/provider-utils`
      and `@ai-sdk/gateway`; each provider (`@ai-sdk/openai` 4.0.122) is a
      package with a version line of its own, written against the
      published specification in `@ai-sdk/provider`. The docs explain the
      specification, not why providers are separate packages.
    - `@mastra/pg` 1.37.0 depends on `pg` and three more packages, with
      `@mastra/core` as its only peer. turbomem 0.8.4, a memory library,
      puts its CLI (`@turbomem/cli`: `commander`, `chalk`,
      `@clack/prompts`), MCP server and AI SDK adapter in packages of
      their own.

    Every CLI above that is a package of its own carries dependencies of
    its own, and so does `@mastra/pg`; the AI SDK's providers have a
    release line of their own. That is decision 1's rule. Better Auth's
    adapters are the exception: `@better-auth/drizzle-adapter` has no
    dependencies, only peers, and since the umbrella depends on every
    adapter, a `better-auth` install gets them all anyway. Mnemocyte's
    CLI and backends have neither dependencies nor a cadence of their
    own. Measured on `main` at `ef2e3dc` (package version 1.3.0; 1 KB =
    1,024 bytes):
    - Install size: the tarball is 513 KB, 2,043 KB unpacked in 79 files,
      1,236 KB of it source maps with their sources (DEVELOPMENT.md). Code
      only the bin loads is `dist/cli.mjs`, 85 KB plus a 160 KB map; every
      other chunk it loads is shared with a library entry. A
      `@mnemocyte/cli` would save about 245 KB on disk and nothing in an
      app's bundle, since apps do not import the bin.
    - Bundle size (Rolldown, minified, gzipped): an app importing
      `createMemory` starts at 14.8 KB, and 15.0 KB with
      `mnemocyte/postgres` or `mnemocyte/libsql`. The Postgres backend
      (17.8 KB, with the migration runner), the libSQL backend (12.7 KB)
      and about 5 KB of code they share are lazy chunks (decision 23). A
      bundler includes the code an app reaches, so package boundaries
      change neither number.
    - Version skew: the CLI imports 14 internal modules (the migration
      runner, table names, validation, store config, client internals).
      Split out, it would have to pin `mnemocyte` exactly, as `auth` pins
      `better-auth`, and running a newer CLI than the installed client
      would apply migrations that client does not know. In one package
      the CLI, the migrations and the client are one version by
      construction. A `@mnemocyte/postgres` would also be a dependency of
      the `mnemocyte` umbrella, which keeps the raw-client shortcut
      (decision 23, "Packaging" above), so every user would install it
      anyway.
    - Release work: each package adds a tag prefix, a changelog, a release
      check and a first publish by hand (decisions 84 and 89).
    - npm: one name to search for and one README; scoped packages would
      split the page and the download counts.

    The rule gains the CLI case: the bin moves to a package of its own
    only when it needs dependencies of its own, and then pins
    `mnemocyte` exactly. Nothing changes for users: no import path, bin
    or shipped file.
93. **One loader, bundled into both packages** (2026-11-23,
    `docs/architecture-review`, landed with `chore/shared-loader`): revises
    decision 85's copy. The maintainer chose a private workspace package,
    never published, for the code `mnemocyte`'s CLI and `mnemocyte-mcp`
    share to load a memory file (the resolve hook, the tsconfig reader
    and the list of memory file names). Both packages list it as a
    devDependency, and tsdown bundles it into their `dist/`. This was
    chosen over the tested copy, whose resolve hook `feat/cli-server-only`
    would change twice, and over a public export, which decision 85
    rejected. `feat/cli-env-files` changes the `.env` loading each package
    writes for itself, which can move into the shared package then (it
    did; see decision 78).
    tsdown 0.23.1 keeps `dependencies`, `peerDependencies` and
    `optionalDependencies` external and bundles everything else
    (`getProductionDeps` in its source; `deps.alwaysBundle` forces
    external ones in), so neither published package gains a dependency. Mastra does the same: `@internal/auth`,
    `@internal/voice` and the like are private workspace packages,
    devDependencies of `@mastra/core`, listed in its tsdown
    `deps.alwaysBundle`. `@mnemocyte/mcp` still needs a release to ship a
    loader change, as with the copy.
    Landed with `chore/shared-loader` (2026-11-24); the maintainer took
    these recommendations:
    - **Name and folder:** `@mnemocyte/loader` in `packages/loader/`,
      `"private": true`, version `0.0.0`, in the scope the maintainer
      already owns on npm. Its `exports` point at `src/index.ts`, with no
      build of its own: tsdown, tsc and Vitest read the TypeScript through
      the workspace link, so the root build order is unchanged. The link
      resolves to `packages/loader/src/`, outside `node_modules`, so
      tsdown bundles it as source and needs neither `deps.alwaysBundle`
      nor a `deps.onlyBundle` entry. pnpm refuses a private workspace
      package in `dependencies` (`ERR_PNPM_PRIVATE_WORKSPACE_DEPENDENCY`)
      and, when it packs, writes the dev dependency as `0.0.0`.
    - **What moved:** the resolve hook, the tsconfig reader, both lookup
      lists (`MEMORY_FILE_DIRECTORIES` with `MEMORY_FILE_NAMES`, since
      the search is one over the other) and `findMemoryFile`, which was
      the same in both packages. `locateMemoryFile`, the load error
      messages and reading the client stay in each package: they differ
      (`CliError` and exit codes against `UsageError`; the CLI's internal
      symbol against the public API). `.env` loading stays for
      `feat/cli-env-files`, which moved the file order here (decision
      78).
    - **Tests:** the loader's unit tests are in `packages/loader/test/`
      (`pnpm test:loader`), on each CI Node version in the Node jobs.
      Each bin's tests that run its built `dist/cli.mjs` on a TypeScript
      memory file stay where they were.
    - **Same code in both `dist/`:** comparing the bundled JavaScript is
      fragile, since rolldown names and orders modules per build. Both
      `dist/cli.mjs.map` files embed their sources, so a test in each
      package (`loader-bundle.test.ts`) checks that the loader files the
      map lists are exactly `packages/loader/src/` (the re-exporting
      index aside) with the same content. Built from the current source,
      the two bins carry the same loader; a stale build fails. A package
      test in each also checks that no library export reaches
      `registerHooks`. `packages/loader/**` joined the Node, Package and
      MCP change lists in CI, which matched none of it before.
94. **Migrations ship as they are** (2026-11-23, `docs/architecture-review`):
    the maintainer kept the numbered `.sql` files as the source, the
    generated `bundled.ts` committed next to the code, and the files in
    the tarball (decisions 9 and 91). How others ship schema, read from
    their sources and docs that day:
    - Graphile Worker 0.18 has the same shape: `sql/000001.sql` to
      `000020.sql`, `"files": ["dist", "sql"]`, and
      `scripts/buildSqlModule.mjs` writing a committed
      `src/generated/sql.ts` that `src/migrate.ts` imports, rerun in
      `prepack`.
    - pg-boss (its `main` branch, 12.40.0; npm has 12.39.0) keeps its SQL
      in TypeScript (`plans.ts`, and
      `migrationStore.ts` at 2,437 lines), ships no `.sql`, and prints it
      with `pg-boss plans`. Mnemocyte's
      `mnemocyte sql` prints a fresh schema the same way, and
      `feat/migrate-sql-plans` adds the upgrades.
    - Prisma Migrate and drizzle-kit write migrations into the app's own
      repository (`prisma/migrations/<timestamp>_<name>/migration.sql`;
      the docs say "You must commit the entire prisma/migrations folder"; `migration.sql` and `snapshot.json` per
      folder in drizzle-kit 1.0's docs). `mnemocyte generate --adapter
      drizzle` hands the tables to that flow (decision 52).
    - Mastra's `PostgresStore` creates and alters its tables when it
      starts unless `disableInit: true`, which its docs suggest for CI/CD
      that runs migrations separately. LangGraph's `PostgresStore` runs its
      migrations before first use, since `ensureTables` defaults to
      `true`. turbomem's `init()` runs `CREATE EXTENSION IF NOT EXISTS
      vector` and `CREATE TABLE IF NOT EXISTS`. Decision 20 rejects
      runtime schema changes.
    - Better Auth's `npx auth generate` writes a Prisma or Drizzle schema,
      or an SQL file for Kysely; `migrate` applies it only with the
      built-in Kysely adapter.

    Mnemocyte already has all three outputs: files (Graphile Worker),
    printed SQL (pg-boss) and an ORM schema (Better Auth). Shipping SQL
    only through the CLI would break the
    `node_modules/mnemocyte/migrations/` paths that guide/postgres.md
    documents for installing and upgrading with `psql`, to save 10,556
    bytes (the six files), so it would wait for 2.0
    and is not planned. libSQL ships no SQL files and installs only
    through `migrate` (features/cli.md, "Known limits"); that stays.
95. **The site and the folder names stay** (2026-11-23,
    `docs/architecture-review`): records the comparison behind decision
    53. The maintainer kept the layout as recommended. Sites, checked
    that day:
    - Better Auth's site is `docs/`, listed in its `pnpm-workspace.yaml`.
    - The AI SDK has `apps/docs` and `content/`, with `apps/*` in its
      workspace.
    - Mastra's site is `docs/`, listed in its workspace.
    - Drizzle's is a separate repository, `drizzle-team/drizzle-orm-docs`
      (CC-BY-4.0).

    The site renders `docs/guide/*.md` and `CHANGELOG.md` at build time
    (apps/site/design/BRIEF.md, section 2), so a docs fix and the site
    change land in one PR. A separate repository would need a sync step.
    Folder names:
    - Better Auth: `packages/better-auth`, and `packages/core` for
      `@better-auth/core`.
    - The AI SDK: `packages/ai`, and `packages/openai` for
      `@ai-sdk/openai`.
    - Mastra: `packages/core` for `@mastra/core`, and `stores/pg` for
      `@mastra/pg`.
    - Drizzle: top-level `drizzle-orm/` and `drizzle-kit/`.
    - turbomem: `packages/core` for the npm package `turbomem`, the one
      exception found.

    `core` names the folder of a package called core.
    `packages/mnemocyte` follows Better Auth and the AI SDK, and
    `apps/site` follows the AI SDK's `apps/`.
96. **Internal changes from the review** (2026-11-23,
    `docs/architecture-review`, queued as `chore/shared-scope-sql`):
    measured on `packages/mnemocyte/src` on `main` at `ef2e3dc` (111
    files, 30,654 lines):
    - Import cycles: none at runtime, static or through `import()`. Three
      come only through type imports, which the build erases:
      `types.ts` with `resilience.ts` and five `sql/` files,
      `ai-sdk/extraction.ts` with `ai-sdk/middleware.ts`, and
      `cli/args.ts` with `cli/init.ts`. Not queued.
    - Largest files: `types.ts` 2,073 lines (1,405 of them comments, 93
      exports, imported by 53 files), `db/queries/memories.ts` 1,624,
      `memory/validation.ts` 1,561 (38 exported functions),
      `db/libsql/queries.ts` 1,550, `memory/client-core.ts` 1,185.
      `types.ts` is mostly the public API's JSDoc, and splitting it would
      scatter one documented surface. `validation.ts` would only read
      better split up. Neither is queued.
    - Boundaries: `db/` imports from `memory/` only the contract types in
      `memory/store.ts`, and `retrieval/` only `cloneMemory`. The CLI
      reaches into 14 internal modules, which is fine inside one package
      (decision 92).
    - Duplicates: the Postgres and libSQL code repeats 14 runs of eight
      or more matching code lines (comments, imports and lone brackets
      skipped). The ones that matter are the scope predicates
      (`visibilityConditions`, `selectorConditions` and
      `exactScopeConditions`), which differ only in their parameter type
      and in the always-true literal (`TRUE` against `1`), the driver
      message trimming
      (`driverDetail`) and the consolidation conflict checks. The scope
      predicate is the rule every query depends on, so it should exist
      once: `chore/shared-scope-sql`. Covered by the contract suite on
      both backends; no behavior change. The rest of the queries differ in
      the SQL itself (`tsvector` against FTS5, HNSW against an exact scan,
      transactions against write batches), and one builder for both
      would be a query builder, which decision 4 rejected.
    - Store contract: `MemoryStoreV1` (12 required methods and 2
      optional) makes every backend implement scope visibility, audit
      writes atomic with their change, consolidation's write and
      duplicate search. The shared predicates are the internal code that
      the "Later" helpers for JavaScript backends would export
      (decision 72).

    Order: `chore/shared-loader` right after
    `feat/cli-migrate-direct-connection`, before `feat/cli-env-files` and
    `feat/cli-server-only`; `chore/shared-scope-sql` after the 1.5.0
    group, before
    the migration 0005 group. Neither needs a release of its own.
97. **How `server-only` maps** (2026-11-24, landed with
    `feat/cli-server-only`): carries out decision 81. The maintainer took
    these recommendations:
    - **The empty module:** a file in each bin's `dist/`,
      `server-only.cjs`, which a `server-only-stub` plugin in each
      `tsdown.config.ts` writes and the resolve hook returns with
      `shortCircuit: true`. The maintainer chose it the same day, after
      the first choice failed CI: a synthetic `mnemocyte:server-only` URL
      with a `load` hook that returned empty source passed on Node 24 and
      26 but not on 22.18. There, any `registerHooks` load hook makes the
      ESM loader read CommonJS source (`defaultLoadSync`), and CommonJS
      that arrives with source runs with the translator's own `require`
      (`loadCJSModule`), which calls `CJSModule._resolveFilename` and
      skips resolve hooks. That broke `require("server-only")` in a
      `.cjs` file the memory file imports, and by the same path would
      skip the hook's tsconfig `paths` in such `require()` calls (read
      from the 22.18 source, not run). Node 24.22 uses the real
      `require()` there (nodejs/node#60380). A `data:text/javascript,`
      URL fails too: on Node 24 `import` loads it, but `require()` reads
      it as a file path (`ENOENT`). The cost is one more file in each
      tarball.
    - **When it applies:** always, before Node resolves, for the exact bare
      specifier and from any importer, `node_modules` included. Mapping
      only when Node fails would leave the common case broken: an
      installed `server-only` resolves, to the `index.js` that throws.
      Next.js handles the import itself and calls installing the package
      optional, so both cases are real. This is the one specifier the hook
      takes from Node, an exception to decision 36's "cannot change how
      an installed package resolves". Subpaths, relative imports and
      scoped look-alikes are untouched.
    - **`client-only`:** left to Node. Its exports map sends
      `react-server` to the file that throws and everything else to an
      empty `index.js`, so under Node's default conditions it already
      loads as nothing; an error that names it would add behavior the
      package has only under `react-server`.
    - **Output:** none. The import is expected in a Next.js app's server
      code, a line on every run would be noise, and the CLI's `--json`
      output and the server's startup line stay as they were. The guides
      say it instead.
98. **`init` imports the app's Drizzle client** (2026-11-24, landed with
    `feat/init-detect-app`): for a Next.js app on Drizzle, a second client
    in `memory.ts` means a second pool, or a second Neon driver, beside
    the app's. The maintainer took these recommendations:
    - **Finding it:** file names plus the text of each file, no parser.
      A TypeScript parser would be a new dependency, and an approximate
      one would still miss re-exports. Every file directly in `src/db`,
      `db`, `src/lib/db`, `lib/db`, `src/server/db` and `server/db`
      (create-t3-app writes `src/server/db/index.ts`), `db.*` and
      `drizzle.*` in `src`, `src/lib`, `lib`, `src/server` and `server`,
      and `db.*` in the root. Drizzle's get-started guides keep an
      unexported `const db` in `src/index.ts`, and only its Next.js + Neon
      tutorial exports one (`src/db/drizzle.ts`), so only exports count,
      and entry files are never read: importing one would start the app.
      A function that returns a client is not one.
    - **Next.js:** `next` in `dependencies` or `devDependencies`; an `app`
      folder alone is also Remix's. Folders only pick the place:
      `lib/memory.ts` beside a root `app` or `pages`, else
      `src/lib/memory.ts` when there is a `src`, else `lib/`. The file
      starts with `import "server-only"`, templates included, and the
      package is not added. An app outside Next.js keeps the root, as
      decision 37 set.
    - **Several clients, or one it cannot classify:** several exit 2 with
      nothing written and point to `--db`, since picking the first would
      decide which database memories go to and a template would create
      the client this item avoids. The drivers are `postgres-js`,
      `node-postgres`, `pglite`, `neon-http`, `neon-serverless` and
      `libsql` with its subpaths (libSQL too: the file only imports the
      client). Any other is skipped with a line, and `init` falls back to
      the templates as before.
    - **`--db <path>`:** a path only, like `--config`. It takes the file's
      only client, else the one named `db`, and exits 2 for a file it
      cannot read, one with no client, several without a `db`, or another
      driver. A `path#export` form would be syntax almost no one needs.
    - **Output:** one line for a Next.js app, one naming the client and
      its driver, `Wrote …, which imports it.`, a line per skipped client
      or unexported one, and, when `drizzle-orm` is listed and nothing is
      found, the places it read and `--db`. "Next" names the `process.env`
      variables the client's file reads that neither env file sets, and a
      PGlite client file without pgvector gets a note.
    - **The `"type"` note** (found while planning): create-next-app writes
      no `"type"`, so the note shows in most Next.js apps. Its own
      template writes `next.config.ts`, but an older app's
      `next.config.js` is CommonJS in Next.js's docs, which do not support
      `next.config.cjs`; with that file present the note says to rename
      it first.

    Also decided while planning: the import is relative and has no
    extension, except in a `"type": "module"` package whose tsconfig sets
    `module` or `moduleResolution` to a Node mode (or that has no tsconfig,
    outside Next.js), where TypeScript needs `.js`. `@mnemocyte/loader`
    gained `loadModuleOptions` for it, next to `loadPathMapping`. No test
    runs `migrate` on an `init`-written file over Drizzle `neon-http`; the
    Neon suite covers that store, and the package test covers the written
    file on PGlite.

99. **Releases publish from `main` after an approval** (2026-11-24,
    planned in `docs/release-automation`): 1.4.0 and `@mnemocyte/mcp`
    0.2.0 took about nine manual steps, and each new package adds a branch
    in `release.yml`, a tag prefix, a changelog link format, a
    DEVELOPMENT.md section and GitHub release rules. Compared on
    2026-11-24 (re-read the sources in each item's PR): Changesets (the AI
    SDK, Better Auth, the MCP TypeScript SDK, Mastra, Effect, TanStack
    Query, graphile-worker), release-please, a release commit on `main`
    (Vitest), a check for versions missing from npm (Drizzle, and the MCP
    SDK on top of Changesets), and tag pushes (Kysely, pg-boss and this
    repository). The maintainer took these recommendations:
    - **Not Changesets or release-please.** Changesets v3 (2026-08-11)
      writes a `## 1.4.0` heading and `### Minor Changes` sections into
      each package's own `CHANGELOG.md` (`get-changelog-entry.ts`; only
      the lines are customizable) and tags `pkg@version`, which breaks the
      Keep a Changelog layout, the site's changelog page and `verify`.
      Its Version PR, like release-please's PRs, runs no CI without a
      personal or GitHub App token, since `GITHUB_TOKEN` events start no
      workflows, and release-please writes the changelog from commit
      titles. Revisit Changesets at about five published packages with
      dependencies between them, or with regular outside contributors
      whose `[Unreleased]` entries conflict. This replaces decision 15's
      "several packages".
    - **Trigger:** a push to `main`. A plan job lists the packages whose
      version is not on npm, or has no tag or GitHub release yet; a failed
      npm lookup fails the job instead of meaning there is nothing to do.
      Only then do CI and the publish job run, and the publish job waits
      in the `npm` environment for the maintainer's approval (required
      reviewers work on public repositories on every plan; a run not
      approved within 30 days is cancelled). "Prevent self-review" stays off,
      since the maintainer's merge starts the run they approve. Tags and
      GitHub releases come from a later job with `contents: write` and no
      `id-token`. Approving is the release, not merging, and agents never
      approve. A failed publish is fixed by merging the fix: the next run
      publishes what is still missing, with no tag to delete.
    - **npm side unchanged.** A trusted publisher names the organization,
      repository, workflow file, environment and allowed actions, and no
      branch or tag, so `release.yml` and `npm` keep working from `main`
      (Sanity's packages publish from `refs/heads/main` with provenance).
      The file name must stay: npm cannot change an existing connection,
      and a new one defaults to staged publishing only. The environment's
      deployment rule moves from the `v*` and `mcp-v*` tags to `main`,
      and gains the required reviewer.
    - **Release text from the changelog:** the version's intro, each
      entry's bold lead-in under its heading, a link to the full section,
      and a compare link when the package has an earlier tag, with
      relative links made absolute. For `mnemocyte` that is what the
      site's changelog page shows. It retires the category format in
      DEVELOPMENT.md ("Release text"). Lead-ins must read on their own,
      so the six that do not end with a period get fixed and a check
      keeps new ones whole.
    - **Staged publishing later,** as its own item once a release has gone
      through this workflow. `pnpm stage publish` (Kysely publishes that
      way since 2026-07-17) leaves a version unpublished until the
      maintainer approves it on npmjs.com or with `npm stage approve`,
      with 2FA. The workflow can wait for that only until its job time
      limit runs out, so tags and releases would need a second run.
    - **A new package's first publish stays by hand** (DEVELOPMENT.md,
      "`@mnemocyte/mcp`"): npm's trusted-publisher page still assumes the
      package exists.
100. **The release scripts are a private workspace package** (2026-11-24,
    landed in `chore/release-prepare`): the maintainer took these
    recommendations for decision 99's first item.
    - **One changelog parser, shared with the site.** It lives in
      `@mnemocyte/release` (`packages/release/`, private, TypeScript
      source as `@mnemocyte/loader` is), and the site's changelog page
      reads its sections from `@mnemocyte/release/changelog` instead of
      its own mdast walk; both gave the same output on `main`'s
      `CHANGELOG.md`, this branch's and the site's fixture. The site's parser could not be imported as it was (it
      imports `next/cache`), and a second, line-based parser in
      `scripts/` could read lead-ins differently from the page the
      release text has to match. The package also holds the package list,
      which `release.yml` will read, and the commands, so they get a
      tsconfig and Vitest of their own, which the root `scripts/` lack.
    - **`release:prepare` applies the bump.** It proposes the version
      (minor for `Added` or `Deprecated`, else patch), writes the
      changelogs and runs `pnpm version`, then prints what it chose and
      why; the result is a diff to review, and a version or bump after
      the name overrides the proposal. A **Breaking** entry or section
      stops it until the version is named. Printing only would leave the
      changelog move and the links to be done by hand.
    - **A `Release check` job of its own in `ci.yml`,** with a path list
      of both changelogs, `packages/mcp/package.json` and
      `packages/release/`, over adding it to `Links`, which does not run
      on `packages/mcp/package.json` and checks Markdown links only.
    - **Commands name packages by their npm name:** `pnpm release:prepare
      <package>[@<version|patch|minor|major>] ...`, `pnpm release:notes
      <package> [<version>]` and `pnpm release:check`; usage errors exit
      2, release errors 1. Links in the release text point at `main`, as
      decision 74's do.
    - **Every checked entry needs a lead-in that ends a sentence,** not
      only one ending with a period: an entry without one would drop out
      of the release text. The six lead-ins that were not sentences and
      `@mnemocyte/mcp` 0.2.0's entry without one were reworded in the
      released 1.2.0, 1.4.0, mcp 0.1.0 and 0.2.0 sections, with no fact
      changed, since the site shows those lead-ins on their own and
      neither tarball ships its changelog. Starting the check at the next
      releases instead would have kept the fragments on the site.
101. **The release workflow stays mostly shell** (2026-11-24, landed in
    `chore/release-on-main`): the maintainer took these recommendations
    for decision 99's second item, after a first draft grew to about
    1,300 lines of TypeScript and tests (fetch-based npm and GitHub
    lookups, a table of every npm, tag and release state, and the tag
    commit read from npm's provenance) for cases that rarely happen.
    Changesets gets the same "publish what npm does not have, then tag"
    from `changeset publish`; this repository turned it down for its
    changelog format (decision 99), not to build a release tool of its
    own.
    - **The plan starts a run only for a version npm does not have.**
      `npm view <pkg>@<version>` answers it: `E404` means unpublished,
      and any other failure fails the job. A version on npm without its
      tag or release only warns, with "re-run the failed job, or finish
      it by hand", since every later step skips what exists. A tag for a
      version npm does not have stops the run: the workflow never makes
      one, so it was made by hand. Decision 99's "or has no tag or GitHub
      release yet" is narrowed to that warning, which spares an approval
      for a run that only creates a tag. The package list reaches the job
      through `packages/release/src/bin/list.ts`, which imports only
      `src/packages.ts` and Node's modules, so it runs before installing.
    - **One publish job loops over the packages** in the list's order,
      stopping at the first failure, over a matrix: one install and one
      approval, and GitHub's docs do not say whether one approval
      releases several jobs waiting on the same environment. `mnemocyte`
      goes first, since `@mnemocyte/mcp` builds against it and may raise
      its peer range to the new version.
    - **Tags go on the run's own commit through the API,** as annotated
      tags (`POST git/tags`, then `POST git/refs`), from a job with only
      `contents: write`, no checkout and no install, because `main` has
      no branch protection. The release text comes from the publish job
      as an artifact, written before anything is published.
      `gh release create --verify-tag` keeps gh from creating a tag of
      its own on `main`. Reading the commit from npm's provenance would only
      matter after a partial publish whose fix changed the package; that
      case is tagged by hand (DEVELOPMENT.md, "When a release fails").
    - **The dry run is every `workflow_dispatch`:** `pnpm publish
      --dry-run` for every package, outside the `npm` environment and
      without `id-token`, and a tags job that only prints. GitHub takes
      the event only for a workflow on the default branch, so the first
      dry run is on `main` after this merges; until the maintainer moves
      the environment's rule from tags to `main`, no job on `main` can
      publish.
    - **`release:notes` says how to install a prerelease** (`npm install
      <pkg>@next`), which the release text used to get by hand.
