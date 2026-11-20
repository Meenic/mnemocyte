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

- [x] `fix/mixed-version-text-search-docs`: 1.1 clients search with
  `websearch_to_tsquery('english', …)` whatever the installation uses, so
  on a `simple` installation their keyword matches are silently lost
  (`lexicalRank: null` for "running" where 1.2 finds it), and they ignore
  `schemaName`. `CHANGELOG.md` 1.2.0, `guide/upgrading.md` "1.1 → 1.2" and
  ARCHITECTURE.md decision 50 say 1.1 and 1.2 share an installation in
  either deploy order without that condition. Say that every process must
  run 1.2 before a non-`english` configuration or a `schemaName` is
  adopted, and have `mnemocyte text-search` say so too ("Restart other app
  processes" does not help a 1.1 process).
- [x] `fix/drizzle-generate-keep-config`: `generate --adapter drizzle`
  without `--text-search-config` writes `english` over a file generated
  with another configuration, and `drizzle-kit generate` then drops and
  re-adds `content_tsv`, rewriting the table. The guide's upgrade step
  ("run `generate` again") does not say to repeat the flag. Read the
  configuration from the existing file, as `readDrizzleSchemaShape`
  already does for dimensions and schema, and change it only when the flag
  is passed; test a re-run without the flag.
- [x] `fix/text-search-drizzle-schema-notes`: `mnemocyte text-search` on
  a drizzle-kit installation (untracked migrations) changes the column
  without a word, leaving drizzle-kit's schema file behind; point it at
  `generate --text-search-config` instead. The `psql` recipe in
  `guide/postgres.md` "Change it later" names the bare
  `mnemocyte_memories`, which misses an installation in a `schemaName`;
  show the qualified name.
- [x] `fix/context-track-access`: with `trackAccess` on, `context` and
  `experimental.contextWithMemories` mark every search result as accessed,
  the ones the token budget left out of the prompt included, because
  tracking runs inside `search` (decision 46, "Left open";
  `features/retrieval.md`). Mark only the memories that made it into the
  context, on both backends, and test a tight budget.

## Discoverability

Make Mnemocyte easier to find on npm and GitHub, and easier for people and
coding agents to use, without a docs site. Decided on 2026-11-17:

- The tagline, the `package.json` description and the GitHub About text
  stay as they are.
- `README.md` stays the front page (AGENTS.md "Documentation"). Recipes and
  a FAQ go in new `docs/guide/` pages, and the API reference stays in
  `guide/api.md`.
- The existing `AGENTS.md` stays the guide for agents working on this
  repository. Advice for agents that write code using Mnemocyte goes in
  `guide/ai-tools.md`.
- No `llms.txt` while there is no docs site. Agents read the README and the
  JSDoc in the shipped `.d.mts` files, so the JSDoc carries the examples.
- None of this needs a release of its own. The README and keywords reach
  npm with the next release.

The items, in order:

- [x] `chore/package-keywords` (done in the `docs/readme-front-page` PR,
  not a PR of its own): at most 10 `keywords`, spent on what
  people search for that the description ("Memory for TypeScript AI
  apps.") does not already say: `ai-memory`, `agent-memory`, `llm`, `rag`,
  `embeddings`, `vector-search`, `semantic-search`, `postgres`,
  `pgvector`, `ai-sdk`. This replaces `ai`, `memory`, `agents` and
  `typescript`, which the description covers. The rest of
  `package.json` and the packed file list checked out (2026-11-17) and
  need no change.
- [x] `chore/require-esm-test`: Mnemocyte is ESM-only, and only the CLI
  bin uses top-level await, so on every Node version `engines` allows,
  `require("mnemocyte")` should work through require(esm). Nothing tests
  or documents it. Add a package test that requires every export from a
  `.cjs` file against the packed tarball, and say it next to the Node
  version in `README.md`. Read Node's require(esm) docs first.
- [x] `docs/readme-front-page`: keep the tagline and the current example.
  Added badges (npm version, monthly downloads, install size, types,
  license, CI) and the pnpm install line with Node.js 22.18+ as the
  runtime. No "when to use it" section
  and no comparison table of other libraries. The install size badge is
  shields.io's unpacked size, which equals the install size while there are
  no required dependencies: packagephobia's own badge sits behind a bot
  check and does not render on GitHub. Links to the new guide pages are
  added as they land. The README rule in AGENTS.md "Documentation" allows
  badges.
- [x] `chore/doc-examples-check`: `pnpm test:readme`
  (`scripts/check-readme.mjs`) joins the README `ts` blocks in order,
  type-checks them against the built `dist/` through the package's own
  `exports`, and runs in `test:ci`. Errors name the README line. Decided:
  the generated file lives in the gitignored `test/package/.readme/` (it
  must sit inside the package for the self-reference), no block can opt
  out, and the script is separate from `test:types`. Guide snippets stay
  out of scope: they use variables they never declare; only a few
  `guide/api.md` loops are copied by hand into
  `test/package/exports-types.test-d.ts`.
- [x] `docs/jsdoc-examples`: a top-level doc comment on the options
  interfaces that lack one (`MemoryMiddlewareOptions`, `WithMemoryOptions`,
  `MemoryToolsOptions`, `AiSdkEmbedderOptions` and the five HTTP embedder
  options), an `@example` on every `MemoryClient` method and on
  `openaiEmbedder`, and `@throws` with error codes where a method has
  well-defined ones. Skip `@param` that repeats the input type's field
  docs. Decided: the `BoundMemoryClient` methods keep their
  `{@link MemoryClient.x}` pointer instead of examples of their own (the
  `MemoryClient` examples use `memory.for(...)`). `@throws` names the
  class in braces and the code and reason in the text
  (`{MnemocyteError} "CONFLICT" with reason "KEY_IN_USE"`). Codes any
  method can throw (`VALIDATION`, `ABORTED`, `DB`, `MIGRATION`,
  `EMBEDDING`, `TIMEOUT`, the `CONFIG` mismatches) are listed once on the
  `MemoryClient` interface; a method's `@throws` lists only its own.
- [x] `chore/jsdoc-examples-check`: `pnpm test:jsdoc`
  (`scripts/check-jsdoc.mjs`) type-checks the `ts` blocks in `@example`
  comments under `src/` against the built `dist/`, and runs in `test:ci`.
  Each block is its own function behind one shared preamble of `declare`
  lines, and the import lines of all blocks are merged per module at the
  top. Errors name the source file and line. Decided: a separate script
  from `check-readme.mjs` (the README check keeps its line-for-line
  layout; this one needs a line map), and examples may use the
  application-side names in the preamble (`memory`, `user`, `embedder`,
  `store`, `scope`, `id`, `userId`, `openai`, ...) but must import every
  Mnemocyte export they use. Nine examples gained an import line for that.
  The generated `jsdoc.ts` and `tsconfig.jsdoc.json` sit in the gitignored
  `test/package/.readme/`.
- [x] `docs/ai-tools-guide`: `guide/ai-tools.md`, with a block users paste
  into their own `AGENTS.md` or `CLAUDE.md`, and the mistakes coding agents
  make with Mnemocyte, each checked against the code: expecting
  `createMemory` to create tables, passing a `pg.Client`, calls without a
  scope instead of `for()`, a second embedding model on one installation,
  options copied from other libraries (unknown keys throw), importing
  embedders or `postgresStore` from the root, looking for `close()`,
  `deleteScope` erasing across agents and sessions, `instanceof` instead
  of `isMnemocyteError`, relying on `experimental.*`, and `migrate` over
  Neon's HTTP driver.
- [x] `docs/faq-recipes`: `guide/faq.md` (do I need Postgres, which
  drivers, CommonJS, does it call an LLM, switching embedding models,
  multi-tenant apps) and `guide/recipes.md` (an AI SDK chat route with
  `withMemory`, a preference saved under a `key`, erasing a user, nightly
  maintenance with prune, duplicates, consolidate and audit retention,
  tests on the in-memory store, a local setup with Ollama). Answers link
  to the guide sections that hold the details. Both are linked from the
  README's documentation line. Like other guide snippets, the recipe code
  is not type-checked.
- [x] `docs/examples`: `examples/` with `in-memory.ts`, `pglite.ts`
  (Postgres in process, no Docker), `postgres.ts` and `ai-sdk-chat.ts`,
  run with `node examples/<file>.ts` after `pnpm build`, importing
  `mnemocyte` by name through self-reference, plus a short
  `examples/README.md`. `pnpm test:examples` (`tsc -p
  examples/tsconfig.json`, the getting-started tsconfig without `paths`)
  type-checks them against `dist/` in `test:ci`; nothing runs them, since
  each needs a key and some a database. Not in `files`. The
  getting-started guide links to them. Decided: a separate script rather
  than part of `check-readme.mjs`, like `test:jsdoc`; the chat sends the
  chat model, the extraction model and the embedder through the AI
  Gateway (`gateway(...)` and `aiSdkEmbedder({ model: "openai/..." })`), so
  it needs only `AI_GATEWAY_API_KEY` and no provider package; it keeps
  memories in process memory, with `/new` to clear the history and show
  they stay; its `save.waitUntil` collects the extraction promises and the
  loop waits for them before the next turn, since the response does not.
  The PGlite data folder is `examples/memory-data` (gitignored), found
  through `import.meta.dirname`.
- [x] `docs/contributing-security`: `CONTRIBUTING.md` that points to
  `DEVELOPMENT.md`, the roadmap, the commands and the branch and commit
  format, and `SECURITY.md` with supported versions (the latest 1.x
  minor) and how to report privately. Decided: reports go through GitHub
  private vulnerability reporting only, with no email address (the file
  is public, and the form gives a private thread, a draft advisory and a
  private fork); someone who cannot use it opens an issue asking for a
  contact, without details, as GitHub's docs suggest. `SECURITY.md` names
  the newest 1.x minor without a version number so it does not go stale,
  and promises no reply time. The maintainer enables the feature in the
  repository settings (Security and quality, Advanced Security). The
  README's "Want to help?" line links both files, and the site's
  community page links `CONTRIBUTING.md`.

## Backends and packages

- [ ] `refactor/store-contract`: the internal `MemoryStore` contract shrinks
  from 21 methods to the ten or so in ARCHITECTURE.md "Layers" and gains
  `capabilities`, before a second backend depends on it.
- [ ] `feat/libsql-store`: a libSQL / Turso backend at `mnemocyte/libsql`,
  on the user's own libSQL client as an optional peer.
- [ ] `feat/public-store-contract`: `MemoryStoreV1` exported from
  `mnemocyte/store`, with the contract test suite at
  `mnemocyte/store/test`, so third-party backends can prove they conform.
- [ ] `chore/workspace-layout`: the package moves to `packages/mnemocyte/`,
  the site to `apps/site/`, and `examples/` becomes a workspace package on
  `"mnemocyte": "workspace:*"` (decision 53). CI, the release workflow,
  `scripts/`, the package tests and the paths in `AGENTS.md` and `docs/`
  follow, and so does the local, gitignored `.claude/launch.json`. npm shows the README from the package
  folder while GitHub shows the root one, and relative links such as
  `docs/guide/api.md` would break there: how to keep one README for both
  (`repository.directory` plus absolute links, or a copy at build) is the
  maintainer's call, asked in that PR. `pnpm pack --dry-run` must list the
  same files as before.
- [ ] `feat/mcp-server`: `@mnemocyte/mcp`, an MCP server with its own `bin`,
  at `packages/mcp/` in the pnpm workspace.

## Later

Not queued. Each one comes back as an item when its condition holds.

- SQLite + sqlite-vec, once sqlite-vec has a stable release (npm has 0.1.9
  today).
- Recency that follows content updates rather than `createdAt`, if users
  find the note in `guide/api.md` ("Keys") is not enough.
- The memories `memoryMiddleware` / `withMemory` put in the prompt, given
  to the app (for citations), perhaps through an `onContext`-style
  callback, once `experimental.contextWithMemories` leaves `experimental`.
- OpenTelemetry on the observability hooks, when users ask for it. `onEvent`
  covers it in app code today; a subpath would add `@opentelemetry/api` as
  an optional peer.
