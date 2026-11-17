# Roadmap

The work queue after 1.0. Each item is one branch and one PR; a session picks
up the first unchecked item. Items are additive and ship in 1.x minors; a
change that would break the documented API waits for 2.0. The design behind
an item, and the packaging rule for new code, are in
[ARCHITECTURE.md](./ARCHITECTURE.md). Tick an item in the PR that completes
it.

## Done

1.0.0 and 1.0.1 shipped on 2026-11-15, 1.1.0 and 1.2.0 on 2026-11-16.
What each release changed is in
[CHANGELOG.md](../CHANGELOG.md), and why is in the ARCHITECTURE.md
decisions. The finished queue that led to 1.0 (phases 0 to 4) is in the
[roadmap at v1.0.1](https://github.com/Meenic/mnemocyte/blob/v1.0.1/docs/ROADMAP.md).

## API polish

- [x] `fix/optional-undefined-embedder`: `?: T | undefined` on
  `ProviderErrorInput.retryAfterMs`. `EmbedOptions.signal` stays exact:
  Mnemocyte passes it into embedders, and widening it breaks an embedder
  that declares `{ signal?: AbortSignal }` (the design rules in
  [DEVELOPMENT.md](./DEVELOPMENT.md)).
- [x] `feat/package-json-export`: `"./package.json"` in `exports`, so tools
  can read the installed version.
- [x] `feat/is-provider-error`: an `isProviderError` guard next to
  `isMnemocyteError`, on the same brand; `guide/embedders.md` uses it instead
  of checking `code` and `status` by hand.
- [x] `feat/stats-signal`: `signal` on `stats`, and a bound
  `stats({ signal })` typed as `BoundStatsInput`. Bound `stats()` takes no
  input today and rejects any key.
- [x] `feat/input-aliases`: `BoundPruneInput` for the bound `prune` input
  and `AiSdkPurposeHints` to match the embedders' `PurposeHints`; the old
  names `PruneSelectors` and `AiSdkPurposeOptions` stay as deprecated
  aliases through 1.x (decision 42).

## Embedders

- [x] `feat/embedder-headers`: `headers` on the OpenAI, Voyage, Cohere and
  Gemini embedders, as `openaiCompatibleEmbedder` already has, for proxies
  and gateways.
- [x] `feat/embedder-fetch`: a custom `fetch` on every fetch-based embedder,
  for tests and proxies.

## Retrieval and results

- [x] `feat/created-filters-list-context`: `createdBefore` /
  `createdAfter` on `list` and `context`, the names `search` and `prune`
  use (decision 40).
- [x] `fix/created-filter-precision`: Postgres compares `created_at` at
  microseconds but returns `createdAt` cut to milliseconds, so
  `createdAfter: memory.createdAt` can still return that memory on
  Postgres and not in memory (`search`, `list`, `context`). Make both
  backends agree without wrapping the column in `date_trunc`, which would
  stop an index on `created_at` from being used.
- [x] `feat/delete-result`: `delete` returns which dependents it restored or
  deleted, instead of `void`.
- [x] `feat/context-memories`: a context call that also returns the
  memories it used, for citations and debugging. Starts under
  `experimental` if the shape is not settled.

## Observability and CLI

- [x] `feat/observability-scope`: `agentId` and `sessionId` on observability
  events, next to `namespace` and `entityId`.
- [x] `feat/cli-json`: `--json` for `check` and `migrate --dry-run`, so CI
  can read the result.
- [x] `feat/init-embedder`: `init --embedder openai-compatible`. Today
  `init` always writes `openaiEmbedder` and `OPENAI_API_KEY=`, even for the
  Ollama setup the getting-started guide shows.

## Schema

Each item ships as a numbered migration. Index changes need
`EXPLAIN (ANALYZE, BUFFERS)` evidence on representative data.

- [x] `feat/audit-memory-id`: an indexed memory id column on audit events
  for per-memory history. Today the id is only in the event's `metadata`.
- [x] `feat/text-search-config`: choose the text search configuration at
  install time. `english` is fixed in migration 0003 and
  `fresh-install.sql`; changing it rewrites the generated `tsvector` column
  and its GIN index (`guide/limitations.md`).
- [x] `feat/schema-name`: a `schemaName` option to keep the tables outside
  `public` (ARCHITECTURE.md "Setup").
- [x] `feat/drizzle-schema-export`: `mnemocyte generate --adapter drizzle`
  writes the tables as a Drizzle schema, so `drizzle-kit` manages them
  (ARCHITECTURE.md "Setup").

## Fixes after 1.2

Found by reading and running the 1.1 and 1.2 items against Postgres 16
and 18.

- [ ] `fix/mixed-version-text-search-docs`: 1.1 clients search with
  `websearch_to_tsquery('english', …)` whatever the installation uses, so
  on a `simple` installation their keyword matches are silently lost
  (`lexicalRank: null` for "running" where 1.2 finds it), and they ignore
  `schemaName`. `CHANGELOG.md` 1.2.0, `guide/upgrading.md` "1.1 → 1.2" and
  ARCHITECTURE.md decision 50 say 1.1 and 1.2 share an installation in
  either deploy order without that condition. Say that every process must
  run 1.2 before a non-`english` configuration or a `schemaName` is
  adopted, and have `mnemocyte text-search` say so too ("Restart other app
  processes" does not help a 1.1 process).
- [ ] `fix/drizzle-generate-keep-config`: `generate --adapter drizzle`
  without `--text-search-config` writes `english` over a file generated
  with another configuration, and `drizzle-kit generate` then drops and
  re-adds `content_tsv`, rewriting the table. The guide's upgrade step
  ("run `generate` again") does not say to repeat the flag. Read the
  configuration from the existing file, as `readDrizzleSchemaShape`
  already does for dimensions and schema, and change it only when the flag
  is passed; test a re-run without the flag.
- [ ] `fix/text-search-drizzle-schema-notes`: `mnemocyte text-search` on
  a drizzle-kit installation (untracked migrations) changes the column
  without a word, leaving drizzle-kit's schema file behind; point it at
  `generate --text-search-config` instead. The `psql` recipe in
  `guide/postgres.md` "Change it later" names the bare
  `mnemocyte_memories`, which misses an installation in a `schemaName`;
  show the qualified name.

## Backends and packages

- [ ] `refactor/store-contract`: the internal `MemoryStore` contract shrinks
  from 21 methods to the ten or so in ARCHITECTURE.md "Layers" and gains
  `capabilities`, before a second backend depends on it.
- [ ] `feat/libsql-store`: a libSQL / Turso backend at `mnemocyte/libsql`,
  on the user's own libSQL client as an optional peer.
- [ ] `feat/public-store-contract`: `MemoryStoreV1` exported from
  `mnemocyte/store`, with the contract test suite at
  `mnemocyte/store/test`, so third-party backends can prove they conform.
- [ ] `feat/mcp-server`: `@mnemocyte/mcp`, an MCP server with its own `bin`,
  in a pnpm workspace in this repository.

## Later

Not queued. Each one comes back as an item when its condition holds.

- SQLite + sqlite-vec, once sqlite-vec has a stable release (npm has 0.1.9
  today).
- Recency that follows content updates rather than `createdAt`, if users
  find the note in `guide/api.md` ("Keys") is not enough.
- OpenTelemetry on the observability hooks, when users ask for it. `onEvent`
  covers it in app code today; a subpath would add `@opentelemetry/api` as
  an optional peer.
