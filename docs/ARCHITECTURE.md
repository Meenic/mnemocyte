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

The flow is three steps: install, export `memory` from a `memory.ts`, run
`npx mnemocyte migrate`. No `migrate` call sits in app code.

- **`migrate` options.** Landed: `migrate({ memory })`, `createExtension`
  and `dryRun` are described in
  [features/postgres.md](./features/postgres.md#the-migrate-runner).
- **CLI.** Landed: the `mnemocyte` bin with `init`, `migrate`, `check` and `sql`
  loads the app's own memory file, or connects to `DATABASE_URL` without
  one (decision 36); see [features/cli.md](./features/cli.md).
- **`init`.** Landed: `mnemocyte init` writes a `memory.ts` for the
  driver found in `package.json` and adds `OPENAI_API_KEY=` to `.env`
  (decision 37); see [features/cli.md](./features/cli.md#init).
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
`mnemocyte/postgres` (backend and driver adapters), `mnemocyte/embedders/*`,
`mnemocyte/ai-sdk`. Drivers and `ai` are optional peer dependencies.

After 1.0 (decision 1, revised 2026-11-15), a package is split out only when
it needs dependencies of its own or its own release cadence:

- **Backends.** A first-party backend that runs on the user's own client, as
  Postgres does, ships as a subpath of `mnemocyte` (`mnemocyte/libsql`). If
  SQLite needs the `sqlite-vec` package as a dependency of ours, rather than
  the user loading the extension on their own connection, it becomes a
  package of its own. Drizzle and Kysely stay in `mnemocyte` for the same
  reason: the user brings the driver, and the drivers are optional peers.
- **The public `MemoryStore` contract** is versioned in its name
  (`MemoryStoreV1`), so the core can accept two versions during a change
  instead of forcing a major. It is exported from `mnemocyte/store`, with
  the contract test suite beside it at `mnemocyte/store/test`. Third-party
  backends are their own packages with `mnemocyte` as a peer (`^1`). A
  separate contract package, as `@ai-sdk/provider` is for the AI SDK,
  follows only if third-party backends become common.
- **`@mnemocyte/mcp`** is the first separate package: it brings the MCP SDK
  and a `bin`. It lives in a pnpm workspace in this repository and takes
  `mnemocyte` as a peer (`^1`), the way `@mastra/pg` takes `@mastra/core`;
  it uses only the public API, so it needs no exact pins.
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
    runs the built bin on every CI Node version.
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
53. **Repository layout** (2026-11-20): the maintainer chose, with
    `chore/repo-tidy`. The last two points landed there; the rest is the
    target for `chore/workspace-layout`, and until then the root is both
    the package and the workspace.
    - The root keeps only what is about the whole repository: `apps/`,
      `packages/`, `examples/`, `docs/`, `.github/`, `.vscode/`, the
      dotfiles (`.gitignore`, `.gitattributes`, `.editorconfig`),
      `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
      `LICENSE`, `AGENTS.md`, `CLAUDE.md`, `biome.json`, the private
      workspace `package.json`, `pnpm-workspace.yaml` and
      `pnpm-lock.yaml`.
    - The published package moves to `packages/mnemocyte/` with its
      `src/`, `test/`, `migrations/`, `scripts/` and build, test and
      TypeScript configs; the site moves to `apps/site/`. `@mnemocyte/mcp`
      then lands as `packages/mcp/`. Libraries go under `packages/`, things
      that are run or deployed under `apps/`.
    - `examples/` stays at the root, where GitHub readers look for it, and
      becomes a workspace package that depends on `"mnemocyte":
      "workspace:*"`, the way an app installs it.
    - `CHANGELOG.md` stays at the root; whether `@mnemocyte/mcp` gets a
      changelog of its own is asked in `feat/mcp-server`.
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
