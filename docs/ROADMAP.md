# Roadmap

The work queue to 1.0. Each item is one branch and one PR; a session picks up
the first unchecked item. The design behind each item is in
[ARCHITECTURE.md](./ARCHITECTURE.md). Tick an item in the PR that completes
it.

## Open decisions

- `agentId` next to `entityId` (see ARCHITECTURE "Open: `agentId`"). Needed
  before the scope migration in Phase 1.

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
- [ ] `feat/postgres-schema-v2`: migration 0003 with scope columns,
  `superseded_by` index, generated `tsvector` + GIN, UUID ids, `halfvec`
  above 2,000 dimensions; Postgres backend rewritten on the executor with
  each write path as one atomic statement (a CTE, for example `consolidate`
  without `SELECT … FOR UPDATE` across round trips), so stateless HTTP
  drivers such as Neon's HTTP driver and D1 can run it; add an optional
  `batch` to `SqlExecutor` where one statement is not enough. Every
  query filters by scope, including id lookups (today
  `getMemoryEmbeddings` and `markMemoriesAccessed` filter by id only). The
  embedding-compatibility cache is keyed by model and dimensions, not by
  store instance. Enable `isolatedDeclarations` once the Drizzle table
  constants in `src/db/schema.ts` are gone; today they would need about 500
  lines of explicit `PgTableWithColumns` types.
- [ ] `feat/migrate-runner`: exported `migrate()` with tracking table,
  advisory lock and one transaction per migration; README and
  `docs/guide/postgres.md` install steps use it (and `psql -v ON_ERROR_STOP=1 --single-transaction` for file users).
- [ ] `fix/hybrid-fusion`: reciprocal rank fusion with recency and importance
  boosts; Postgres ranking tests (none exist today, which is how the
  `ts_rank`/substring scale mix went unnoticed).
- [ ] `fix/access-tracking`: opt-in, after the response, tolerant of deleted
  rows, scoped, no `updatedAt` change.
- [ ] `fix/filtered-vector-search`: `hnsw.iterative_scan` and `ef_search` per
  query; compute the cosine distance once per row (today it appears in
  `SELECT`, a no-op `WHERE` clamp and `ORDER BY`); `EXPLAIN` tests on the
  real recall query.
- [ ] `feat/scoped-api`: `createMemory` with scopes, `add` (with `key`
  upserts), `search`, `get`, `list` (cursor), `update`, `delete`,
  `deleteScope`, `context`; prune requires a scope; upgrade note.
- [ ] `fix/batch-writes`: chunked embedding and inserts in one transaction;
  input size caps (`limit`, content, tags, metadata); validate every recall
  filter (today `tags`, `before` and `after` are not checked) and
  consolidate's `supersededIds` type.
- [ ] `feat/postgres-drivers`: Drizzle, PGlite and node-postgres adapters;
  shared contract suite on PGlite and real Postgres, including cross-scope
  isolation for search, prune, duplicates and consolidation, which no
  Postgres test covers today.

## Phase 2: embedders and AI SDK (0.7)

- [ ] `feat/embedder-purpose`: `purpose` and `maxBatch` on `Embedder`;
  `openaiCompatible`; retries with jitter and `Retry-After`; replace the
  message-substring retry heuristic (it retries any message containing
  "500"); keep provider error bodies as the error `cause`.
- [ ] `feat/ai-sdk-embedder`: `mnemocyte/ai-sdk` with `ai` as optional peer.
- [ ] `feat/ai-sdk-tools`: server-scoped memory tools.
- [ ] `feat/ai-sdk-middleware`: context middleware with an opt-in save hook.
- [ ] `feat/embedders-voyage-cohere-google`: fetch-based embedders.

## Phase 3: operations (0.8)

- [ ] `feat/consolidate-stable`: graduate `consolidate`; survivor-aware
  deletes; kNN-based `findDuplicates`.
- [ ] `fix/observability-non-blocking`: hooks no longer awaited.
- [ ] `feat/audit-retention`: retention option and pruning guidance.
- [ ] `chore/benchmarks`: Postgres benchmarks with
  `EXPLAIN (ANALYZE, BUFFERS)` evidence for every default index.

## Phase 4: 1.0

- [ ] `docs/v1`: API freeze review, README and feature docs pass, upgrade
  guide from 0.5.

## Cut first if time runs short

Voyage/Cohere/Google embedders, the AI SDK middleware, the node-postgres
adapter, kNN duplicates, audit retention.

## After 1.0

- Optional memory extraction from conversations with the user's own AI SDK
  model.
- libSQL / Turso backend, then SQLite + sqlite-vec once it is stable.
- Public `MemoryStore` contract and a monorepo split
  (`@mnemocyte/postgres`, …).
- `@mnemocyte/mcp`.
- OpenTelemetry integration on the observability hooks.
