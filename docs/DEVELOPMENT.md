# Development

What is built today and how to work on it. The target design lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); when one of its items lands, its section
moves here or into [features/](./features/).

User-facing documentation is `README.md` plus [guide/](./guide/): getting
started, the API reference, Postgres setup, embedders, the AI SDK and
limitations. A change users can see
updates the matching guide page in the same PR.

Feature areas:

- [features/postgres.md](./features/postgres.md): schema, migrations and
  the `migrate()` runner, installation metadata, connections (`SqlExecutor`,
  client detection, the lazily loaded backend for `store: client`, the
  postgres.js, node-postgres and PGlite adapters, `postgresStore`,
  `drizzleStore(db)`).
- [features/scopes.md](./features/scopes.md): scopes and their matching
  rules, the default namespace and bound clients, keyed `add`, `get`,
  `list` pagination, `update`, `deleteScope`, the client lifecycle.
- [features/retrieval.md](./features/retrieval.md): search, scoring, access
  tracking, `context`.
- [features/maintenance.md](./features/maintenance.md): delete, prune,
  duplicates, consolidation, audit log, stats.
- [features/embedders.md](./features/embedders.md): the `Embedder` contract
  (`purpose`, `maxBatch`), `openaiEmbedder`, `openaiCompatibleEmbedder`,
  `voyageEmbedder`, `cohereEmbedder`, `googleEmbedder` and
  `aiSdkEmbedder`, `ProviderError`, retries, timeouts, cancellation,
  observability.
- [features/ai-sdk.md](./features/ai-sdk.md): `memoryTools`, its schemas,
  validation and scope boundary; `memoryMiddleware` and `withMemory`;
  extraction with `save: { model }` and `extractMemories`.

## Setup

- Node.js 22.18 or newer. CI runs 22.18, 24 and 26.
- pnpm 12.15.0, matching `packageManager` in `package.json`. CI reads the
  version from that field.
- Postgres with pgvector only for the integration suite.

```bash
pnpm install --frozen-lockfile
pnpm dev     # tsdown in watch mode
pnpm build   # writes dist/
```

Mnemocyte is a library; there is no app to run. Try changes through the tests
or from a consuming project.

## Structure

```txt
src/
  index.ts              root entry: createMemory, migrate, errors, public types
  client.ts             createMemory: config checks, store (resolveStore | in-memory), overloads for namespace
  migrate.ts            migrate(): validates input, resolves { memory } or { store } (resolveStore), calls the store's migrate
  postgres.ts           `mnemocyte/postgres` entry: postgresStore, postgresJs, client types
  ai-sdk.ts             `mnemocyte/ai-sdk` entry: aiSdkEmbedder, re-exports memoryTools
  ai-sdk-tools.ts       memoryTools: searchMemories, saveMemory, forgetMemory over a bound client
  ai-sdk-middleware.ts  memoryMiddleware and withMemory: context in the prompt, save hook or extraction
  ai-sdk-extraction.ts  extractMemories: the user's model extracts keyed memories from a turn
  types.ts              every public type
  errors.ts             MnemocyteError and its codes, ProviderError
  http-embedder.ts      createFetchEmbedder (fetch core of every HTTP embedder), createHttpEmbedder (OpenAI-shaped), option checks
  provider-error.ts     createProviderError, error body parsing, Retry-After parsing
  observability.ts      onEvent lifecycle (start / success / error)
  resilience.ts         provider timeout, retry rule, jittered backoff, abort
  memory/
    client-core.ts      shared orchestration for every client method
    scope-binding.ts    the default namespace layer and memory.for() bound clients
    client-internals.ts the client's store and embedder under a symbol, for migrate({ memory })
    store.ts            the internal MemoryStore contract, scopes and selectors
    in-memory.ts        in-memory MemoryStore
    postgres.ts         Postgres MemoryStore (runs on a SqlExecutor)
    store-input.ts      resolveStore: a store config, or a client detected by shape → lazy store
    store-config.ts     the opaque store config envelope from postgresStore() and drizzleStore()
    lazy-store.ts       MemoryStore that loads the real one on its first call
    postgres-backend.ts dynamic import() target: client → Postgres MemoryStore
    validation.ts       runtime input and config validation
    limits.ts           input size caps (content, tags, metadata, key, limit)
    json.ts             JSON metadata validation and deep clone
    embeddings.ts       embedder calls and output validation
    filters.ts          in-memory visibility, selector and filter predicates
    cursor.ts           opaque list cursors
    records.ts          ids, tag normalization, cloning
  sql/
    executor.ts         SqlExecutor: query, optional transaction and batch
    detect.ts           detectClient: shape checks, PostgresClient types (no adapters, in the root entry)
    clients.ts          executorFor / toSqlExecutor: detected client → its adapter
    postgres-js.ts      postgresJs(sql): the postgres.js adapter
    node-postgres.ts    the node-postgres Pool adapter
    pglite.ts           the PGlite adapter
    scoped.ts           transaction executor with savepoints (pg, PGlite)
  db/
    sql.ts              bind-parameter collector for building statements
    atomic.ts           runAtomically (batch or transaction), insert chunking
    errors.ts           constraint name from either driver error shape
    rows.ts             row types, column lists, row normalization
    queries/            memories, events, meta SQL on a SqlExecutor
    migrations/         Postgres migration runner and bundled.ts (generated)
  retrieval/scorer.ts   cosine, lexical overlap, rank fusion, boosts
  context/              context(): formatters, token budget
  embedders/            openai, openai-compatible, voyage, cohere, google (fetch only)
  stores/drizzle.ts     drizzleStore(db)
migrations/             SQL migrations, template, renderer, Drizzle journal
scripts/                bundle-migrations.mjs, check-package.mjs
test/                   unit, package, integration, fixtures, benchmarks
```

`dist/` is built by tsdown from the entries in `tsdown.config.ts`:
`src/index.ts`, `src/ai-sdk.ts`, `src/postgres.ts`, `src/embedders/*.ts`
and `src/stores/*.ts`. The package has no runtime dependencies. `postgres`,
`pg`, `@electric-sql/pglite` and `drizzle-orm` are optional peer dependencies
at the versions the tests run; source files import at most their types
(`postgres` and `drizzle-orm` only), so no built entry imports a driver (a
package test checks this). They are also dev dependencies, with `@types/pg`
and `@electric-sql/pglite-pgvector`. `ai` is an optional peer too
(`^7.0.135`) and a dev dependency (it brings `zod`, its peer, into the
lockfile); `src/ai-sdk.ts`, `src/ai-sdk-tools.ts`,
`src/ai-sdk-middleware.ts` and `src/ai-sdk-extraction.ts` import it at
runtime, the only source files that do, and a package test follows
the static imports of every other entry to check that none reaches it.

TypeScript compiles against `target` and `lib` `es2024`, the newest edition
Node 22.18 fully supports. `isolatedDeclarations` is on for `src/`, so every
export needs a type a declaration emitter can read without inference
(explicit return types on exported functions); the test projects turn it
off. The `.mjs` files ship with source maps that embed
their sources. The `.d.mts` files ship without maps, because a declaration
map points at `src/`, which is not published. With `sourcemap` on, rolldown
writes a `sourceMappingURL` comment into every chunk, `.d.mts` included, and
rolldown-plugin-dts drops the declaration maps without removing it; a small
plugin in `tsdown.config.ts` strips that comment.

## Conventions

- Shared behavior goes in `memory/client-core.ts`; backend mechanics stay in
  the `MemoryStore` implementations. Both backends must pass the same shared
  fixtures in `test/fixtures/`.
- Validation runs before any embedder or storage call. Invalid input throws
  `MnemocyteError` with code `"VALIDATION"`; invalid configuration throws
  `"CONFIG"` synchronously from `createMemory`.
- Input sizes are capped in `memory/limits.ts`, the same on every backend:
  `limit` 1–1,000, `content` and `query` 32,000 characters, 64 tags of 128
  characters, metadata 64 KiB as UTF-8 JSON and 32 levels deep (checked
  while cloning, so deep nesting cannot exhaust the stack), `key` 512 and
  each scope field 256 UTF-8 bytes, `addMany` 1,000 memories. The user guide
  lists them in `docs/guide/api.md#input-limits`.
- Write paths embed first, outside any transaction, then write. A write that
  needs several statements goes through `runAtomically` (`db/atomic.ts`),
  never through a hand-rolled transaction, so drivers with only
  `SqlExecutor.batch` run it too.
- Caller-owned values (tags, metadata, dates) are snapshotted when a method is
  called. Returned records are detached copies.
- Metadata is JSON value data (`JsonObject`). Anything else is rejected.
- Store results are not trusted: shared code rejects missing, duplicate or
  unknown rows from `insertMemories` (matching by id, or by key for keyed
  upserts) and restores input order.
- Every store method that touches memories takes a scope: a visibility for
  reads and writes by id, a selector for bulk operations (see
  [features/scopes.md](./features/scopes.md)).
- Vectors are written with the shortest round-trip number format
  (`db/vector.ts`). Fixed decimal precision would turn small components into
  zero.
- Driver errors are mapped to `MnemocyteError`: missing tables or columns
  become `"MIGRATION"`, everything else `"DB"`.
- `@types/node` stays on the major of the minimum supported Node version.

## Public API

Exports:

- `mnemocyte`: `createMemory`, `migrate`, `MnemocyteError`,
  `isMnemocyteError`, `ProviderError` and the public types, including
  `PostgresClient`.
  `createMemory({ store })` and `migrate({ store })` take a store config or
  a database client; the Postgres backend loads with a dynamic `import()`
  on first use (see
  [features/postgres.md](./features/postgres.md#lazy-loading)). The root
  entry must not import the backend statically; a package test follows its
  static imports to check.
- `mnemocyte/embedders`: `openaiEmbedder`, `openaiCompatibleEmbedder`,
  `voyageEmbedder`, `cohereEmbedder`, `googleEmbedder` and their option
  types (`OpenAIEmbedderOptions`, `OpenAICompatibleEmbedderOptions`,
  `PurposeHint`, `PurposeHints`, `VoyageEmbedderOptions`,
  `CohereEmbedderOptions`, `GoogleEmbedderOptions`);
  `mnemocyte/embedders/openai`, `/openai-compatible`, `/voyage`, `/cohere`
  and `/google` export one each. `ProviderError`, `EmbedOptions` and `EmbeddingPurpose`
  come from the root.
- `mnemocyte/ai-sdk`: `aiSdkEmbedder` and its `AiSdkEmbedderOptions`,
  `AiSdkProviderOptions` and `AiSdkPurposeOptions` types; `memoryTools` and
  its `MemoryToolsOptions`, `MemoryTools`, `SearchMemoriesInput`,
  `SearchMemoriesOutput`, `FoundMemory`, `SaveMemoryInput`,
  `SaveMemoryOutput`, `ForgetMemoryInput` and `ForgetMemoryOutput` types;
  `memoryMiddleware`, `withMemory` and their `MemoryMiddlewareOptions`,
  `WithMemoryOptions`, `MemoryMiddlewareContextOptions`, `MemoryTurn`,
  `MemoryMiddlewareError`, `MemoryPrompt`, `MemoryFinishReason`,
  `MemoryLanguageModel`, `MemoryWrappedModel`, `MemorySaveHook` and
  `MemorySaveOptions` types; `extractMemories` and its
  `ExtractMemoriesInput` and `ExtractMemoriesOptions` types; needs the `ai`
  peer.
- `mnemocyte/postgres`: `postgresStore({ client })`, `postgresJs(sql)` and the
  `SqlExecutor`, `SqlStatement`, `SqlQueryOptions`, `PostgresJsExecutor`,
  `PostgresClient`, `PostgresJsClient`, `NodePostgresPool` (with its
  client and result types), `PGliteClient` (with its transaction and result
  types) and `DrizzleClient` types.
- `mnemocyte/stores/drizzle`: `drizzleStore(db)` and `DrizzleClient`.

`package.json` lists each subpath explicitly, with a `types` and a `default`
condition; there are no wildcard subpaths, so a new entry needs its own
`exports` line. The `default` condition lets CommonJS load the package:
since Node 22.12, `require()` loads synchronous ES modules and returns their
namespace. It throws `ERR_REQUIRE_ASYNC_MODULE` if any module in the graph
uses top-level `await`, so `dist/` must not.

Client methods: `add`, `addMany`, `search`, `get`, `list`, `update`,
`delete`, `deleteScope`, `context`, `prune`, `findDuplicates`,
`listAuditLog`, `stats`, `consolidate`, `for` and the deprecated
`experimental.consolidate` alias (removed in 1.0). There is no `close()`.
`for(scope)` returns a `BoundMemoryClient` with the same methods minus
`scope`, `allNamespaces` and `for`, plus a read-only `scope`.

Design rules for the public surface:

- One object parameter per method; new options are optional fields.
- Errors are `MnemocyteError` with a stable `code`; callers branch on the
  code, never the message.
- Every long-running method accepts `signal: AbortSignal`.
- New or unproven behavior goes under `experimental` first.
- Every method that reads or writes memories takes a `scope` (or is bound
  to one); a global operation needs `allNamespaces: true`, which bound
  clients do not offer.
- A new method that takes a `scope` gets a `DefaultNamespace` type
  parameter on its input, a wrapper in `createScopedClient` and one in
  `bindScope` (`memory/scope-binding.ts`), and a `Bound…Input` type.
- Breaking changes ship in a new minor (0.x) with a `CHANGELOG.md` entry and
  an upgrade note (the 0.5 → 0.6 table is in `docs/guide/api.md`).

## Testing

Vitest has three projects (`vitest.config.ts`):

| Project | Files | Imports | Command |
|---|---|---|---|
| `unit` | `test/**/*.test.ts` except integration, contract, package, benchmarks | `src/` through aliases | `pnpm test:unit` |
| `contract` | `test/contract/**/*.test.ts` | `src/` through aliases | `pnpm test:contract` |
| `package` | `test/package/*.test.ts` | built `dist/` through self-reference | `pnpm test:exports` |
| `integration` | `test/integration/**/*.test.ts` | `src/` through aliases | `pnpm test:integration` |

- `unit` and `integration` map `mnemocyte` to `src/` with `resolve.alias`,
  and `tsconfig.test.json` does the same with `paths`. The `package` project
  and `test/package/tsconfig.json` have neither: `mnemocyte` resolves to
  `dist/` through the package's own `exports` (package self-reference), the
  way a consumer resolves it.

- `pnpm test` builds, runs `pnpm test:types`, then runs `unit`, `contract`
  and `package`. This is what CI runs on every push. `pnpm test:exports` does the
  same for `package` alone.
- `pnpm test:types` runs `tsc --noEmit -p test/package/tsconfig.json`, which
  type-checks every public export in `test/package/exports-types.test-d.ts`
  against the built `dist/*.d.mts`, so it needs a build first. The file has
  no `test()` blocks, and Vitest's `--typecheck` drops type errors outside
  test blocks, so plain `tsc` checks it instead. The `@ts-expect-error`
  negative cases fail with TS2578 if they stop being errors.
- The package tests pack the tarball and install it into a temporary
  consumer with `drizzle-orm`, `postgres`, `pg`, PGlite and `ai` absent.
  They extract with the system `tar` using relative paths, so GNU tar,
  bsdtar and Windows' `tar.exe` all work. The consumer runs an in-memory
  client from ESM and, through `require()`, a client with a `SqlExecutor`
  as `store`, which loads the Postgres chunk lazily; `require()` would throw
  if any module used top-level `await`. Then it links the dev `ai` into its
  `node_modules` (a directory junction, which Windows allows without
  symlink rights) and embeds through `mnemocyte/ai-sdk` with an AI SDK mock
  model, checking that an `APICallError` comes out as the root entry's
  `ProviderError`, runs `searchMemories` from `memoryTools`, and calls
  `generateText` on a `withMemory` mock model to check the context
  reaches the prompt, and `extractMemories` with a mock model to check it
  stores a keyed memory.
- `test/embedders/voyage.test.ts`, `cohere.test.ts` and `google.test.ts`
  stub `fetch` (helpers in `fetch-mock.ts`) and check each request's URL,
  headers and body per purpose, the dimension rules, response checks and
  error mapping against the error bodies the provider docs show. No test
  calls a provider.
- `test/embedders/ai-sdk.test.ts` drives `aiSdkEmbedder` with the AI SDK's
  `MockEmbeddingModelV4` and `customProvider` (as the global provider for
  string ids), and with a real `createGateway` provider over a mocked
  `fetch`, which checks the gateway request body and its error mapping.
- `test/ai-sdk/tools.test.ts`, `middleware.test.ts` and
  `extraction.test.ts` drive the tools, the middleware and extraction
  directly and through `generateText` and `streamText` with
  `MockLanguageModelV4` (see
  [features/ai-sdk.md](./features/ai-sdk.md#tests)).
- `pnpm lint:package` builds, packs once into a temporary folder and runs
  publint `--strict` and attw on that tarball. attw uses the `node16`
  profile, which skips node10 resolution (it cannot see subpath `exports`),
  and ignores `cjs-resolves-to-esm`, because attw does not model `require()`
  of ES modules (Node 22.12+). CI runs it once, on Node 24.
- Shared behavior is written once as a fixture in `test/fixtures/` and run
  against the in-memory backend in `unit` and against Postgres in
  `integration`.
- The Postgres contract (`test/contract/suite.ts`,
  `describeStoreContract`) runs the same checks through every driver:
  migrate, transactions and savepoints, value round trips, chunked
  `addMany`, search and context, the scoped-API and bound-scope fixtures,
  survivor-aware deletes and nearest-neighbor duplicates (fixtures shared
  with the in-memory unit tests), and cross-scope isolation for search, id
  lookups, prune, duplicates, consolidation, `deleteScope` and stats.
  `test/contract/knn-duplicates-plan.test.ts` checks with `EXPLAIN` that
  `findDuplicates` uses the HNSW index per memory. The `contract` project
  runs the suite on PGlite, direct and through Drizzle: an in-process Postgres 18 with
  pgvector 0.8.7, so no service is needed and every Node job in CI runs it
  (about 20 s). Those runs go through `postgresStore`; another passes the
  PGlite instance itself as `store` (`directClient`), which covers
  detection and the lazily imported backend end to end. One more
  PGlite run wraps the executor and fails on any parameter that is not a
  string, finite number or null, the values postgres.js 3.x and 4.x write
  the same.
  `test/integration/drivers.test.ts` runs it on real Postgres through
  postgres.js, a node-postgres `Pool`, and Drizzle over each. Each run
  migrates (adopting an existing schema), works in its own namespaces,
  deletes them afterwards, and uses the integration files' embedding model
  name so it can share their database.
- The integration suite needs a **disposable** Postgres database with
  pgvector available and a role that can create tables in `public`. Each file
  applies the bundled migrations, ignoring "already exists" errors, and uses
  random entity ids. Some tests rewrite `mnemocyte_meta` and drop tables
  inside a transaction they roll back. `migrate.test.ts` cannot roll back,
  because `migrate()` commits each migration: every test drops the Mnemocyte
  tables and the file ends by leaving a tracked 1536-dimension schema for the
  files after it. Its `createExtension` tests also drop the `vector`
  extension and create and drop a non-superuser role
  (`mnemocyte_restricted_test`), so the role in `DATABASE_URL` must be a
  superuser, as it is on the Docker image and in CI. Files run serially with a 60 s timeout. When `DATABASE_URL` is unset the tests load `.env`, so set it
  explicitly.
- postgres.js is a dev dependency on 4.x, and `postgres-3`
  (`npm:postgres@3.4.9`) installs 3.x next to it, so both are in the
  lockfile. With `POSTGRES_JS=3` the `integration` project aliases
  `postgres` to `postgres-3` (`vitest.config.ts`); every integration file
  then runs on 3.x, and `test/integration/postgres-js.test.ts` fails if the
  alias did not apply. `test/package/exports-types.test-d.ts` checks both
  majors' `Sql` and `TransactionSql` types against `postgresStore`.

  ```bash
  DATABASE_URL=postgres://… POSTGRES_JS=3 pnpm test:integration
  ```
- CI runs the integration suite on Node 24 against the
  `pgvector/pgvector:0.8.7-pg17` and `0.8.7-pg18` service containers after
  `CREATE EXTENSION vector`, each with postgres.js 3 and 4 (four jobs). The
  tags are pinned, so pgvector upgrades are deliberate.
- `pnpm bench:retrieval` builds, then runs `test/benchmarks/retrieval.bench.ts`
  in the `package (bench)` project, against `dist/`. Vitest 5 adds a
  `<name> (bench)` variant of each project for `vitest bench`; it matches
  files by `benchmark.include` (`test/benchmarks/**/*.bench.ts`) instead of
  the project's `include`. Each size is seeded before timing, then
  `bench.compare` samples one `search` per iteration with tinybench and
  prints mean and percentile latencies per size. Postgres sizes run only when
  `DATABASE_URL` is set. It is not part of CI.
- Benchmarking `dist/` avoids most of the export getters Vite's module runner
  adds to `src/` cross-module calls. One call between tsdown's shared chunks
  still goes through a getter, so Vitest prints a getter warning; the
  overhead is small next to a search.

## Releasing

The maintainer cuts a release; `.github/workflows/release.yml` publishes it
when a `v*` tag is pushed.

1. On a `chore/release-vX.Y.Z` branch, move the `CHANGELOG.md`
   `[Unreleased]` entries under the new version and run
   `pnpm version patch --no-git-tag-version` (or `minor`), which changes only
   `package.json`.
2. Open a PR titled `chore(release): vX.Y.Z` and squash merge it once CI
   passes. The tag is created after the merge, because a squash merge gives
   the commit a new SHA.
3. Pull `main`, then `git tag -a vX.Y.Z -m vX.Y.Z` and
   `git push origin vX.Y.Z`.
4. Once npm has the version, create the GitHub release.

The release workflow runs three stages:

- `verify` fails unless the tag equals `v` + the `package.json` version and
  the tagged commit is on `main`.
- `ci` runs `ci.yml` (through `workflow_call`) on the tagged commit: the Node
  matrix, the package lint and both Postgres integration jobs.
- `publish` runs in the `npm` GitHub environment, the only job with
  `id-token: write`. It installs without a dependency cache and runs
  `pnpm publish --no-git-checks`; `prepublishOnly` builds `dist/`. A version
  with a prerelease part (`0.6.0-rc.1`) gets the `next` dist-tag, any other
  `latest`. `--no-git-checks` is needed because a tag checkout is a detached
  HEAD; `verify` does the branch check instead.
  `--publish-wait-timeout 600000` keeps the job running until the version
  is installable: npm scans each upload before it shows up, which took about
  two minutes for 0.5.1. If it is not available after 10 minutes the job
  fails with `ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT`, but the upload stays
  accepted and can still appear later, so check npm before retrying.

Publishing uses npm trusted publishing: pnpm exchanges the job's GitHub OIDC
(OpenID Connect) token for a short-lived npm token, so no npm token is
stored in the repository. npm then attaches a provenance attestation, a
signed statement of the repository, commit and workflow that built the
tarball, because the repository and the package are public. pnpm 11 and
newer does the exchange itself and does not need the npm CLI. Releases up to
0.5.0 were published from a laptop and have no provenance.

Repository and registry settings the workflow depends on:

- GitHub environment `npm` with a deployment rule that allows only `v*`
  tags.
- npm trusted publisher for `mnemocyte`: GitHub Actions, `Meenic` /
  `mnemocyte`, workflow `release.yml`, environment `npm`. npm does not check
  it when saved; a mistake shows up as a failed publish.
- After the first trusted publish, the package's publishing access is
  "Require two-factor authentication and disallow tokens". Trusted publishing
  keeps working under that setting.

A failed publish can be retried by re-running the workflow; the tag stays.
If the fix needs a new commit, delete the tag, merge the fix and tag again.
npm never accepts the same version twice, so once a version is published a
fix needs a new version.

GitHub release title: `mnemocyte vX.Y.Z`. Description:

```markdown
### Category
- **Short label**: concise description of the change

**Full Changelog**: https://github.com/Meenic/mnemocyte/compare/vPREVIOUS...vCURRENT
```

Categories: Performance, Accuracy, Reliability, Embedders, Documentation,
Tooling, API. Keep it factual, with no validation section.
