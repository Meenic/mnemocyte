# Roadmap

The work queue to 1.0. Each item is one branch and one PR; a session picks up
the first unchecked item. The design behind each item is in
[ARCHITECTURE.md](./ARCHITECTURE.md). Tick an item in the PR that completes
it.

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
- [x] `feat/embedders-voyage-cohere-google`: fetch-based embedders
  (decision 29).
- [x] `fix/ai-sdk-gemini-embedding-2`: `aiSdkEmbedder` sends the text
  prefixes `googleEmbedder` uses (`task: search result | query: `,
  `title: none | text: `) instead of `taskType` for `gemini-embedding-2`,
  which is now a known model (3072) (decision 25).

## Phase 3: operations (0.8)

- [x] `feat/consolidate-stable`: graduate `consolidate`; survivor-aware
  deletes; kNN-based `findDuplicates`.
- [x] `fix/observability-non-blocking`: hooks no longer awaited; failures go
  to an optional `observability.onError`.
- [x] `fix/audit-atomic`: audit events in the same statement or transaction
  as the write they record, for every write path (`add`, `addMany`,
  `update`, `delete`, `prune`, `consolidate`), so a failed audit write
  fails the call instead of being swallowed.
- [x] `feat/audit-retention`: `pruneAuditLog` (decision 32) and pruning
  guidance.
- [x] `chore/benchmarks`: Postgres benchmarks with
  `EXPLAIN (ANALYZE, BUFFERS)` evidence for every default index.
- [x] `fix/filtered-ef-search`: measured `hnsw.ef_search` 40–400 for
  filtered vector search; the default stays `max(40, limit)` because a
  higher value makes the planner leave HNSW on some tables (decision 33).
- [x] `fix/relaxed-order`: measured `hnsw.iterative_scan = relaxed_order`
  with a materialized CTE that re-sorts, against `strict_order`; the search
  vector query adopted it (82.7% → 95.8% of the exact rows at 1,536
  dimensions, 61.7% → 80.7% with `kinds`, same plans) (decision 34).
- [x] `fix/duplicates-relaxed-order`: measured `relaxed_order` for
  `findDuplicates` on its HNSW path (scope index dropped) against
  `strict_order`, and adopted it without a CTE: 187 → 200 of 200 pairs,
  30.1 → 21.2 s, same plan (decision 34).
- [x] `feat/duplicates-chunks`: `findDuplicates` over a large scope in
  chunks (a cursor over the memories it compares, or a time budget), since
  a 30,000-memory scope takes minutes on one statement and cannot be
  resumed (features/maintenance.md). Landed as
  `experimental.findDuplicatesPage` with a cursor and `batchSize`
  (decision 35).
- [x] `feat/cli`: a `mnemocyte` bin that loads the app's `memory.ts` (root,
  `lib/`, `src/`, `src/lib/` or `--config`) for its store and embedder.
  `migrate` asks before enabling pgvector (`--yes` for CI) and supports
  `--dry-run`; `check` reports the pgvector version, applied migrations and
  dimensions and exits non-zero on a problem; `sql` prints the fresh-install
  schema without a database (replaces running `render-initial.mjs` by path).
  Without a memory file, `--dimensions` and `DATABASE_URL` with the installed
  `postgres` peer. No new dependencies. The getting-started guide's
  `migrate.ts` and `db:migrate` script become `npx mnemocyte migrate`, and
  the missing-schema hint from `fix/migration-hint` names the command.
  Landed with `module.registerHooks` for the resolve hook and `.env`
  loading (decision 36).
- [x] `chore/drop-drizzle-kit`: the CLI and `migrate()` apply migrations,
  so the `drizzle-kit` dev dependency, `drizzle.config.ts`, the
  `db:migrate` script and the drizzle-kit snapshots in `migrations/meta/`
  go. The journal stays: `migration:bundle` reads it.
- [x] `feat/cli-init`: `npx mnemocyte init` writes a `memory.ts` for the
  driver it finds in `package.json` (`postgres`, `pg`,
  `@electric-sql/pglite`, `drizzle-orm`) in the first of the folders the
  CLI searches that exists, and adds `OPENAI_API_KEY=` to `.env` when the
  variable is missing. It never overwrites a file, prints every change, and
  supports `--dry-run`.

## Phase 4: 1.0

The breaking changes from the freeze review (decision 38) land first, one
branch each; `docs/v1` comes last.

- [x] `feat/audit-log-pages`: `listAuditLog` returns
  `{ events, nextCursor }` and takes an opaque `cursor`, like `list`,
  instead of an array paged with `beforeCursor` / `afterCursor`; `before`
  and `after` stay as filters. `AuditEvent.type`, typed as a union of the
  five event names, replaces `description` (the column keeps its name).
  `listAuditLog` takes a selector like `pruneAuditLog`: `entityId`
  optional, plus `allNamespaces: true`. Landed with a cursor that keeps
  the timestamp's microseconds, so entity pages still read the scope
  index; pages across entities sort.
- [x] `chore/drop-legacy-surface`: remove `experimental.consolidate` (the
  deprecated alias, as promised for 1.0), `postgresJs()`, `drizzleStore()`
  and the `mnemocyte/stores/drizzle` subpath, which take positional
  arguments and duplicate `store: client`; `postgresStore({ client })`
  stays. Drop `migrations/0000_initial.sql.template`,
  `migrations/render-initial.mjs` (replaced by `mnemocyte sql`),
  `migrations/meta/_journal.json` and the empty `dist/cli.d.mts` from the
  tarball; the numbered SQL files and `fresh-install.sql` keep shipping.
  Landed with `pnpm migration:bundle` reading the numbered files directly
  and also rendering `fresh-install.sql`; the template stays in the
  repository as the bundle's source.
- [x] `fix/strict-options`: unknown keys in `createMemory`'s config, the
  embedder options and the AI SDK options throw `"CONFIG"` instead of being
  ignored. TypeScript catches a misspelled key only in an object literal;
  from JavaScript, or with options built elsewhere,
  `openaiEmbedder({ baseURL })` today sends the texts and
  `OPENAI_API_KEY` to api.openai.com.
  Rename `baseUrl` to `baseURL`, the AI SDK's spelling, and the extraction
  `timeout` to `timeoutMs`, like `provider.timeoutMs`. `kinds` and `tags`
  inputs become `readonly` arrays everywhere (additive). Landed checking
  every nested settings object too, with a pointed error for the two old
  names; `extractMemories` still accepts `finishReason`, so a spread
  `MemoryTurn` works.
- [x] `feat/error-reasons`: a stable `reason` on `MnemocyteError` for the
  cases one code covers today (`CONFLICT`: key in use, consolidation link;
  `CONFIG`: bad config, embedder or dimensions that do not match the
  installation; `MIGRATION`: missing schema, mixed models, failed
  migration), so callers never match on messages. `isMnemocyteError`
  checks a `Symbol.for` brand instead of `instanceof`, so two copies of the
  package recognise each other's errors. Document which unions may gain
  members in a minor (error codes and reasons, observability operations,
  backends, audit event types) and fix the 0.5 example in the
  `MnemocyteError` JSDoc. The dimensions-mismatch `"CONFIG"` message says
  to "render and apply a migration for the selected embedding dimension",
  which does not exist (`migrate` rejects a different dimension on an
  existing installation); it should name what does work.
- [x] `docs/v1`: API freeze review, README and feature docs pass, upgrade
  guide from 0.5. Also: decision 3's list of what 1.0 covers (the Voyage,
  Cohere and Gemini embedders, middleware, extraction, the CLI's commands,
  flags and exit codes but not its text); the recall numbers in
  `guide/limitations.md` (88% / 60% are `strict_order` runs; the benchmark
  build gives 95.8% / 80.7% with `relaxed_order`, and recall varies between
  index builds) and its "renderer" wording; the stale "Phase 1" note in
  `features/postgres.md` "Known problems"; `init` in the README's setup
  line. New limitations: the English text search configuration is fixed
  in the schema, so other languages get English stemming and stop words;
  switching embedding models has no supported path beyond re-embedding or
  deleting rows by hand ("Repair mixed models" in `guide/postgres.md`);
  and how an update from 0.7 behaves (prune with dependents, approximate
  `findDuplicates`, hooks not awaited).

A second API review before the release (2026-11-14) adds three items. Its
findings that decisions 3, 38 and 39 already settle (array results for
`search` and `findDuplicates`, extraction covered by semver) are not
reopened; its additive findings are in "After 1.0".

- [x] `fix/optional-undefined`: optional input fields accept an explicit
  `undefined`. With `exactOptionalPropertyTypes`, `cursor?: string`
  rejects a `string | undefined` variable, so the cursor loops in
  `guide/api.md` (`list`, `experimental.findDuplicatesPage`,
  `listAuditLog`) fail with TS2379, and so does passing an optional
  `signal` through; the package's own code spreads
  `...(x === undefined ? {} : { x })` to get around it. Widen the optional
  fields of the method inputs, the bound inputs, the embedder options and
  the AI SDK options to `?: T | undefined`, after checking that each one
  already treats `undefined` as absent at runtime. Additive. An export type
  test compiles the guide's loops with the flag on. Landed with the scopes
  and the config types (`MemoryConfig` and its nested settings,
  `MnemocyteStoreConfig`, `migrate`'s input) widened too, as the maintainer
  chose: `createMemory({ namespace: process.env.… })` hit the same error.
  The one runtime gap was `retrieval.fusion` and `retrieval.boosts`, spread
  over their defaults, so a weight set to `undefined` threw `"CONFIG"`.
  `RetrievalExplanation`'s `fusion` and `boosts` became plain number
  fields, since `Required<>` keeps an explicit `undefined`. The internal
  `...(x === undefined ? {} : { x })` spreads stay, as the maintainer chose:
  most feed internal store types that stay exact on purpose.
- [x] `fix/created-filters`: one name for the creation-time filter.
  `search` filters `createdAt` with `before` / `after`, `prune` with
  `createdBefore`, and `listAuditLog` / `pruneAuditLog` use `before` /
  `after` for the event time. Either rename `search`'s pair to
  `createdBefore` / `createdAfter` (breaking, so before 1.0) or keep it and
  record why; the maintainer decides. The "After 1.0" filters on `list`
  and `context` take the chosen name. Landed as a rename (decision 40);
  the internal `StoreMemoryFilter` took the same names. Method inputs are
  not checked for unknown keys, so `before` / `after` on `search` throw
  `"VALIDATION"` naming the new key, as the maintainer chose.
- [ ] `fix/strict-inputs`: unknown keys on method inputs. Config and
  embedder options throw `"CONFIG"` for a key they do not take (decision
  38), but method inputs ignore one, so a misspelled `kind` on `search` or
  `expird` on `prune` is silently dropped and the call matches more than
  asked. Rejecting them after 1.0 would be breaking. Decide whether method
  inputs throw `"VALIDATION"` for unknown keys before 1.0, and whether the
  bound client's inputs share the check.
- [ ] `docs/api-review`: documentation fixes from the review; no code
  change.
  - Stability (`guide/api.md`, revising decision 39): text the model reads
    (tool descriptions, the middleware preamble, the extraction prompt) may
    change in a minor, like `context()` wording; `MemoryPrompt`,
    `MemoryLanguageModel`, `MemoryFinishReason` and `AiSdkProviderOptions`
    are derived from the `ai` peer's types and follow them; the
    experimental exemption covers the root exports `FindDuplicatesPageInput`,
    `DuplicatePage`, `BoundFindDuplicatesPageInput`,
    `ExperimentalMemoryClient` and `BoundExperimentalMemoryClient`, and the
    `"findDuplicatesPage"` member of `MnemocyteOperation`.
  - Examples that do not type-check: "Bound scopes" in `guide/api.md`
    assigns `memory.for({ entityId: user.id })` to `user` itself (TS2448);
    the custom embedder in `guide/embedders.md` has no `Embedder`
    annotation, so its parameters are implicit `any`; the JSDoc of
    `createMemory` and `postgresStore` calls
    `postgres(process.env.DATABASE_URL)`, which matches no overload without
    `!`.
  - Drift: `TIMEOUT` in the errors table also comes from
    `extractMemories`' `timeoutMs`; `MemoryConfig.defaults` applies to
    `context` too, not only `search`; `guide/embedders.md` checks
    `instanceof ProviderError` where `guide/api.md` recommends the brand;
    the no-argument list in "Bound scopes" leaves out
    `experimental.findDuplicatesPage`; the `limit` JSDoc on `ListInput` and
    `ListAuditLogOptions` says "positive integer" instead of 1 to 1,000.
  - `deleteScope` is listed with the bulk selectors but requires
    `entityId` and has no `allNamespaces`; say so, and that it is on
    purpose (an erasure names its entity).

## Cut first if time runs short

`mnemocyte init`.

## After 1.0

- libSQL / Turso backend, then SQLite + sqlite-vec once it is stable. A
  backend that runs on the user's own client, as Postgres does, ships as a
  subpath of `mnemocyte` (`mnemocyte/libsql`), not as its own package. If
  SQLite needs the `sqlite-vec` package as a dependency of ours, rather
  than the user loading the extension on their own connection, the
  packaging rule below makes it a package of its own.
- Public `MemoryStore` contract: versioned in its name (`MemoryStoreV1`) so
  the core can accept two versions during a change instead of forcing a
  major, exported from a subpath (`mnemocyte/store`), with the contract
  test suite shipped beside it (`mnemocyte/store/test`) so third-party
  backends can prove they conform. Third-party backends are their own
  packages with `mnemocyte` as a peer (`^1`). A separate contract package,
  as `@ai-sdk/provider` is for the AI SDK, only if third-party backends
  become common.
- `@mnemocyte/mcp`, the first separate package: it brings the MCP SDK and
  a `bin`. It lives in a pnpm workspace in this repository and takes
  `mnemocyte` as a peer (`^1`), the way `@mastra/pg` takes `@mastra/core`;
  it uses only the public API, so it needs no exact pins.
- Packaging rule (decision 1, revised 2026-11-15): split out a package only
  when it needs dependencies of its own or its own release cadence. Drizzle
  and Kysely stay one package for the same reason: the user brings the
  driver, and the drivers are optional peers. If first-party code ever does split (`@mnemocyte/core`,
  `@mnemocyte/postgres`), `mnemocyte` stays as an umbrella package that
  depends on them with exact pins, releases with them, and re-exports every
  current import path (`mnemocyte`, `mnemocyte/postgres`,
  `mnemocyte/embedders/*`, `mnemocyte/ai-sdk`, the CLI), as `better-auth`
  does with `@better-auth/core` and its adapters. That keeps the split
  non-breaking, so it can ship in a 1.x minor. The raw-client shortcut
  (`createMemory({ store: sql })`) then lives in the umbrella; the core
  alone takes a `MemoryStore` such as `postgresStore({ client })`.
- Drizzle schema export (`mnemocyte generate --adapter drizzle`) so Drizzle
  users manage the tables with `drizzle-kit`.
- A `schemaName` option to keep the tables outside `public`.
- OpenTelemetry integration on the observability hooks.
- Additive items from the freeze review: a context method that also
  returns the memories it used; `createdBefore` / `createdAfter` on
  `list` and `context`; `signal` on `stats`; `agentId` / `sessionId` on observability
  events; a custom `fetch` on the fetch-based embedders; `--json` for
  `check` and `migrate --dry-run`; an install-time text search
  configuration; an indexed memory id on audit events for per-memory
  history.
- Additive items from the second API review: an `isProviderError` guard
  next to `isMnemocyteError`; `headers` on every fetch-based embedder, not
  only `openaiCompatibleEmbedder`; `BoundPruneInput` and `BoundStatsInput`
  aliases (the bound `prune` takes `PruneSelectors`, which also holds
  `dryRun` and `signal`; renaming it is breaking after 1.0); aliases that
  give the two `purposes` types matching names (`PurposeHints`,
  `AiSdkPurposeOptions`).
