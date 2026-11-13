# Roadmap

The work queue to 1.0. Each item is one branch and one PR; a session picks up
the first unchecked item. The design behind each item is in
[ARCHITECTURE.md](./ARCHITECTURE.md). Tick an item in the PR that completes
it.

## Open decisions

- Rename `namespace` to `tenant` before 1.0? Other libraries use
  "namespace" for different things (Supermemory: the user; LangGraph: a
  key path), and ours means the tenant or app. A rename is breaking; the
  alternative is calling it "tenant or app" everywhere in the docs.

## Phase 0: reset (0.5.x)

- [x] `docs/reset-workflow`: CLAUDE.md, AGENTS.md, DEVELOPMENT.md and feature
  docs, ARCHITECTURE.md, ROADMAP.md; delete old reports.
- [x] `chore/deps-patch`: drizzle-orm 0.45.4, drizzle-kit 0.31.11, Biome 2.6
  (`biome migrate`), tsdown 0.23, `@types/node` 22.x latest, pnpm 11.28.x,
  GitHub Actions to current majors. TypeScript stays on 6.0.x (7.0 has no
  programmatic API yet).
- [x] `chore/vitest-5`: Vitest 5 with `vite` as a dev dependency; rewrite the
  retrieval benchmark for the new `bench` API.
- [x] `chore/config-cleanup`: align configs with the TypeScript 6, Node
  packages, tsdown and Vitest 5 docs: no `baseUrl`, `es2024`, package
  self-reference in the `package` project, build entries in
  `tsdown.config.ts`, `"default"` and explicit subpaths in `exports`, no
  declaration maps. `isolatedDeclarations` moved to
  `feat/postgres-schema-v2`.
- [x] `chore/ci-matrix`: Node 22.18 / 24 / 26, Postgres 17 and 18 with
  pgvector, publint and attw on the packed tarball, a packed-package test
  that works with any `tar`.
- [x] `chore/pnpm-12`: pnpm 12 (the Rust rewrite) in `packageManager` and
  CI. Diff the packed tarball against pnpm 11's, since 12 still changes what
  `pnpm pack` includes from release to release.
- [x] `chore/release-workflow`: tag-triggered publish from GitHub Actions
  with npm trusted publishing and provenance.

## Phase 1: core foundation (0.6, breaking)

- [x] `feat/sql-executor`: `SqlExecutor` interface and postgres.js
  adapter; the core has zero runtime dependencies and `postgres` becomes an
  optional peer. The user's client owns TLS and pool settings, which removes
  today's `sslmode` override (it breaks `prefer`/`allow`) and the fixed
  `max: 10` pool.
- [x] `docs/readme-rewrite`: cut `README.md` to the shape of Ollama's: title
  and one-line pitch, install, a quickstart that fits one screen, the Postgres
  setup in a few commands, an API-at-a-glance list, embedders, and links to
  the docs. No HTML, images or badges. Move the long reference (every method,
  limitations, error codes, maintenance details) into user-facing pages under
  `docs/` and link them. Keep the tagline "Infrastructure-native memory for
  TypeScript AI applications."
- [x] `feat/postgres-schema-v2`: migration 0003 with scope columns,
  `superseded_by` index, generated `tsvector` + GIN, UUID ids, `halfvec`
  above 2,000 dimensions; Postgres backend rewritten on the executor with
  each write path as one atomic statement (a CTE, for example `consolidate`
  without `SELECT … FOR UPDATE` across round trips), so stateless HTTP
  drivers such as Neon's HTTP driver and D1 can run it; add an optional
  `batch` to `SqlExecutor` where one statement is not enough (moved to
  `fix/batch-writes`, the first path that needs it). Every
  query filters by scope, including id lookups (today
  `getMemoryEmbeddings` and `markMemoriesAccessed` filter by id only). The
  embedding-compatibility cache is keyed by model and dimensions, not by
  store instance. Enable `isolatedDeclarations` once the Drizzle table
  constants in `src/db/schema.ts` are gone; today they would need about 500
  lines of explicit `PgTableWithColumns` types.
- [x] `feat/migrate-runner`: exported `migrate()` with tracking table,
  advisory lock and one transaction per migration; README and
  `docs/guide/postgres.md` install steps use it (and `psql -v ON_ERROR_STOP=1 --single-transaction` for file users).
- [x] `fix/hybrid-fusion`: reciprocal rank fusion with recency and importance
  boosts; Postgres ranking tests (none exist today, which is how the
  `ts_rank`/substring scale mix went unnoticed).
- [x] `fix/access-tracking`: opt-in, after the response, tolerant of deleted
  rows, scoped, no `updatedAt` change; `notAccessedSince` falls back to
  `createdAt`.
- [x] `fix/filtered-vector-search`: `hnsw.iterative_scan` and `ef_search` per
  query; compute the cosine distance once per row (today it appears in
  `SELECT`, a no-op `WHERE` clamp and `ORDER BY`); `EXPLAIN` tests on the
  real recall query.
- [x] `feat/scoped-api`: `createMemory` with scopes, `add` (with `key`
  upserts), `search`, `get`, `list` (cursor), `update`, `delete`,
  `deleteScope`, `context`; prune requires a scope; no `close()`
  (ARCHITECTURE decision 19); upgrade note.
- [x] `fix/batch-writes`: chunked embedding and inserts in one transaction,
  through an optional `SqlExecutor.batch` for drivers without interactive
  transactions;
  input size caps (`limit`, content, tags, metadata, `key`). Validating
  every search filter and consolidate's `supersededIds` type landed with
  `feat/scoped-api`.
- [x] `feat/postgres-drivers`: `postgresStore(client)` takes a postgres.js,
  node-postgres (`pg` Pool), Drizzle or PGlite client directly, detected by
  shape (decision 21); a hand-written `SqlExecutor` still works, and
  `postgresJs()` and `drizzleStore()` keep working. Shared contract suite on
  PGlite and real Postgres, including cross-scope isolation for search,
  prune, duplicates and consolidation, which no Postgres test covers today.
- [x] `chore/postgres-js-4`: support postgres.js 4 (4.0.0 shipped
  2026-10-29): peer range `^3.4.9 || ^4`, the contract and integration suites
  on both majors. 4.x sends parameters untyped and lets the server decide;
  Mnemocyte sends only strings, numbers and null (timestamps, JSON and tags
  as text with casts), which both majors write the same, and the PGlite
  contract checks it. `batch` uses `sql.batch()` on 4.1+ outside a
  transaction; cancellation keeps `cancel()` on both majors.
- [x] `feat/migrate-setup`: `migrate({ memory })` reads the store and
  `dimensions` from the client (`{ store, dimensions }` stays; a
  `dimensions` that differs from the embedder's is a `"CONFIG"` error).
  Opt-in `createExtension: true` runs `CREATE EXTENSION IF NOT EXISTS vector`
  before the first migration; off by default, because managed databases and
  restricted roles cannot create extensions. `dryRun: true` returns the
  `applied` and `adopted` lists the call would produce and changes nothing.
- [x] `feat/bound-scope`: `createMemory({ namespace })` sets a default
  namespace that a call's scope may override, and `memory.for(scope)` returns
  a client bound to that scope whose methods take no `scope` field. Global
  operations (`allNamespaces`) stay on the unbound client. Starts under
  `experimental` if the shape is not settled.
- [x] `docs/getting-started`: `docs/guide/getting-started.md` from an empty
  folder to a first `context()` call: install, `.env`, a `memory.ts` with
  postgres.js, `pg`, Drizzle and PGlite variants, `npx mnemocyte migrate`
  (or `migrate({ memory })` until `feat/cli` lands), and a bound scope.
  Includes a one-line Docker command on the CI image
  (`pgvector/pgvector:0.8.7-pg18`) and the in-memory backend for prototypes.
  `README.md` links it.

## Phase 2: setup, embedders and AI SDK (0.7)

- [x] `fix/migration-hint`: the `"MIGRATION"` errors for missing tables or
  columns (`src/memory/postgres.ts`) tell the user to run
  `migrate({ memory })` and link the Postgres guide, instead of naming SQL
  files; `feat/cli` changes the hint to `npx mnemocyte migrate`.
- [x] `feat/store-client`: `createMemory({ store })` also takes a database
  client (postgres.js, a `pg` Pool, PGlite, Drizzle over one of them, or a
  `SqlExecutor`) and detects it with decision 21's checks, after store
  configs from `postgresStore()`, which keeps working (decision 23). The
  Postgres backend loads with a dynamic `import()` on first use so the root
  import stays small for in-memory users; no top-level `await`, which would
  break `require()`. Bundle sizes with and without the lazy load in the PR.
  README, the getting-started guide and the Postgres guide use
  `store: sql`.
- [x] `feat/embedder-purpose`: `purpose` and `maxBatch` on `Embedder`;
  `openaiCompatibleEmbedder`; retries with jitter and `Retry-After`;
  replace the message-substring retry heuristic (it retries any message
  containing "500"); keep provider error bodies as the error `cause`.
- [x] `feat/ai-sdk-embedder`: `mnemocyte/ai-sdk` with `ai` as optional peer.
  `aiSdkEmbedder({ model })` takes an AI SDK embedding model or a
  `"provider/model"` string, which the AI SDK resolves through its global
  provider (the AI Gateway by default). `dimensions` comes from a table of
  known models; for any other model it is required (`"CONFIG"`).
- [x] `feat/ai-sdk-tools`: `memoryTools({ memory })` with
  `searchMemories`, `saveMemory` and `forgetMemory` over a bound client;
  the model supplies no scope field, and the call's abort signal is
  forwarded.
- [x] `feat/ai-sdk-middleware`: context middleware with an opt-in save hook,
  plus `withMemory({ model, memory })`, which returns the model wrapped
  with `wrapLanguageModel` and the middleware in one call.
- [x] `feat/ai-sdk-extraction`: an opt-in `save: { model }` on the
  middleware and `withMemory` (decisions 24 and 28), and
  `extractMemories`. After a response, the user's own AI SDK model
  extracts memories from the turn into the bound scope, with structured
  output. Off by default, never delays or fails the response (errors go to
  `onError`), and extracted facts that already exist update in place by
  key (`extracted:` prefix) instead of duplicating.
- [ ] `feat/embedders-voyage-cohere-google`: fetch-based embedders.

## Phase 3: operations (0.8)

- [ ] `feat/consolidate-stable`: graduate `consolidate`; survivor-aware
  deletes; kNN-based `findDuplicates`.
- [ ] `fix/observability-non-blocking`: hooks no longer awaited.
- [ ] `fix/audit-atomic`: audit events in the same statement or transaction
  as the write they record, for every write path (`add`, `addMany`,
  `update`, `delete`, `prune`, `consolidate`); today they are written
  best-effort after the write and a failed audit write is swallowed.
- [ ] `feat/audit-retention`: retention option and pruning guidance.
- [ ] `chore/benchmarks`: Postgres benchmarks with
  `EXPLAIN (ANALYZE, BUFFERS)` evidence for every default index.
- [ ] `feat/cli`: a `mnemocyte` bin that loads the app's `memory.ts` (root,
  `lib/`, `src/`, `src/lib/` or `--config`) for its store and embedder.
  `migrate` asks before enabling pgvector (`--yes` for CI) and supports
  `--dry-run`; `check` reports the pgvector version, applied migrations and
  dimensions and exits non-zero on a problem; `sql` prints the fresh-install
  schema without a database (replaces running `render-initial.mjs` by path).
  Without a memory file, `--dimensions` and `DATABASE_URL` with the installed
  `postgres` peer. No new dependencies. The getting-started guide's
  `migrate.ts` and `db:migrate` script become `npx mnemocyte migrate`, and
  the missing-schema hint from `fix/migration-hint` names the command.
- [ ] `feat/cli-init`: `npx mnemocyte init` writes a `memory.ts` for the
  driver it finds in `package.json` (`postgres`, `pg`,
  `@electric-sql/pglite`, `drizzle-orm`) in the first of the folders the
  CLI searches that exists, and adds `OPENAI_API_KEY=` to `.env` when the
  variable is missing. It never overwrites a file, prints every change, and
  supports `--dry-run`.

## Phase 4: 1.0

- [ ] `docs/v1`: API freeze review, README and feature docs pass, upgrade
  guide from 0.5.

## Cut first if time runs short

Voyage/Cohere/Google embedders, the AI SDK middleware, kNN duplicates,
audit retention, `mnemocyte init`.

## After 1.0

- libSQL / Turso backend, then SQLite + sqlite-vec once it is stable.
- Public `MemoryStore` contract and a monorepo split
  (`@mnemocyte/postgres`, …).
- `@mnemocyte/mcp`.
- Drizzle schema export (`mnemocyte generate --adapter drizzle`) so Drizzle
  users manage the tables with `drizzle-kit`.
- A `schemaName` option to keep the tables outside `public`.
- OpenTelemetry integration on the observability hooks.
