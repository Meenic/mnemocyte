# Mnemocyte Roadmap

This file tracks **deferred work** identified during the `0.1.0` audit and the
sandbox dogfooding pass. Each item lists its rationale, scope, and the version
it's tentatively targeting. Nothing here blocks `0.1.0`.

For shipped work, see [CHANGELOG.md](./CHANGELOG.md).
For architectural context, see [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## Next slice — `@mnemocyte/mcp@0.0.1`

**Status:** planned, in progress next.
**Target:** new package; no version bump on `mnemocyte` core required.

Restructure the repository into a pnpm workspace and ship an MCP server that
exposes Mnemocyte's tools to LLM hosts (Claude Desktop, Cursor, etc.).

- [ ] Move existing `mnemocyte` source to `packages/core/`.
- [ ] Add `packages/mcp/` with `@mnemocyte/mcp` package.
- [ ] Built-in embedder factories (OpenAI via `OPENAI_API_KEY`,
      `MNEMOCYTE_EMBEDDING_MODEL`) with config-file override via
      `MNEMOCYTE_CONFIG`.
- [ ] `entityId` defaults from `MNEMOCYTE_DEFAULT_ENTITY_ID`; per-tool override
      optional.
- [ ] MCP tools: `remember`, `recall`, `buildContext`, `findDuplicates`,
      `consolidate`, `forget`, `prune`, `listAuditLog`, `stats`.
- [ ] Pin and document the MCP specification revision supported by the
      package at release time, and build against the official
      `@modelcontextprotocol/sdk`.
- [ ] Tests covering each tool wired through an in-memory backend.
- [ ] README with Claude Desktop / Cursor install instructions.

---

## `0.1.x` — docs + tiny safety patches

No API breakage. One new subpath export, one new migration file, and docs.

### Production safety (do not ship 0.1.x indefinitely without these)

- [ ] **Document and tune the bundled HNSW index.** The initial migration
      already creates `mnemocyte_memories_embedding_hnsw_idx`; add production
      guidance for expected build time, memory, and when IVFFlat is a better
      workload-specific fallback for very large or write-heavy deployments.

### Built-in embedder factories

Kills the "every user writes the same eight lines of OpenAI boilerplate"
problem identified during the DX audit.

- [ ] Ship `mnemocyte/embedders/openai` subpath export:
      `openaiEmbedder({ apiKey, model })` returns a ready-made `Embedder`.
      Forwards `AbortSignal`, surfaces rate-limit errors with messages that
      the default `shouldRetry` heuristic already matches.
- [ ] (Stretch) `mnemocyte/embedders/cohere`, `mnemocyte/embedders/voyage` —
      same shape, different provider.

### Documentation

- [ ] **Document the `defaultShouldRetry` heuristic in the README.** Currently
      it lives only in `src/resilience.ts`. Users who plug in custom embedders
      against non-standard providers (e.g. a self-hosted vLLM) need to know
      which substrings trigger retries (`network`, `timeout`, `econn`,
      `etimedout`, `temporarily`, `rate limit`, `500`, `502`, `503`, `504`)
      and that the *conservative-by-default* posture is intentional.
- [ ] Add a "Choosing an embedder" section to the README covering the
      hardcoded `1536` constraint and the workarounds available today
      (choose native 1536-dimensional models such as OpenAI
      `text-embedding-3-small` or Cohere `embed-v4.0`; truncate
      Matryoshka-capable models; pad smaller models; or wait for `0.2.0`).
- [ ] Document current driver compatibility: the bundled `databaseUrl` path
      uses postgres.js over TCP; Neon HTTP/serverless support belongs to the
      future pluggable-Drizzle path.

---

## `0.2.0` — additive ergonomics

Non-breaking additions. No data migrations required for users who don't opt in.

### Configurable embedding dimensions

The single biggest portability limitation today. Required to support
`text-embedding-3-large` (3072), `bge-large` (1024), `all-MiniLM-L6-v2` (384),
Cohere `embed-v4.0` (256/512/1024/1536), Voyage 4-series models
(256/512/1024/2048), and Nomic (768) natively.

- [ ] Templated migration: replace [migrations/0000_initial.sql](migrations/0000_initial.sql)'s
      `vector(1536)` with a `applyMigration(db, { dimensions })` runner, or
      ship one migration file per common dimension.
- [ ] Tiny `mnemocyte_meta` table storing `embedding_dimensions` so the client
      can assert agreement with `embedder.dimensions` on connect (replaces
      the static check in `src/client.ts`).
- [ ] Update `src/db/schema.ts` to read dimensions from config rather than
      the hardcoded `1536`.
- [ ] Tests for 384, 768, 1024, 1536, 3072 dimensions in integration suite.
- [ ] Embedder API should leave room for provider-level output dimensions.
      OpenAI, Cohere, and Voyage all expose Matryoshka-style configurable
      output dimensions on current embedding models. Mnemocyte still needs
      one agreed storage/index dimension per installation; comparing vectors
      with different dimensions in the same pgvector column is not valid
      without a staged retrieval design or separate storage.
- [ ] Migration guide for existing `0.1.x` deployments (they stay on 1536 by
      default; no forced re-migration).

### Opt-in transient-error signal

Currently the retry policy relies on substring matching against the error
message. Works for OpenAI/Anthropic/Cohere SDKs whose errors say sensible
things; fails for custom error classes.

- [ ] Add `"TRANSIENT"` to the `MnemocyteErrorCode` union, OR add a
      `transient?: boolean` field on `MnemocyteError`.
- [ ] `defaultShouldRetry` (in `src/resilience.ts`) always retries errors with that signal.
- [ ] Document in README so embedder authors can throw
      `new MnemocyteError("…", "TRANSIENT")` and have it Just Work.
- [ ] Backwards compatible: existing substring heuristic stays as fallback.

### Per-entity scoped client

Today every call takes `entityId: string`. Users invariably want to bind a
client to one entity for the duration of a request and stop repeating
themselves. Identified during the DX audit as the single biggest
ergonomics-paper-cut not already on the roadmap.

- [ ] Add `client.for(entityId): ScopedClient` returning a subset of the
      `MnemocyteClient` interface with `entityId` pre-filled.
- [ ] Thin wrapper, not a new resource lifetime: closing the parent closes
      children. No new connection pool, no new audit stream.
- [ ] Consider a generic `createMnemocyte<EntityId extends string>()` so
      users can type-tag their IDs and have TypeScript catch
      `"user-123"` vs `"user_123"` typos at compile time.

### Quality-of-life

- [ ] Expose `applyMigration(databaseUrl, { dimensions? })` programmatically
      so users don't need to shell out to `psql`.
- [ ] `client.healthcheck()` that pings the DB and validates pgvector +
      schema presence.
- [ ] CLI: `mnemocyte init` (scaffold config), `mnemocyte migrate`
      (apply SQL), `mnemocyte stats $ENTITY`, `mnemocyte export --jsonl`.

---

## Phase 7 — structural refactors

**Target:** undecided; **do before adding a third backend.**

### Backend driver abstraction

Today `src/memory/in-memory.ts` (~530 lines) and `src/memory/postgres.ts`
(~556 lines) implement the **same `MnemocyteClient` interface** with
**different storage**. The logic — scoring filters, supersede semantics, tag
merging in consolidation, audit recording — is duplicated across both files.
Works fine at 2 backends; will rot at 3.

- [ ] Extract a `MemoryStore` driver interface (`get`, `put`, `query`,
      `update`, `delete`, plus audit and event hooks).
- [ ] Reduce each backend to a thin adapter over `MemoryStore`.
- [ ] Move all orchestration logic (validators, observe wrappers, consolidate
      arithmetic, hybrid scoring) into a single shared
      `createMnemocyteClient(store, config)`.
- [ ] **Do this BEFORE adding SQLite or any third backend** — far cheaper
      with 2 implementations than 3.

### File-size hygiene

- [ ] Split `src/memory/postgres.ts` into
      `postgres/{client,queries,audit,consolidate}.ts`.
- [ ] Apply the same split to `src/memory/in-memory.ts`.

### Edge-runtime / pluggable driver

The current `createDatabase(url)` in `src/db/index.ts` hardcodes `postgres-js`
over TCP, which excludes Cloudflare Workers, Vercel Edge Functions, and Deno
Deploy.

- [ ] Accept a pre-built Drizzle instance instead of (or in addition to) a
      URL, so users can plug in `drizzle-orm/neon-http`,
      `drizzle-orm/neon-serverless`, `drizzle-orm/postgres-js`, or
      `drizzle-orm/node-postgres`.
- [ ] Document edge-runtime caveats: no long-lived pools, no `LISTEN/NOTIFY`,
      cold-start latency for connection setup.
- [ ] Verify pgvector index queries over Neon HTTP/serverless once callers can
      provide a pre-built Drizzle instance; document row-size and edge-runtime
      caveats from that test.

---

## Ideas under consideration

Not committed to a release. Captured here so they don't get lost in chat
history. Each would meaningfully change the product; each needs a real design
pass before becoming a roadmap item.

### High-leverage, low-effort (do these first if you do any)

- **`@mnemocyte/vercel-ai` adapter.** Bind directly to the Vercel AI SDK's
  `tools` API. Probably the single biggest distribution multiplier per line
  of code. Same shape for `@mnemocyte/langchain`, `@mnemocyte/llamaindex`,
  `@mnemocyte/openai-assistants`.
- **OpenTelemetry tracing.** The `observability.onEvent` hook already emits
  start/success/error events; wrap them as OTEL spans and Mnemocyte plugs
  into Datadog/Honeycomb/Grafana with no further user work.
- **Snapshot / fixture export.** `client.snapshot()` returns a deterministic
  JSON blob; `createMnemocyte({ snapshot })` restores it. Game-changer for
  testing user code against deterministic memory state.

### High-leverage, larger effort

- **SQLite + `sqlite-vec` backend.** Zero-setup local-first storage. Unlocks
  "just `npx @mnemocyte/mcp`" with no Postgres install required. Forces the
  Phase 7 `MemoryStore` refactor to happen first.
- **Reranker stage in `recall`.** Pull top-K via hybrid scoring, then rescore
  via a cross-encoder or a small, current LLM. Largest available *quality* win.
- **Typed memory relationships.** A `mnemocyte_relations` table with kinds
  like `contradicts`, `supports`, `refines`, `derived_from`. Pairs with…
- **Active conflict detection.** Find memories that *disagree* (not just
  near-duplicates). Requires an NLI model or an LLM check. Together with
  typed relations, this is the leap from "vector store" to
  "actually reasons about memories".
- **LLM-driven consolidation summariser.** `experimental.consolidate` picks
  a survivor today; a `summariser?: (memories) => string` callback would let
  the survivor be a synthesis instead of just a winner.
- **Studio web UI** (separate `@mnemocyte/studio` package). Browse memories,
  run queries live, watch the audit log stream. High "wow factor" once the
  API surface is stable.

### Speculative

- HyDE-style query expansion (write a hypothetical answer, embed it,
  recall on that).
- Image / multimodal memories (CLIP-style embeddings on the same row).
- Type-safe metadata schemas via Zod
  (`createMnemocyte({ metadata: zodSchema })`).
- PII redaction hooks (`onBeforeStore: (input) => redacted`).
- GDPR export / right-to-be-forgotten
  (`exportEntity`, `purgeEntity({ includeAuditLog: true })`).
- Encrypted-at-rest per-entity keys (content encrypted, embeddings queryable).
- Row-level security migration helpers for multi-tenant Postgres.

---

## Won't-do (explicit non-goals)

These came up during the audit but are deliberately out of scope.

- **CockroachDB support.** Speaks the Postgres protocol but does not
  implement pgvector. Adding a non-vector retrieval path would fragment the
  codebase.
- **MySQL / DuckDB backends.** Outside the project thesis (vector hybrid
  retrieval against a single-instance store is the value proposition).
  *SQLite + sqlite-vec is excluded from this rejection because it's now
  listed under "Ideas under consideration" above — it serves the local-first
  MCP use case without abandoning vector search.*
- **Built-in chunking/splitting.** Mnemocyte stores what you give it.
  Chunking policy belongs upstream where the application knows its content
  shape.
- **Built-in summarisation/distillation as a core feature.** Same reasoning
  as chunking. The `experimental.consolidate` API (see `src/types.ts`) is the
  deliberate seam where a user-supplied summariser could plug in later, but
  Mnemocyte itself stays embedder-only by default.

---

## How to use this file

When you finish an item, **move it to [CHANGELOG.md](CHANGELOG.md)** under the appropriate
version section rather than checking it off here. This file stays a
forward-looking document, not a history. When a planned version ships, delete
its section entirely.
