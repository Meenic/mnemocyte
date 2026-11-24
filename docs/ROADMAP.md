# Roadmap

The work queue after 1.0. Each item is one branch and one PR; a session picks
up the first unchecked item. Items are additive and ship in 1.x minors; a
change that would break the documented API waits for 2.0. The design behind
an item, and the packaging rule for new code, are in
[ARCHITECTURE.md](./ARCHITECTURE.md). Tick an item in the PR that completes
it.

## Done

1.0.0 and 1.0.1 shipped on 2026-11-15, 1.1.0 and 1.2.0 on 2026-11-16,
1.2.1 on 2026-11-20, 1.3.0 on 2026-11-21. What each release changed is in
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

## CI and checks

Planned on 2026-11-21, when every PR ran all nine `ci.yml` jobs (Node
22.18, 24 and 26, Package, Site, and Postgres 17 and 18 with postgres.js
3 and 4): about 13 runner-minutes and 2 to 3 minutes of wall time,
docs-only PRs included, and the push to `main` after the squash merge
ran them again. `main` has no branch protection or rulesets.

Facts checked on 2026-11-21; re-read the official pages in each PR:

- GitHub "Troubleshooting required status checks": a workflow skipped by
  `paths` leaves its checks Pending, which blocks a PR that requires them;
  a job skipped by an `if` condition reports Success.
- `paths` filters apply to `push` and `pull_request` only, so the
  release workflow's `workflow_call` of CI always runs everything.
- The site does not import `mnemocyte`. The only file it reads from
  outside `apps/site/` is `CHANGELOG.md`
  (`apps/site/src/lib/changelog.ts`), and `CHANGELOG.md` is not in the
  npm tarball (`pnpm pack --dry-run`).
- The root `biome.json` includes `**`, so the root `pnpm lint` also checks
  `apps/site/` with the site's nested config.
- `README.md` is not only docs: `test:readme` type-checks its `ts` blocks,
  and `test:jsdoc` the `@example` blocks in `src/`.

The items, in order:

- [x] `chore/ci-paths`: on a pull request, a `changes` job diffs the
  test merge commit against its base parent and runs only the jobs the
  changed files need; a push to `main` and the release run everything. A
  final `CI ok` job fails when a job that ran failed or was cancelled.
  Every job has `timeout-minutes`, `ci.yml` has `permissions: contents:
  read`, `persist-credentials: false` on each checkout and a `head_ref ||
  run_id` concurrency group, and the release's `verify` and `publish`
  jobs have timeouts too. Decided: one workflow with a diff step instead
  of a separate `site.yml` (decision 54). Found while building it, so the
  lists differ from the plan: `docs/guide/getting-started.md` runs the
  Node jobs (`test/cli/init.test.ts` reads it), `.gitignore` and
  `.gitattributes` run everything, and the Site job runs the root `pnpm
  lint`, which fails on warnings. The lists and the rules are in
  DEVELOPMENT.md ("What CI runs").
- [x] `chore/ci-matrix`: a `Checks` job on Node 24 runs `checktypes`,
  `lint` and a new `test:checks` script (the type-level checks) once; the
  Node 22.18, 24 and 26 jobs run `test:ci`, now the build and the `unit`,
  `contract` and `package` projects only, and `pnpm test` runs both. The
  Postgres jobs enable pgvector with `docker exec` on
  `job.services.postgres.id` instead of installing `postgresql-client`.
  Decided: all four Postgres jobs stay on PRs (decision 55). Measured and
  dropped: `pnpm install --filter mnemocyte` skips the site's
  dependencies, but the install step already takes 1 to 4 seconds from
  the store cache. Found while building it: lint and the type-level
  checks took about 15 seconds of a Node job, while the `contract`
  project on PGlite takes about 70 of its 106 Vitest seconds
  (`chore/contract-time`). The rules are in DEVELOPMENT.md ("What CI
  runs").
- [x] `chore/docs-links`: `scripts/check-links.mjs` checks that relative
  links and `#anchors` in `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `AGENTS.md`, `examples/README.md` and `docs/**` point at
  files and headings that exist, as a `test:links` script that
  `pnpm test` runs first and a `Links` CI job. Decided: `github-slugger`
  as a dev dependency (decision 56). Found while building it: the docs
  already use `<a id>` custom anchors, which the check counts, and none
  of the 336 relative links was broken. GitHub's docs say a relative
  link's text must stay on one line, so the check fails a wrapped one
  (none today). External URLs are not checked.
  The rules are in DEVELOPMENT.md ("Testing" and "What CI runs").
- [x] `chore/release-checks`: `verify` also fails when `CHANGELOG.md`
  has no `## [X.Y.Z] - date` heading or no `[X.Y.Z]:` compare link for
  the tag (every tag from v0.1.3 on has both). After a final release, the
  publish job removes `next` when it is not ahead of the release, and
  only warns when that fails. Both workflows pin `actions/checkout`,
  `pnpm/action-setup` and `actions/setup-node` to full-length SHAs, and
  `.github/dependabot.yml` updates them (`github-actions` only, weekly,
  one group, 7-day cooldown). The release's `ci` run passes
  `release: true` and skips `Site`. Decided: "Allow npm dist-tag" on
  (decision 57), SHA pins over a workflow lockfile (decision 58) and no
  `Site` in the release run (decision 59). Found while building it: pnpm
  12.12.1 and newer runs `dist-tag` over OIDC itself, so the npm CLI
  version did not matter (Node 24.22.3 bundles npm 11.19.1, below the
  11.21.0 npm needs), and `pnpm dist-tag rm` does not prompt (a local
  registry stub's 403 failed it at once with `ERR_PNPM_FORBIDDEN`);
  `cooldown` supports only `default-days` for actions; each action's
  major tag pointed at the same commit as its newest release, so pinning
  changed nothing at run time. The rules are in DEVELOPMENT.md
  ("Releasing" and "What CI runs").
- [x] `chore/contract-time`: contract databases start from one PGlite
  data folder that the `contract` project's global setup saves
  (`openPGlite` in `test/contract/pglite.ts`), and the five PGlite runs of
  the store contract are a file each. Measured first: a fresh PGlite took
  about 0.75 s (initdb runs on every start without `loadDataDir`), a
  start from a saved data folder 0.2 s, and `CREATE EXTENSION` plus
  `migrate` 30 ms; `cli`, `drizzle-schema`, `schema-name` and
  `text-search` opened about 55 fresh ones, one or two per test.
  `pglite.test.ts` was query work instead, 5 to 11 s per run (the 260-row
  `addMany` and the audit rollback the slowest), but its five runs shared
  one worker. Same 215 tests; locally on Node 24 the project went from 47
  to 51 s to 23 to 26 s. In CI, the Node jobs' Vitest runs went from 103
  to 111 s (last `main` run, `pglite.test.ts` at 70 to 74 s) to 41 to
  69 s on PR #127, with no `contract` file over 15 s, and the Node jobs
  from about 2 minutes 10 seconds to 1 to 1.5 minutes. Decided: a saved
  data folder loaded per test over a reset between tests or `clone()`
  (decision 60). `contract` stays on every Node version, since the cut
  made that question moot. Found while building it:
  `test/package/cli.test.ts` (17 to 29 s on PR #127) is now the slowest
  single file. The rules are in DEVELOPMENT.md ("Testing" and "What CI
  runs").
- [x] `chore/libsql-package-timeout`: `test/package/libsql.test.ts` ran
  under Vitest's 5 s default while it copied the packed package into a
  temporary consumer and ran ESM and `require()` scripts there. It took
  4.2 to 5.2 s alone on Windows (Node 24) and timed out once in a full
  `pnpm test` on 2026-11-21 (found in `chore/libsql-remote-ci`). It now
  has the 30 s the other packed-consumer tests use (`require-esm.test.ts`,
  `lazy-postgres.test.ts`), as a per-test argument rather than a
  `testTimeout` for the whole `package` project, so the in-process
  package tests keep the 5 s default. No other `test/package` test runs
  scripts in a consumer under the default; the rule is in DEVELOPMENT.md
  ("Testing").
- [x] `chore/typescript-scripts`: the ten `.mjs` scripts (the root
  `scripts/check-links`, seven in `packages/mnemocyte/scripts/`, two in
  `packages/mcp/scripts/`) are `.ts` files Node runs through type
  stripping, and `pnpm checktypes` covers them: each package's
  `tsconfig.json` includes its `scripts/`, and a root `tsconfig.json`
  with `typescript` and `@types/node` as root dev dependencies covers the
  root's (`pnpm checktypes:scripts`, also run by the Links job).
  `erasableSyntaxOnly` is on in both packages, which turned four
  parameter properties into declared fields. The `@mnemocyte/mcp` test
  fixtures are `memory.ts` now. The migrations stay `.sql`. The site's
  static reference (`apps/site/design/reference/`) and
  `apps/site/design/PROMPTS.md` are gone: the built site is the
  reference, `design/BRIEF.md` describes the docs layout that was only in
  the reference, and the open site step is the "Site" item below.
  `pnpm pack --dry-run` lists the same files for both packages
  (decision 91).

## Backends and packages

- [x] `refactor/store-contract`: the internal `MemoryStore` contract went
  from 22 methods (plus the `backend` and `schemaName` properties, counted
  on 2026-11-21) to 16 and gained `capabilities`, before a second backend
  depends on it. Decided: which methods merge and which stay, the
  in-memory capability values (with a new `"overlap"` for its keyword
  score), and no store method of its own for `experimental.*`
  (decision 61). The contract is in DEVELOPMENT.md ("Store contract").
- [x] `feat/libsql-store`: a libSQL / Turso backend at `mnemocyte/libsql`,
  on the user's own `@libsql/client` as an optional peer, with its own
  numbered migrations. Decided (decisions 62 to 70): the entry and the
  clients it takes, an exact prefiltered vector search instead of DiskANN
  (so no postfilter warning), FTS5 with `porter` and quoted `OR` terms,
  `F32_BLOB` up to 65,536 dimensions, single write batches, CI on database
  files, the CLI through a memory file, and duplicates in JavaScript. The
  backend is in [features/libsql.md](./features/libsql.md).
- [x] `chore/libsql-remote-ci`: CI runs
  `test/integration/libsql-remote.test.ts` against a libSQL server
  container, so the Hrana protocol path (HTTP batches and the server's
  own SQL parser, which rejected aggregate `ORDER BY`) is tested on every
  PR that changes its files. Decided (decision 71): a job of its own on
  Node 24 with the Postgres file list, and the image pinned by its
  commit-SHA tag and digest, bumped by hand. The job is in DEVELOPMENT.md
  ("What CI runs").
- [x] `feat/public-store-contract`: `MemoryStoreV1` exported from
  `mnemocyte/store` with `defineMemoryStore`, and the contract test suite
  at `mnemocyte/store/test`, so third-party backends can prove they
  conform. Decided (decisions 72 and 73): `migrate` and
  `ensureEmbeddingCompatibility` optional, `inspectInstallation` and
  `setTextSearchConfig` first-party only, the fallbacks in one adapter,
  `MemoryStoreV1…` type names over an internal `MemoryStore`, a
  `"custom"` backend, and the suite on `vitest` as an optional peer. The
  contract is in DEVELOPMENT.md ("Store contract"); the guide is
  [guide/custom-stores.md](./guide/custom-stores.md).
- [x] `chore/workspace-layout`: the package moved to `packages/mnemocyte/`,
  the site to `apps/site/`, and `examples/` became a workspace package on
  `"mnemocyte": "workspace:*"` (decision 53), with CI's path lists, the
  release workflow, the scripts, the package tests and the docs following.
  Decided (decisions 74 and 75): the root `README.md` stays the only
  source and `prepack` copies it into the package with absolute links,
  `LICENSE` too; `docs/`, `CHANGELOG.md` and a root `scripts/check-links.mjs`
  stay at the root; root scripts pass through with `--filter mnemocyte`.
  `pnpm pack --dry-run` lists the same 79 files as before. The layout is in
  DEVELOPMENT.md ("Structure").
- [x] `feat/mcp-server`: `@mnemocyte/mcp`, an MCP server with its own `bin`,
  at `packages/mcp/` in the pnpm workspace. Decided (decisions 84 to 89):
  a changelog of its own, the app's memory file with a tested copy of the
  CLI's loader and a `--project` flag, the scope from flags only, stdio
  only with `createMemoryMcpServer` for other transports, search and save
  with forget opt-in, the `mnemocyte-mcp` bin at 0.1.0 released on
  `mcp-v*` tags with `mnemocyte` `^1.1.0` as a peer. The package is in
  [features/mcp.md](./features/mcp.md); the first publish is the
  maintainer's (DEVELOPMENT.md, "Releasing").
- [x] `docs/architecture-review`: the packaging, the migrations, the
  repository layout and `src/` re-tested against drizzle-orm and
  drizzle-kit, Prisma, better-auth, the AI SDK, Mastra, turbomem,
  Graphile Worker, pg-boss and LangGraph, from their manifests, sources
  and docs. Decided (decisions 92 to 96): one package stays, with the CLI
  as its bin; the loader copy becomes a private bundled package
  (`chore/shared-loader`); the migrations ship as they are; the site and
  folder names stay; the Postgres and libSQL scope predicates become one
  (`chore/shared-scope-sql`). No code changed.

## Drivers, CLI and ORMs

Planned on 2026-11-22 from a walk through adding Mnemocyte to a Next.js
app on Drizzle and Neon, and from how other libraries ship their tables
(Better Auth, Auth.js, Payload, pg-boss, graphile-worker, Mastra, Kysely).
The maintainer took the recommendations in decisions 76 to 83.

Release plan (2026-11-23): the items ship in four minors, in the order
below. Cut each release when its group lands; a docs item needs no
release, since the guide is read from `main`.

- **1.4.0, Next.js on Neon:** `feat/neon-http-driver` to
  `feat/init-detect-app`. `@mnemocyte/mcp` 0.2.0 goes with it, since
  `feat/cli-env-files` and `feat/cli-server-only` change its `.env`
  loading and the loader it bundles (`chore/shared-loader`, which needs
  no release, comes before them). `docs/nextjs-recipe` follows once
  1.4.0 is on npm.
- **1.5.0, OpenRouter:** `fix/retry-529` and `feat/openrouter-embedder`.
  `chore/shared-scope-sql` follows it and needs no release.
- **1.6.0, migration 0005:** `chore/release-schema-notes` first, since this
  release's text needs its schema line, then
  `feat/installation-from-catalog`, `feat/migrate-sql-plans` (so teams on
  their own migration tool can print 0005's SQL) and
  `feat/scope-key-expression-index`. `docs/migration-tools` follows.
- **1.7.0 or later:** `feat/drop-old-key-index`, at least one minor after
  0005 ships.

- [x] `feat/neon-http-driver`: accept Neon's HTTP driver as `store`: the
  `neon()` function from `@neondatabase/serverless` 1.x and a Drizzle `db`
  over `drizzle-orm/neon-http`, whose `$client` is that function. Today the
  first is unrecognised and the second throws `"CONFIG"` as an unsupported
  Drizzle driver, so Neon users must write a `SqlExecutor` or switch to a
  `Pool`, which Neon's docs say not to create outside a request handler on
  serverless. `query` maps to `sql.query(text, params)`, `batch` to
  `sql.transaction([...])`, and the signal to `fetchOptions`. Neon does not
  document whether an abort cancels the query on the server, so document
  it as node-postgres's is. `@neondatabase/serverless` `>=1.0` becomes an
  optional peer. `test/sql/clients.test.ts` rejects a Neon-shaped function
  today and changes with it. Add an integration test of a Neon `Pool`
  too, which the guide says is detected as a node-postgres pool but no
  test covers.
  Decided (decision 76): CI runs the HTTP path through
  `ghcr.io/timowilhelm/local-neon-http-proxy`, the proxy Neon's
  local-development guide uses, pinned by digest.
  Landed: `neonHttpExecutor` (`src/sql/neon-http.ts`), the
  `Neon HTTP integration` job on Postgres 17 running the contract over
  `neon()` and Neon's `Pool` (Drizzle `neon-http` as a smoke test), and a
  `"CONFIG"` message for `migrate` and `setTextSearchConfig` that names
  Neon's `Pool` until the next item; see
  [features/postgres.md](./features/postgres.md#client-detection).
- [x] `feat/cli-migrate-direct-connection`: when the memory file's store
  has no interactive transactions (Neon HTTP, a `batch`-only
  `SqlExecutor`), `migrate` and `text-search` connect on their own instead
  of failing, and take the dimensions, schema name and text search
  configuration from the memory file. Decided (decision 77): a Neon `Pool`
  on `DATABASE_URL_UNPOOLED`, falling back to `DATABASE_URL`, for Neon
  stores; the `postgres` package as today for others.
  Landed: `src/cli/direct.ts` and the internal
  `MemoryStore.directConnection`; the dimensions and schema come from the
  memory file, the text search configuration from the flag and the
  installation as before (the file holds none). A missing variable or
  driver and a URL that reaches another installation exit 2, a change the
  app's client does not see afterwards exits 1, `check` reads through the
  app's client, and `--json` plans carry `connection`; see
  [features/cli.md](./features/cli.md#stores-without-transactions).
- [x] `chore/shared-loader`: move what the CLI and `mnemocyte-mcp` share
  to load a memory file (`src/cli/resolve-hook.ts`, `src/cli/tsconfig.ts`
  and `MEMORY_FILE_NAMES`) into a private workspace package under
  `packages/` (`"private": true`, for example `@mnemocyte/loader`), a
  devDependency of both that tsdown bundles into their `dist/`. Then
  delete `packages/mcp/src/loader/` and `test/loader-copy.test.ts`, and
  keep the loader's tests in one place. Decided (decision 93), so
  `feat/cli-server-only` changes the resolve hook once, and
  `feat/cli-env-files` can put the `.env` order there for both. Check
  that `pnpm pack` lists the
  same files, that neither `package.json` gains a dependency, that
  `lint:package` and `lint:package:mcp` pass, and that the root entry
  still does not reach the loader. Update DEVELOPMENT.md ("Structure"),
  features/cli.md and features/mcp.md. No release of its own: users see
  no change.
  Landed: `@mnemocyte/loader` in `packages/loader/`, exporting its
  TypeScript source with no build, holding the hook, the tsconfig reader,
  both lookup lists and `findMemoryFile`, with its tests in
  `packages/loader/test/` (`pnpm test:loader`, on each Node job). Each
  bin's `loader-bundle.test.ts` matches the loader sources in its
  `dist/cli.mjs.map` against `packages/loader/src/`, and CI's Node,
  Package and MCP jobs now run on loader changes (decision 93).
- [x] `feat/cli-env-files`: the CLI reads `.env.local`, then `.env`, as
  Next.js does, so Next.js users can drop `--env-file .env.local`. `init`
  writes the API key to `.env.local` when that file exists. Decided
  (decision 78): no `.env.$(NODE_ENV)` files, and `.env.local` is skipped
  when `NODE_ENV` is `test`, as in Next.js. `mnemocyte-mcp` loads `.env`
  the same way today (`loadEnvironment` in `packages/mcp/src/cli/main.ts`),
  so change it to match.
  Landed: `loadEnvFiles` in `@mnemocyte/loader` (`src/env-files.ts`) for
  both bins, each keeping its own `--env-file` error; `init` counts a key
  in either file, writes to `.env.local` when it exists and checks
  `.gitignore` for the file it wrote; `mnemocyte-mcp`'s startup line ends
  with the files it read, and the CLI prints nothing new. Node's parser
  does not expand `$VAR` as Next.js does, which the guide lists as a
  limit (decision 78).
- [x] `feat/cli-server-only`: a memory file that imports `server-only`
  loads in the CLI. The package throws at import outside React's
  `react-server` condition, so a Next.js `memory.ts` that guards itself
  fails every command today. Decided (decision 81): the CLI's resolve hook
  maps `server-only` alone to an empty module. After `chore/shared-loader`
  the hook is in the shared loader package, which `@mnemocyte/mcp`
  bundles too, so the change is made once (decision 93).
  Landed: `resolveHook` maps the bare `server-only` to
  `mnemocyte:server-only` before Node resolves it, from any importer, and
  `loadHook` returns an empty ES module for it; a `data:` URL failed under
  `require()` on Node 24. Decided (decision 97): always rather than only when Node
  fails (an installed copy resolves to the file that throws),
  `client-only` left to Node, and nothing printed. Both bins' package
  tests run the built dist on a memory file that imports it and a `.cjs`
  file that requires it, with and without a stand-in of the package; see
  [features/cli.md](./features/cli.md#loading-the-memory-file).
- [ ] `feat/init-detect-app`: `init` finds the app's own Drizzle client
  (a `drizzle(...)` export in `src/db`, `db`, `src/lib/db` and the like,
  or `--db <path>`) and writes a `memory.ts` that imports it, in `src/lib/`
  for a Next.js app, with `import "server-only"`. Needs
  `feat/neon-http-driver`, `feat/cli-env-files` and `feat/cli-server-only`.
- [ ] `docs/nextjs-recipe`: a Next.js recipe in `guide/recipes.md`: Drizzle
  on Neon, `withMemory` in a route handler, extraction kept alive with
  `waitUntil: (promise) => after(() => promise)` (Next.js's `after` takes a
  callback), and `mnemocyte migrate --yes` in the build script. Write it
  after the items above, against the code as it then is.
- [ ] `fix/retry-529`: retry HTTP 529 like 503. OpenRouter's embeddings
  docs name 529 for an overloaded provider (its error list does not), and
  the built-in rule retries 408, 429, 500, 502, 503 and 504 only.
  Decided (decision 82): for every embedder, in `resilience.ts`.
- [ ] `feat/openrouter-embedder`: `openrouterEmbedder` in
  `mnemocyte/embedders`, on `fetch` like the others: `OPENROUTER_API_KEY`,
  `https://openrouter.ai/api/v1`, OpenRouter's `provider` object as
  `routing` (`provider` already means retry settings in `createMemory`),
  and `app: { name, url }` sent as `HTTP-Referer` and
  `X-OpenRouter-Title`. OpenRouter's model list has no vector size, so the
  known sizes come from the model descriptions and docs. `input_type` is
  sent by default for `perplexity/*` only (`query` and `document`, as in
  its docs; its v2 models reject a call without it); other models take
  `purposes`. Responses do not say which upstream provider served them, so
  the guide shows pinning with `routing`. `aiSdkEmbedder` learns OpenRouter
  model objects (`provider` is `'openrouter'`) the same way. Decided
  (decision 83): the reported model id drops the vendor prefix.
- [ ] `chore/shared-scope-sql`: one copy of the scope predicates for both
  SQL backends. `visibilityConditions`, `selectorConditions` and
  `exactScopeConditions` in `src/db/queries/memories.ts` and their twins
  in `src/db/libsql/queries.ts` differ only in the parameter type
  (`SqlParams` against `LibsqlParams`) and the always-true literal
  (`TRUE` against `1`), so they move to one module over a small
  `add(value)` interface both satisfy, with the literal passed in. Also share `driverDetail`
  (`src/memory/postgres.ts` and `src/memory/libsql.ts`) and the
  consolidation conflict checks that throw `"CONSOLIDATION_CHANGED"`.
  Decided (decision 96): the queries themselves stay per dialect. The
  generated SQL must not change: compare it before and after, and run the
  contract suite on PGlite and libSQL. No release of its own.
- [ ] `chore/release-schema-notes`: the release text format in
  DEVELOPMENT.md ("Releasing") gains a line for each schema change: what
  `drizzle-kit generate` will write after `mnemocyte generate`, and whether
  it rewrites a table or drops a column, because drizzle-kit compares
  schemas and knows nothing about the data Mnemocyte's own migrations
  carry over.
- [ ] `feat/installation-from-catalog`: read the embedding size from the
  embedding column's type modifier, as `inspect.ts` and `runner.ts` already
  do, instead of failing with `"INSTALLATION_INVALID"` when the
  `mnemocyte_meta` row is missing. drizzle-kit installations then need
  only the key index and pgvector by hand. Decided (decision 79): the row
  is written when the model is first recorded.
- [ ] `feat/migrate-sql-plans`: `migrate --dry-run --sql` prints the SQL a
  run would apply to this database, as pg-boss's `plans` does, so teams on
  Prisma Migrate, the Supabase CLI, Flyway, dbmate, Atlas, Knex or
  node-pg-migrate can paste it into their own migration. `--dry-run`
  prints migration names only today, and `mnemocyte sql` prints a fresh
  schema, not an upgrade.
- [ ] `feat/scope-key-expression-index`: migration 0005 adds a unique
  index on `(namespace, entity_id, coalesce(agent_id, ''),
  coalesce(session_id, ''), key) WHERE key IS NOT NULL`, the shape the
  libSQL backend already uses, and keyed writes name it in `ON CONFLICT`.
  Drizzle can declare it, so `generate --adapter drizzle` writes it into
  the schema file and the custom migration for it goes away.
  `getMemoryByKey` filters on `agent_id IS NULL`, which cannot use the new
  index, so rewrite it and bring `EXPLAIN (ANALYZE, BUFFERS)` evidence for
  both queries. Decided (decision 80): the old `NULLS NOT DISTINCT` index
  stays for one minor release, so clients on the previous version keep
  their `ON CONFLICT` target during a deploy; `drizzle-kit push` stays
  unsupported (see Later).
- [ ] `docs/migration-tools`: a guide section on applying Mnemocyte's
  migrations with the team's own tool (Prisma Migrate with
  `--create-only`, the Supabase CLI, Flyway, dbmate, Knex,
  node-pg-migrate), built on `feat/migrate-sql-plans`.
- [ ] `feat/drop-old-key-index`: a migration drops the old
  `NULLS NOT DISTINCT` key index that `feat/scope-key-expression-index`
  keeps for clients on the previous minor (decision 80), so writes
  maintain one key index again. Ship it at least one minor after the
  release with 0005, and say in the release text that apps still on a
  version before that release lose their `ON CONFLICT` target, so they
  must upgrade before this migration runs. Check what `fresh-install.sql`,
  `mnemocyte sql` and `generate --adapter drizzle` write for the key
  index at that point.

## Memory intelligence

Planned on 2026-11-23 from a comparison with mem0, Mastra, Zep and
Graphiti, Letta, Hindsight, Supermemory, Honcho, Cognee, LangMem,
turbomem and db0 (decision 90). The design is in
[ARCHITECTURE.md](./ARCHITECTURE.md#memory-intelligence). Each item's
PR decides the choices listed with it; the recommendation comes first.
The queue starts after the drivers queue, except `chore/eval-harness`,
which ships nothing to npm and can run at any time. Releases are grouped
when the drivers queue is done.

Facts checked on 2026-11-23; re-read the official pages in each PR:

- Hindsight (MIT, a Python server on Postgres + pgvector, which Python
  apps can also start in process) searches four ways in parallel
  (vector, BM25, graph links, time range), fuses them with RRF and
  reranks with a cross-encoder. It also keeps observations with their
  evidence, mental models (standing questions answered and rewritten in
  the background) and an opt-in redactor for secrets and personal data.
- Supermemory (MIT, self-hostable) keeps user profiles split into stable
  facts and recent activity, and handles contradictions and forgetting.
- Mastra keeps a working memory with a schema the app gives, and its
  observational memory compresses long threads into dated observations;
  its blog reports 94.87% on LongMemEval with gpt-5-mini.
- mem0's README reports 92.5 on LoCoMo and 94.4 on LongMemEval for its
  managed platform, and open-sources its evaluation framework.
- turbomem keeps a private eval package: product cases (extraction,
  recall@k, MRR, dedup, scope isolation) and LoCoMo with its official
  scoring, the dataset downloaded rather than committed.
- Graphiti stores when a fact was valid (`valid_at`, `invalid_at`) and
  when the graph learned or dropped it, and reranks with RRF, MMR, a
  cross-encoder or graph distance.
- The AI SDK 7 exports `rerank()`.

The items, in order:

- [ ] `chore/eval-harness`: a private workspace package, not published,
  that runs LongMemEval and LoCoMo through extraction, `context` and a
  chat model answering from it, plus product cases (recall@k, a changed
  fact replacing the old one, scope isolation). It runs by hand, never
  in CI. Results record the models, the judge and the retrieval
  settings, and baseline numbers for 1.x go into the PR. Choices:
  models through the AI Gateway, so one key covers them (recommended),
  or each provider's key; datasets downloaded at run time (recommended)
  or committed; and how many questions a full run uses, since every
  question costs model calls.
- [ ] `feat/reembed`: a supported switch to another embedding model on
  Postgres and libSQL, replacing the "no supported path" limitation in
  `guide/limitations.md`. Vectors are written in batches outside any
  transaction and resume after a failure, and search stays on the old
  model until the switch completes. The one-model-per-installation
  check then allows a switch in progress. Choice: a second embedding
  column for the new model, filled and then swapped by migrations
  (recommended, since it covers a new size too), or a fresh
  installation the rows are copied into. Needs `EXPLAIN (ANALYZE,
  BUFFERS)` evidence for the index build. Number: none; the product
  cases pass after a switch.
- [ ] `feat/extraction-supersede`: extraction may name the memories it
  was shown that a new fact replaces, and Mnemocyte supersedes them with
  `consolidate` in the exact bound scope. Choice: only `extracted:`
  memories by default, with an opt-in for app and `saveMemory` ones
  (recommended, since `guide/limitations.md` says extraction never
  changes them), or every memory it was shown. Number: LongMemEval's
  knowledge-update questions.
- [ ] `feat/profiles`: a short description of an entity that `context`
  renders before the search results, kept current by extraction and an
  `updateProfile` memory tool. Choice of shape: a JSON document with a
  schema the app gives, stored as a keyed memory (recommended: no new
  table, and Mastra's working memory has this shape), standing
  questions rewritten in the background (Hindsight's mental models), or
  stable and recent facts (Supermemory). Number: LongMemEval's
  preference questions.
- [ ] `feat/occurred-at`: when something happened, next to when it was
  stored: an optional `occurredAt`, `occurredBefore` and
  `occurredAfter` filters, a search of what was current at a past date
  (superseded memories included for the time they were current), and
  dates in `context` output, which shows none today. Extraction fills
  `occurredAt` when the user states a date. Ships as numbered
  migrations on Postgres and libSQL. Number: LongMemEval's
  temporal-reasoning questions.
- [ ] `feat/metadata-filters`: a `where` on `metadata` for `search`,
  `list`, `context` and `prune` (equality, `in`, existence, `and` /
  `or`) on every backend. On Postgres, a GIN index on the `jsonb` column
  only with `EXPLAIN (ANALYZE, BUFFERS)` evidence. Choice: a small
  operator set of our own (recommended; mem0's operators vary by vector
  store) or a known filter syntax. Number: none; it narrows what the app
  asks for, and the product cases check it.
- [ ] `feat/rerankers`: a `Reranker` contract next to `Embedder`, with
  fetch-based Cohere, Voyage and Jina rerankers, an `aiSdkReranker` over
  the AI SDK's `rerank()`, and maximal marginal relevance (MMR), which
  needs no network call. A reranker reorders the fused candidates before
  `limit`. Choice: a `mnemocyte/rerankers` subpath (recommended) or the
  `mnemocyte/embedders` one. Number: recall@k and LongMemEval overall.
- [ ] `feat/decay-boosts`: a recency half-life per kind and an opt-in
  boost from `accessCount` and `lastAccessedAt`, inside the boost
  formula so they never lift a poor match. Number: recall@k must not
  drop with the defaults.
- [ ] `feat/reflect`: `reflect` in `mnemocyte/ai-sdk` merges duplicate
  groups from `findDuplicates` into a survivor the app's model writes,
  keeps the merged memories as its evidence through `consolidate` and
  the audit log, and runs from a scheduled job. Starts under
  `experimental`. Number: LongMemEval multi-session questions, and
  fewer memories per scope after a run.
- [ ] `feat/observe`: a long conversation compressed into dated
  `episode` memories by the app's model, from messages the app passes
  in; Mnemocyte stores no chat history. Starts under `experimental`.
  Number: LongMemEval overall at a smaller `maxTokens`.
- [ ] `feat/extraction-batching`: extraction every few turns or past a
  token threshold, instead of after every response. Choice: where the
  turns wait between runs, since Mnemocyte stores no messages. Number:
  model calls per conversation, at the same LongMemEval score.
- [ ] `feat/before-add`: a hook that can change or reject a memory's
  content before it is embedded, run by `add`, `addMany` and `update`,
  so extraction, the memory tools and the MCP server go through it too,
  with a built-in redactor for common secret formats. It narrows the
  prompt-injection and secrets limitations in `guide/limitations.md`
  ("AI SDK tools" and "Extraction") but cannot remove them.
- [ ] `feat/studio`: `mnemocyte studio`, a local inspector over the
  memory file: browse scopes, search with `explain`, one memory's audit
  history, duplicates. Choice: read-only (recommended for the first
  release) or with edits.
- [ ] `chore/edge-runtimes`: check that the root import, the Postgres
  backend on Neon's HTTP driver and the libSQL backend on Turso load and
  run on Vercel Edge and Cloudflare Workers without Node built-ins, and
  PGlite on IndexedDB in a browser; fix what fails and document what
  works. Choice: which of them get a CI smoke test. This replaces the
  Edge item that was in Later.
- [ ] `feat/langgraph-store`: a LangGraph.js `BaseStore` on Mnemocyte,
  at a subpath with `@langchain/langgraph-checkpoint` (where `BaseStore`
  is defined; `@langchain/langgraph` re-exports it) as an optional peer.
- [ ] `feat/mastra-adapter`: Mnemocyte as memory for Mastra agents, at a
  subpath with the Mastra package as an optional peer. Read Mastra's
  memory processor and storage docs first to choose which one it is.
- [ ] `feat/openai-agents-tools`: the memory tools for the OpenAI Agents
  SDK for JavaScript, at a subpath with `@openai/agents` as an optional
  peer.
- [ ] `feat/transformers-embedder`: a local embedder on
  `@huggingface/transformers` as an optional peer, for setups and tests
  with no API key.
- [ ] `feat/mcp-claude-code-hooks`: Claude Code hooks for
  `@mnemocyte/mcp`: relevant memories added before each prompt, and
  extraction after a session on a model the user sets.

## Site

The website in `apps/site/`; its rules are in `apps/site/AGENTS.md` and
its spec in `apps/site/design/BRIEF.md`. Home, changelog, community and
the metadata are built; the site is not deployed yet (the maintainer
deploys it on Vercel).

- [ ] `feat/site-docs`: render `docs/guide/*.md` at `/docs`
  (getting started) and `/docs/[slug]` with `fumadocs-mdx` and
  `fumadocs-core`, headless, without `fumadocs-ui` (check their current
  docs first). The guides have no frontmatter: the title comes from the
  first heading. Rewrite relative links and match GitHub's heading
  anchors as BRIEF.md section 6 says, and build the layout it describes:
  the grouped sidebar with the "All guides" toggle under 960px, the code
  slabs with a copy button, and the previous, next and "Edit this page on
  GitHub" links. Add a build-time check that every link in `docs/guide`
  resolves to a page or an anchor and fails the build if one doesn't, and
  add the docs routes to `src/app/sitemap.ts`. Until it lands, `/docs` is
  a 404.

## Later

Not queued. Each one comes back as an item when its condition holds.

- `@mnemocyte/mcp` over Streamable HTTP for many users, when someone asks
  for a hosted server: the scope taken from authentication (OAuth 2.1 as
  the MCP specification's authorization section describes, or the app's
  own sessions) instead of flags, `Origin` checks and a localhost
  default. Decide first whether it belongs in the package or stays an
  example around `createMemoryMcpServer` (decision 87).

- SQLite + sqlite-vec, once sqlite-vec has a stable release (npm has 0.1.9
  today).
- A libSQL vector index (DiskANN, `libsql_vector_idx`), when a user has a
  scope the exact scan is too slow for (it took about 0.5 s at 10,000
  memories). `vector_top_k` ranks the whole table before the filters, so
  it would need a per-scope partial index or a fallback to the scan when
  too few rows survive, and `"postfilter"` would bring the warning
  decision 63 describes.
- Helpers for JavaScript store backends in `mnemocyte/store` (audit event
  builders, visibility and selector predicates, exact duplicate search,
  all internal today), when a third-party backend author asks; they would
  start under `experimental` (decision 72).
- `vitest` `^4` in the `mnemocyte/store/test` peer range, if a backend
  author on Vitest 4 asks and a CI run on it passes (decision 73).
- The CLI for libSQL without a memory file (a `LIBSQL_URL` like
  `DATABASE_URL`) and an `init` template for `@libsql/client`, when users
  ask.
- Recency that follows content updates rather than `createdAt`, if users
  find the note in `guide/api.md` ("Keys") is not enough.
- The memories `memoryMiddleware` / `withMemory` put in the prompt, given
  to the app (for citations), perhaps through an `onContext`-style
  callback, once `experimental.contextWithMemories` leaves `experimental`.
- OpenTelemetry on the observability hooks, when users ask for it. `onEvent`
  covers it in app code today; a subpath would add `@opentelemetry/api` as
  an optional peer.
- A weekly scheduled CI run on `main`, if a new Node 24 or 26 patch ever
  breaks a build between PRs.
- A workflow lockfile (`.github/workflows/actions.lock`, made with
  `gh actions-lock`) instead of SHA pins, once GitHub's docs say it is
  generally available or an action the workflows use becomes a composite
  action that uses other actions (decision 58).
- A Windows CI job for the package and CLI tests (`tar.exe`, directory
  junctions), if a Windows-only bug ships; the maintainer develops on
  Windows, and Windows runners are slower.
- `drizzle-kit push` as a supported way to manage Mnemocyte's tables, once
  drizzle-orm 1.0 is stable (decision 52) and drizzle-kit no longer drops
  and re-creates an index that mixes columns and an expression on every
  push (drizzle-orm issue #6386, open and labeled fixed in beta). The
  guide then also tells drizzle-kit 1.0 users to set
  `schemaFilter: ["public"]`, since 1.0 manages every schema by default
  and 0.x only `public` (decision 80).
- `mnemocyte generate --adapter prisma`, when a Prisma user asks. Prisma
  can only declare the vector column as `Unsupported("vector(1536)")` and
  cannot declare the HNSW index or the generated `tsvector` column, so
  much of the schema would still be hand-written SQL in a
  `--create-only` migration; `feat/migrate-sql-plans` covers that today.
- More HTTP Postgres drivers, when a user asks for one by name. Each is a
  `query` plus `batch` adapter like `feat/neon-http-driver`.
- Entities (ARCHITECTURE.md "Memory intelligence"): names extracted with
  facts, kept in a link table, with entity overlap as a third ranked list
  in the fusion, when the eval harness shows questions that need facts
  about one person or thing gathered across memories, and the items
  above do not fix them. mem0's open-source SDK also boosts search
  results by shared entities without a graph database.
