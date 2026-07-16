# Mnemocyte Roadmap

This roadmap tracks the planned direction for Mnemocyte before v1.0. It is a
forward-looking planning document, not a release history. Shipped work belongs
in [CHANGELOG.md](../CHANGELOG.md).

Mnemocyte's direction is infrastructure-native and deliberately composable:
bring your own database, bring your own embedder, and keep the core package
small enough to fit into existing TypeScript stacks. The long-term shape is a
set of focused adapters around a stable memory core, similar in spirit to the
way modern TypeScript infrastructure tools let applications own their database,
auth, model provider, and runtime boundaries.

## Product Principles

- **Bring your own database.** Mnemocyte should integrate with storage the app
  already operates. Postgres + pgvector is the current first-class path, but the
  API should move toward caller-owned database clients and explicit
  `MemoryStore` adapters.
- **Bring your own embedder.** The core accepts an `Embedder` interface. Built-in
  factories should remove boilerplate without making one provider special.
- **Adapters over monoliths.** Framework, model-host, and runtime integrations
  should live in small packages that depend on the core, not inside the core.
- **Explicit infrastructure.** Migrations, dimensions, indexes, and runtime
  tradeoffs should be visible. The client should not hide schema creation or
  production tuning behind side effects.
- **Stable core before broad distribution.** MCP and framework adapters become
  more valuable after the storage and embedder contracts are clean.

## v1 Stabilization Criteria

These items are the practical v1 gate. They should either be completed before
v1 or explicitly documented as deferred limitations.

Remaining critical before v1:

- Keep tightening expected database, migration, timeout, abort, and provider
  failures through `MnemocyteError`.
- Decide when the internal `MemoryStore` type is stable enough to become a
  public adapter contract.
- Keep migration guidance explicit for default fresh installs, existing
  installs that need dimension/model metadata, and custom-dimension fresh
  installs.

Important but not blocking:

- Add runtime validation around public inputs for JavaScript consumers.
- Add retrieval evaluation fixtures that compare recall quality across vector,
  lexical, and fused ranking changes.
- Make plain-text context framing collision-proof for untrusted memory content
  and make `maxTokens` a hard postcondition even for tiny budgets.
- Tighten package/release documentation around supported Node versions and npm
  provenance or trusted publishing.

Future considerations:

- Multi-dimension storage in one database, likely through separate columns,
  tables, or partitions.
- OpenTelemetry adapters built on the current observability hook.
- Additional provider packages if core subpaths become too crowded.

## Next - Public `MemoryStore` Stabilization

Version `0.3.0` shipped the internal `MemoryStore` boundary. Before exporting
an adapter contract:

- Review transaction hooks, caller-owned connection lifecycle, and
  runtime-specific Drizzle driver requirements.
- Decide how applications provide a store while keeping `createMnemocyte()` the
  simple default entry point.
- Add public adapter contract tests and document which lifecycle
  responsibilities belong to callers versus Mnemocyte.
- Keep the type private and avoid a third backend until those decisions are
  validated.

This is the architectural hinge for the rest of the roadmap. It makes future
database and runtime adapters possible without copying the client.

## `0.4.0` - `drizzleStore(db)`

Let applications bring their own Drizzle database instance.

- Add `drizzleStore(db, options)` for caller-owned Drizzle clients.
- Support the current Postgres + pgvector schema through the `MemoryStore`
  adapter.
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
- Use the core package and official `MemoryStore`/embedder adapters rather than
  maintaining a parallel memory implementation.
- Document Claude Desktop, Cursor, and other host setup only after the package
  can be tested end to end.

MCP is a distribution layer, not the foundation. It should sit on top of the
same composable primitives application developers use directly.

## Adapter Architecture After `0.5.0`

Once `MemoryStore` and the Drizzle store are stable, additional adapters can be
considered independently:

- framework/tool adapters such as Vercel AI SDK, LangChain, LlamaIndex, or
  OpenAI tool-call helpers
- runtime-specific database adapters where Drizzle support is verified
- local-first storage experiments such as SQLite + `sqlite-vec`
- OpenTelemetry integration using existing observability hooks
- deterministic snapshot/fixture export for tests

Adapters should stay small, optional, and replaceable. The core should remain a
memory library, not an agent framework. If the repository moves to a monorepo,
provider helpers can move from core subpaths into focused packages such as
`@mnemocyte/openai`.

## Non-Goals

- No hidden schema creation from the client constructor.
- No separate vector database requirement in the core package.
- No built-in chunking policy. Applications know their content boundaries.
- No built-in summarization pipeline in the core. A future summarizer hook can
  compose with consolidation, but Mnemocyte should remain embedder-first by
  default.
- No multi-provider embedding mixture in one vector column until there is a
  clear retrieval and migration design.
- No broad backend expansion before the public `MemoryStore` adapter contract
  exists.

## Maintenance Rule

When planned work ships, move the release details to
[CHANGELOG.md](../CHANGELOG.md) and delete or revise the roadmap section. The
roadmap should stay short, current, and biased toward the next architectural
decision.
