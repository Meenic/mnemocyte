# Mnemocyte Roadmap

This roadmap tracks the planned direction for Mnemocyte before v1.0. It is a
forward-looking planning document, not a release history. Shipped work belongs
in [CHANGELOG.md](./CHANGELOG.md).

Mnemocyte's direction is infrastructure-native and deliberately composable:
bring your own database, bring your own embedder, and keep the core package
small enough to fit into existing TypeScript stacks. The long-term shape is a
set of focused adapters around a stable memory core, similar in spirit to the
way modern TypeScript infrastructure tools let applications own their database,
auth, model provider, and runtime boundaries.

## Product Principles

- **Bring your own database.** Mnemocyte should integrate with storage the app
  already operates. Postgres + pgvector is the current first-class path, but the
  API should move toward caller-owned database clients and explicit stores.
- **Bring your own embedder.** The core accepts an `Embedder` interface. Built-in
  factories should remove boilerplate without making one provider special.
- **Adapters over monoliths.** Framework, model-host, and runtime integrations
  should live in small packages that depend on the core, not inside the core.
- **Explicit infrastructure.** Migrations, dimensions, indexes, and runtime
  tradeoffs should be visible. The client should not hide schema creation or
  production tuning behind side effects.
- **Stable core before broad distribution.** MCP and framework adapters become
  more valuable after the storage and embedder contracts are clean.

## `0.1.x` - Production Hardening

No API breakage. Focus on safety fixes, documentation polish, and operational
clarity for the current Postgres + pgvector implementation.

### Safety fixes

- Keep provider timeouts, retries, and `AbortSignal` behavior consistent across
  every embedder call.
- Continue tightening validation around destructive operations, configuration
  mismatches, and closed-client access.
- Keep audit-log behavior explicit: audit is opt-in, state-changing operations
  are recorded when enabled, and entity deletion does not silently erase history.
- Treat experimental APIs (`findDuplicates`, `experimental.consolidate`) as
  useful but unstable until the storage abstraction is settled.

### Documentation polish

- Keep README examples small, current, and runnable.
- Keep [ARCHITECTURE.md](./ARCHITECTURE.md) aligned with the shipped package
  surface and known limitations.
- Add migration notes for users moving within `0.1.x`.
- Make every limitation concrete: what works today, what fails fast, and what is
  planned next.

### HNSW and index guidance

- Document the bundled HNSW index created by the migration:
  `mnemocyte_memories_embedding_hnsw_idx`.
- Explain expected tradeoffs: approximate recall, index build memory, write
  overhead, and interaction with ordinary Postgres filters.
- Document when production users should benchmark alternate indexes or custom
  migrations, including IVFFlat for large tables with representative data and
  workload-specific tuning.
- Add guidance for full-text and tag indexes without baking unproven indexes
  into the default migration.

## `0.1.x` - Official `openaiEmbedder()`

Add the first official embedder factory without changing the core `Embedder`
contract.

- Ship a subpath export such as `mnemocyte/embedders/openai`.
- Export `openaiEmbedder({ apiKey, model, dimensions? })`.
- Forward `AbortSignal` to the OpenAI SDK.
- Surface provider errors in a way that works with the default retry heuristic.
- Keep the dependency boundary clear. If the OpenAI SDK materially increases
  install weight, prefer an optional peer dependency or a narrowly scoped
  subpath package shape.
- Document that custom embedders remain the default integration model.

This is not a pivot to a provider-owned package. It is a convenience adapter for
the common case.

## `0.2.0` - Configurable Embedding Dimensions

Make embedding dimensions an installation-level setting instead of a hardcoded
1536-dimensional Postgres schema.

- Add `mnemocyte_meta` to store installation metadata, including
  `embedding_dimensions`.
- Replace the hardcoded `vector(1536)` assumption with a migration path that can
  create the selected vector dimension.
- Validate `embedder.dimensions` against `mnemocyte_meta` on connect.
- Keep one embedding dimension per installation. Mixed dimensions in one table
  remain out of scope until there is a separate retrieval design.
- Document common dimensions for OpenAI, local, Cohere, Voyage, and Nomic-style
  embedders.
- Provide an upgrade guide for existing `0.1.x` deployments, which remain on
  1536 unless the operator chooses a migration path.

This milestone unblocks a broader range of embedding providers while preserving
the core storage invariant that all comparable vectors share one dimension.

## `0.3.0` - `Store` Abstraction

Separate memory orchestration from storage implementation.

- Introduce a `Store` interface responsible for persistence primitives,
  recall candidates, audit events, and lifecycle operations.
- Move validation, embedding, scoring coordination, observability, retries, and
  context building into shared core orchestration.
- Reduce in-memory and Postgres implementations to store adapters instead of
  separate clients with duplicated behavior.
- Keep `createMnemocyte()` as the main entry point while allowing future
  adapter-backed construction.
- Avoid adding a third backend before this lands.

This is the architectural hinge for the rest of the roadmap. It makes future
database and runtime adapters possible without copying the client.

## `0.4.0` - `drizzleStore(db)`

Let applications bring their own Drizzle database instance.

- Add `drizzleStore(db, options)` for caller-owned Drizzle clients.
- Support the current Postgres + pgvector schema through the store adapter.
- Keep connection lifecycle ownership with the caller when a database instance
  is supplied.
- Document tested driver/runtime combinations, starting with postgres.js and
  expanding only after verification.
- Prepare for Neon HTTP/serverless, node-postgres, and other Drizzle drivers
  without hardcoding them into the core client.

The goal is to fit into apps that already use Drizzle, already own connection
pools, or run in environments where `databaseUrl` plus postgres.js is too
prescriptive.

## `0.5.0` - `@mnemocyte/mcp`

Ship an official MCP adapter after the storage and embedder contracts are ready.

- Add `@mnemocyte/mcp` as a separate package.
- Build against the official Model Context Protocol SDK and pin the supported
  spec revision in package docs.
- Expose practical tools first: `remember`, `recall`, `buildContext`,
  `findDuplicates`, `consolidate`, `forget`, `prune`, `listAuditLog`, and
  `stats`.
- Configure database and embedder through explicit environment/config inputs.
- Use the core package and official stores/embedders rather than maintaining a
  parallel memory implementation.
- Document Claude Desktop, Cursor, and other host setup only after the package
  can be tested end to end.

MCP is a distribution layer, not the foundation. It should sit on top of the
same composable primitives application developers use directly.

## Adapter Architecture After `0.5.0`

Once `Store` and the Drizzle store are stable, additional adapters can be
considered independently:

- framework/tool adapters such as Vercel AI SDK, LangChain, LlamaIndex, or
  OpenAI tool-call helpers
- runtime-specific database adapters where Drizzle support is verified
- local-first storage experiments such as SQLite + `sqlite-vec`
- OpenTelemetry integration using existing observability hooks
- deterministic snapshot/fixture export for tests

Adapters should stay small, optional, and replaceable. The core should remain a
memory library, not an agent framework.

## Non-Goals

- No hidden schema creation from the client constructor.
- No separate vector database requirement in the core package.
- No built-in chunking policy. Applications know their content boundaries.
- No built-in summarization pipeline in the core. A future summarizer hook can
  compose with consolidation, but Mnemocyte should remain embedder-first by
  default.
- No multi-provider embedding mixture in one vector column until there is a
  clear retrieval and migration design.
- No broad backend expansion before the `Store` interface exists.

## Maintenance Rule

When planned work ships, move the release details to
[CHANGELOG.md](./CHANGELOG.md) and delete or revise the roadmap section. The
roadmap should stay short, current, and biased toward the next architectural
decision.
