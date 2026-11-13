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
survivor-aware deletes, the k-nearest-neighbor `findDuplicates`,
`consolidate` on the stable client (decision 30) and audit retention
through `pruneAuditLog` (decision 32); see
[features/maintenance.md](./features/maintenance.md).

## Embedders

The contract with `purpose` and `maxBatch`, `openaiCompatibleEmbedder`,
`ProviderError` with the provider's body as `cause`, and status-based
retries with jitter and `Retry-After` have landed (decision 25), and so
have the AI SDK embedder, `aiSdkEmbedder`, and fetch-only Voyage, Cohere
and Gemini API embedders (decision 29); see
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
  - `init` writes a `memory.ts` for the driver found in `package.json`
    and adds `OPENAI_API_KEY=` to `.env` when it is missing. It never
    overwrites a file and prints every change; `--dry-run` only prints.
- **Missing-schema errors.** Landed: the `"MIGRATION"` error for a missing
  table or column names `migrate({ memory })` and links the Postgres
  guide, as described in [features/postgres.md](./features/postgres.md#errors).
  The CLI changes the named command to `npx mnemocyte migrate`.
- **Getting started.** Landed as
  [guide/getting-started.md](./guide/getting-started.md), with a
  `migrate.ts` script that calls `migrate({ memory })`; `feat/cli` replaces
  that script with `npx mnemocyte migrate`.

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
    rule; `postgresJs()` and `drizzleStore()` stay, not deprecated. `pg` and
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
    extraction has its own `timeout` (30 s) instead of the request's
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
    stays as a deprecated alias until 1.0, so 0.8 breaks nothing.
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
