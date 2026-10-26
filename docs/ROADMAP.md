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
- [ ] `chore/deps-patch`: drizzle-orm 0.45.4, drizzle-kit 0.31.11, Biome 2.6
  (`biome migrate`), tsdown 0.23, `@types/node` 22.x latest, pnpm 11.28.x,
  GitHub Actions to current majors. TypeScript stays on 6.0.x (7.0 has no
  programmatic API yet).
- [ ] `chore/vitest-5`: Vitest 5 with `vite` as a dev dependency; rewrite the
  retrieval benchmark for the new `bench` API.
- [ ] `chore/ci-matrix`: Node 22.18 / 24 / 26, Postgres 17 and 18 with
  pgvector, publint and attw on the packed tarball, a packed-package test
  that works with any `tar`.
- [ ] `chore/release-workflow`: tag-triggered publish from GitHub Actions
  with npm trusted publishing and provenance.

## Phase 1: core foundation (0.6, breaking)

- [ ] `feat/sql-executor`: `SqlExecutor` interface and postgres.js
  adapter; the core has zero runtime dependencies and `postgres` becomes an
  optional peer.
- [ ] `feat/postgres-schema-v2`: migration 0003 with scope columns,
  `superseded_by` index, generated `tsvector` + GIN, UUID ids, `halfvec`
  above 2,000 dimensions; Postgres backend rewritten on the executor.
- [ ] `feat/migrate-runner`: exported `migrate()` with tracking table,
  advisory lock and one transaction per migration; README install steps use
  it (and `psql -v ON_ERROR_STOP=1 --single-transaction` for file users).
- [ ] `fix/hybrid-fusion`: reciprocal rank fusion with recency and importance
  boosts; Postgres ranking tests.
- [ ] `fix/access-tracking`: opt-in, after the response, tolerant of deleted
  rows, scoped, no `updatedAt` change.
- [ ] `fix/filtered-vector-search`: `hnsw.iterative_scan` and `ef_search` per
  query; `EXPLAIN` tests on the real recall query.
- [ ] `feat/scoped-api`: `createMemory` with scopes, `add` (with `key`
  upserts), `search`, `get`, `list` (cursor), `update`, `delete`,
  `deleteScope`, `context`; prune requires a scope; upgrade note.
- [ ] `fix/batch-writes`: chunked embedding and inserts in one transaction;
  input size caps.
- [ ] `feat/postgres-drivers`: Drizzle, PGlite and node-postgres adapters;
  shared contract suite on PGlite and real Postgres.

## Phase 2: embedders and AI SDK (0.7)

- [ ] `feat/embedder-purpose`: `purpose` and `maxBatch` on `Embedder`;
  `openaiCompatible`; retries with jitter and `Retry-After`.
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
