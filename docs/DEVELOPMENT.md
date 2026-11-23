# Development

What is built today and how to work on it. The target design lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); when one of its items lands, its section
moves here or into [features/](./features/).

User-facing documentation is `README.md` plus [guide/](./guide/): getting
started, the API reference, the CLI, Postgres setup, embedders, the AI SDK,
the MCP server, limitations and upgrading. A change users can see
updates the matching guide page in the same PR.

Feature areas (their source and test paths are relative to
`packages/mnemocyte/`):

- [features/postgres.md](./features/postgres.md): schema, migrations and
  the `migrate()` runner, installation metadata, connections (`SqlExecutor`,
  client detection, the lazily loaded backend for `store: client`, the
  postgres.js, node-postgres and PGlite adapters, `postgresStore`).
- [features/scopes.md](./features/scopes.md): scopes and their matching
  rules, the default namespace and bound clients, keyed `add`, `get`,
  `list` pagination, `update`, `deleteScope`, the client lifecycle.
- [features/retrieval.md](./features/retrieval.md): search, scoring, access
  tracking, `context`.
- [features/maintenance.md](./features/maintenance.md): delete, prune,
  duplicates, consolidation, audit log and its retention, stats.
- [features/embedders.md](./features/embedders.md): the `Embedder` contract
  (`purpose`, `maxBatch`), `openaiEmbedder`, `openaiCompatibleEmbedder`,
  `voyageEmbedder`, `cohereEmbedder`, `googleEmbedder` and
  `aiSdkEmbedder`, `ProviderError`, retries, timeouts, cancellation,
  observability.
- [features/cli.md](./features/cli.md): the `mnemocyte` bin: loading the
  app's memory file (type stripping, the resolve hook, tsconfig `paths`),
  `.env`, the `DATABASE_URL` fallback, `init`, `migrate`, `check` and
  `sql`.
- [features/ai-sdk.md](./features/ai-sdk.md): `memoryTools`, its schemas,
  validation and scope boundary; `memoryMiddleware` and `withMemory`;
  extraction with `save: { model }` and `extractMemories`.
- [features/mcp.md](./features/mcp.md): the separate `@mnemocyte/mcp`
  package in `packages/mcp/` (its paths are relative to that folder): the
  `mnemocyte-mcp` bin, `createMemoryMcpServer`, the tools, the copied
  loader, its tests and releases.

## Setup

- Node.js 22.18 or newer. CI runs 22.18, 24 and 26.
- pnpm 12.15.0, matching `packageManager` in the root `package.json`. CI
  reads the version from that field.
- Postgres with pgvector only for the integration suite.

```bash
pnpm install --frozen-lockfile
pnpm dev     # tsdown in watch mode
pnpm build   # writes packages/mnemocyte/dist/
```

Run commands from the repository root. The root scripts pass through to
the package (`pnpm build` runs `pnpm --filter mnemocyte build`); the ones
without a root script run from `packages/mnemocyte/`, or from the root as
`pnpm --filter mnemocyte test:prune`.

Mnemocyte is a library with a small CLI; there is no app to run. Try changes
through the tests or from a consuming project. After `pnpm build`,
`node packages/mnemocyte/dist/cli.mjs sql --dimensions 768` runs the bin
without a database;
`migrate` and `check` read `.env` in the current folder, so run them from
a scratch project, never from this repository's root.

## Structure

The repository is a pnpm workspace (`pnpm-workspace.yaml`: `packages/*`,
`apps/*`, `examples`):

```txt
packages/mnemocyte/     the published `mnemocyte` package: src/, test/, migrations/, scripts/, its configs and package.json
packages/mcp/           the published `@mnemocyte/mcp` package: the MCP server and its bin; README.md and CHANGELOG.md of its own
apps/site/              the website (Next.js), the private `@mnemocyte/site` package; rules in apps/site/AGENTS.md
examples/               runnable scripts, the private `@mnemocyte/examples` package on "mnemocyte": "workspace:*"
docs/                   the user guide, these contributor docs, ARCHITECTURE.md and ROADMAP.md
scripts/                check-links.mjs: relative links in the repository's Markdown
package.json            the private workspace root: packageManager, Biome, github-slugger, pass-through scripts
README.md, CHANGELOG.md, LICENSE, CONTRIBUTING.md, SECURITY.md, AGENTS.md, CLAUDE.md, biome.json, .github/, .vscode/
```

Libraries go under `packages/`, things that are run or deployed under
`apps/` (decision 53). `@mnemocyte/mcp` is `packages/mcp/`, with
`mnemocyte` as a peer and a `workspace:*` dev dependency, so it builds and
tests against `packages/mnemocyte/dist/`; see
[features/mcp.md](./features/mcp.md).
`examples/` stays at the root, where GitHub readers look for it, and
installs `mnemocyte` from the workspace the way an app installs it from
npm. Only the root `package.json` sets `packageManager`; `engines` is in
both.

`README.md` and `LICENSE` live at the root, where GitHub shows them. The
package's `prepack` script (`scripts/copy-readme.mjs`) copies both into
`packages/mnemocyte/` before `pnpm pack` and `pnpm publish`, so the
tarball holds the same files as before the move. The copies are
gitignored and stay after a pack (`pnpm pack --dry-run` runs `prepack`
but not `postpack`). In the README copy, every relative link becomes a
`https://github.com/Meenic/mnemocyte/blob/main/…` URL, the form the
links in `src/` use: npmjs.com renders the tarball's README, and its
handling of relative links is not documented. `repository.directory`
(`packages/mnemocyte`) tells npm where the package sits in the
repository. pnpm also packs the workspace root's `LICENSE` on publish
when a package has none, but its `pack` page does not say so, hence the
copy (decision 74).

The package, relative to `packages/mnemocyte/`:

```txt
src/
  index.ts              root entry: createMemory, migrate, setTextSearchConfig, errors, public types
  client.ts             createMemory: config checks, store (resolveStore | in-memory), overloads for namespace
  migrate.ts            migrate() and setTextSearchConfig(): validate input, resolve { memory } or { store } (resolveStore), call the store
  postgres.ts           `mnemocyte/postgres` entry: postgresStore, client types
  libsql.ts             `mnemocyte/libsql` entry: libsqlStore, client types
  store.ts              `mnemocyte/store` entry: defineMemoryStore, the MemoryStoreV1 types
  store-test.ts         `mnemocyte/store/test` entry: describeMemoryStoreContract (imports vitest)
  store-test/           the shipped suite: contract.ts, expect.ts, fixtures/ it runs
  ai-sdk.ts             `mnemocyte/ai-sdk` entry: aiSdkEmbedder, re-exports memoryTools
  ai-sdk/
    tools.ts            memoryTools: searchMemories, saveMemory, forgetMemory over a bound client
    middleware.ts       memoryMiddleware and withMemory: context in the prompt, save hook or extraction
    extraction.ts       extractMemories: the user's model extracts keyed memories from a turn
  cli.ts                the `mnemocyte` bin (not an export): version, process I/O, exit
  cli/                  main, args, io, memory-file, resolve-hook, tsconfig, target, init, migrate, check, sql, generate, drizzle, text-search
  types.ts              every public type
  errors.ts             MnemocyteError and its codes, ProviderError
  observability.ts      onEvent lifecycle (start / success / error)
  resilience.ts         provider timeout, retry rule, jittered backoff, abort
  memory/
    client-core.ts      shared orchestration for every client method
    scope-binding.ts    the default namespace layer and memory.for() bound clients
    client-internals.ts the client's store and embedder under a symbol, for migrate({ memory })
    store.ts            the internal MemoryStore (MemoryStoreV1 plus first-party extras), internal aliases of the V1 types
    store-v1.ts         the public MemoryStoreV1 contract and its types (the declarations)
    store-v1-adapter.ts assertMemoryStoreV1, fromMemoryStoreV1: a V1 store → MemoryStore with the core's fallbacks
    capabilities.ts     each backend's StoreCapabilities
    in-memory.ts        in-memory MemoryStore
    postgres.ts         Postgres MemoryStore (runs on a SqlExecutor)
    libsql.ts           libSQL MemoryStore (runs on the user's @libsql/client)
    duplicates.ts       exact duplicate search over loaded memories (in-memory and libSQL)
    store-input.ts      resolveStore: a store config, or a libSQL or Postgres client detected by shape → lazy store
    store-config.ts     the opaque store config envelopes: postgresStore() / libsqlStore(), and defineMemoryStore()
    lazy-store.ts       MemoryStore that loads the real one on its first call
    postgres-backend.ts dynamic import() target: client → Postgres MemoryStore
    libsql-backend.ts   dynamic import() target: client → libSQL MemoryStore
    validation.ts       runtime input and config validation
    limits.ts           input size caps (content, tags, metadata, key, limit)
    json.ts             JSON metadata validation and deep clone
    embeddings.ts       embedder calls and output validation
    filters.ts          in-memory visibility, selector and filter predicates
    cursor.ts           opaque list cursors
    records.ts          ids, tag normalization, cloning
  sql/
    executor.ts         SqlExecutor: query, optional transaction and batch
    detect.ts           detectClient, detectLibsqlClient: shape checks, PostgresClient and LibsqlClient types (no adapters, in the root entry)
    clients.ts          executorFor / toSqlExecutor: detected client → its adapter
    postgres-js.ts      the postgres.js adapter (internal)
    node-postgres.ts    the node-postgres Pool adapter
    pglite.ts           the PGlite adapter
    scoped.ts           transaction executor with savepoints (pg, PGlite)
  db/
    sql.ts              bind-parameter collector for building statements
    atomic.ts           runAtomically (batch or transaction), insert chunking
    errors.ts           constraint name from either driver error shape
    rows.ts             row types, column lists, row normalization
    queries/            memories, events, meta SQL on a SqlExecutor
    migrations/         Postgres migration runner, inspect.ts (read-only report), text-search.ts (setTextSearchConfig) and bundled.ts (generated)
    text-search.ts      content_tsv's text search configuration: read, resolve, change statements
    tables.ts           table names for a schemaName (or search_path), schema name validation
    pgvector.ts         assertPgvectorVersion
    libsql/             the libSQL backend's SQL: executor.ts (adapter over the client), sql.ts (?NNN params, rows, blob vectors), queries.ts, migrations.ts (runner, report, tokenizer change), bundled.ts (generated); see features/libsql.md
  retrieval/scorer.ts   cosine, lexical overlap, rank fusion, boosts
  context/              context(): formatters, token budget
  embedders/            openai, openai-compatible, voyage, cohere, google (fetch only); each file is an export
    internal/           http-embedder.ts (createFetchEmbedder, the fetch core of every HTTP embedder; createHttpEmbedder, OpenAI-shaped; option checks) and provider-error.ts (createProviderError, error body and Retry-After parsing)
migrations/             numbered SQL migrations, fresh-install.sql, the schema template; libsql/ holds the libSQL template (not shipped)
scripts/                bundle-migrations.mjs, bundle-libsql-migrations.mjs, bench-libsql.mjs, check-package.mjs, check-readme.mjs, check-jsdoc.mjs, copy-readme.mjs
test/                   unit, package, integration, fixtures (the ones that do not ship), benchmarks
```

The contract suite and the fixtures it runs live in `src/store-test/`, not
`test/`, because they ship: `mnemocyte/store/test` is built from them
with the rest of `src/`, under `tsconfig.build.json`, and shares its
chunks with the root entry, so a backend author's suite and app use the
same `createMemory` and `MnemocyteError`. The repository's own tests
import them from `src/store-test/` like any other source file.

`dist/` is built by tsdown from the entries in `tsdown.config.ts`:
`src/index.ts`, `src/ai-sdk.ts`, `src/cli.ts`, `src/postgres.ts`,
`src/libsql.ts`, `src/store.ts`, `src/store-test.ts` and
`src/embedders/*.ts`. `dist/cli.mjs` is the
`mnemocyte` bin (`bin` in `package.json`), not an export. The package has
no runtime dependencies. `postgres`, `pg`, `@electric-sql/pglite`,
`@libsql/client` and `drizzle-orm` are optional peer dependencies at the
versions the tests run; source files import at most their types
(`postgres` and `drizzle-orm` only; the libSQL client types are
structural), so no built entry imports a driver (a package test follows
each entry's static imports to check this). They are also dev
dependencies, with `@types/pg` and `@electric-sql/pglite-pgvector`. `ai` is an optional peer too
(`^7.0.135`) and a dev dependency (it brings `zod`, its peer, into the
lockfile); `src/ai-sdk.ts` and the files in `src/ai-sdk/` import it at
runtime, the only source files that do, and a package test follows
the static imports of every other entry to check that none reaches it.
`vitest` is an optional peer (`^5.0.0`) the same way: `src/store-test.ts`
and `src/store-test/` import it at runtime, and a package test checks that
no entry but `mnemocyte/store/test` reaches it.

TypeScript compiles against `target` and `lib` `es2024`, the newest edition
Node 22.18 fully supports. There are two configs:

- `tsconfig.build.json` holds the build settings for `src/` alone; tsdown
  reads it (`tsconfig` in `tsdown.config.ts`), and so does
  `test/package/tsconfig.json`. `isolatedDeclarations` is on there, so
  every export needs a type a declaration emitter can read without
  inference (explicit return types on exported functions).
- `tsconfig.json` extends it for the whole repository: `src/`, `test/` and
  the config files, with `paths` to `src/` and `isolatedDeclarations` off.
  Editors only pick up files named `tsconfig.json`, so this is the one that
  must cover the tests; a file no config includes lands in an inferred
  project, where TypeScript 6 loads no `@types` and `node:` imports and
  `process` fail. `pnpm checktypes` runs both, so the editor does not flag
  a missing return type in `src/` but CI does.

`examples/tsconfig.json` stands on its own: no `paths`, so the examples
resolve `mnemocyte` to `packages/mnemocyte/dist/` through the
`workspace:*` link (see `pnpm test:examples` under Testing).
 The `.mjs` files ship with source maps that embed
their sources. The `.d.mts` files ship without maps, because a declaration
map points at `src/`, which is not published. With `sourcemap` on, rolldown
writes a `sourceMappingURL` comment into every chunk, `.d.mts` included, and
rolldown-plugin-dts drops the declaration maps without removing it; a small
plugin in `tsdown.config.ts` strips that comment.

## Store contract

The core (`memory/client-core.ts`, `migrate.ts`, the CLI) talks to a
backend through `MemoryStore` (`src/memory/store.ts`). It is the public
`MemoryStoreV1` (`src/memory/store-v1.ts`, exported from
`mnemocyte/store`) plus what only the first-party backends have
(ARCHITECTURE decisions 61, 72 and 73):

| Method | V1 | What it does |
|---|---|---|
| `insert` | required | rows and keyed upserts, all or nothing |
| `searchCandidates` | required | the vector and lexical lists of a search, same filter |
| `get` | required | memories by ids (`visibility`), or one by key (exact `scope`) |
| `list`, `update`, `markAccessed` | required | a page, a patch, an access count bump |
| `delete` | required | `target: "memory"`, `"scope"` or `"filter"` (`prune`) |
| `consolidate` | required | the atomic write after the core's checks |
| `findDuplicates` | required | `mode: "top"` (`findDuplicates`) or `"page"` (`experimental.findDuplicatesPage`) |
| `listAudit`, `pruneAudit` | required | audit pages and retention |
| `stats` | required | counts for a selector |
| `migrate` | optional | schema; a store without one applies nothing |
| `ensureEmbeddingCompatibility` | optional | rejects an embedder the installation does not match |
| `setTextSearchConfig`, `inspectInstallation` | first-party only | the text search configuration and the CLI's `check` report |

Plus `capabilities` on both. V1 adds `specificationVersion: "v1"` and
`name`; the internal one adds `backend`, `schemaName` on Postgres, and
`custom` (`{ name, migrates }`) on an adapted V1 store.

- The V1 types are the declarations, with the docs, named
  `MemoryStoreV1…` as the AI SDK names `LanguageModelV4…`, so a V2 can sit
  next to them. `store.ts` aliases them under the internal `Store…` names
  the backends use (`StoreVisibility = MemoryStoreV1Visibility`), and
  `records.ts` aliases `StoredMemory` to `MemoryStoreV1Row`. The
  first-party backends implement `MemoryStore`; nothing else changed for
  them.
- `defineMemoryStore({ store })` (`src/store.ts`) checks the store with
  `assertMemoryStoreV1` and puts it, unadapted, in an envelope under
  `Symbol.for("mnemocyte.memory-store-v1-config")`, a key apart from the
  first-party one so a copy of the package built before V1 rejects it with
  its usual `"CONFIG"` instead of calling missing methods.
  `unwrapMnemocyteStoreConfig` (`resolveStore`) adapts it with
  `fromMemoryStoreV1`, so the copy that runs the client adapts it, whichever
  copy defined it. The adapter declares `backend: "custom"`, copies and
  freezes `capabilities`, calls every method through the store (keeping
  `this` for class stores) and supplies the fallbacks: `migrate` reports
  nothing applied, `ensureEmbeddingCompatibility` does nothing,
  `setTextSearchConfig` returns `null` names and `changed: false`, and
  `inspectInstallation` returns `null`, the in-memory store's answers. The
  callers keep calling required methods.
- `assertMemoryStoreV1` throws `"CONFIG"` (`"INVALID_OPTION"`) for a
  `specificationVersion` other than `"v1"` (naming the versions this copy
  supports), an empty `name`, a capability value outside its union, a
  `maxDimensions` that is not a positive integer or infinity, a missing
  required method, or an optional one that is not a function.
- The CLI reads `custom`: `check` says the store reports no installation,
  `migrate` says a store without `migrate` manages its own schema,
  `text-search` has nothing to change, and `--schema` is rejected.
- Every method takes one input object. `signal` sits inside it and is set
  only when the caller passed one, since store inputs are exact. The
  search lists, `update` and `markAccessed` took no signal before and
  still take none.
- `delete` and `findDuplicates` return results tagged with the input's
  `target` or `mode`; the core checks the tag (`deleteResultFor`) and throws
  `"DB"` for another, as it does for any store result it cannot trust.
- `get` returns visible matches in no particular order and leaves out ids
  it cannot see. `consolidate` on the client reads the survivor and then
  its targets with two `get` calls, the abort check between them, before
  the store's own locked re-read.
- `migrate`, `setTextSearchConfig`, `inspectInstallation` and `schemaName`
  kept their names and inputs through decision 61, because `migrate()` and
  the CLI call them on a store that may come from another installed copy
  of the package (the app's, through `Symbol.for`). `createMemory` checks
  for the current contract with `assertStoreContract`
  (`memory/store-input.ts`): a store without `capabilities` or
  `searchCandidates` throws `"CONFIG"` at once instead of a `TypeError` on
  the first call.
- Audit events are written by the write they record, so there is no
  separate append method (see
  [features/maintenance.md](./features/maintenance.md#audit-log)).
- The user guide for backend authors is
  [guide/custom-stores.md](./guide/custom-stores.md).

### Capabilities

`capabilities` is declared data, the same object for every store of a
first-party backend (`src/memory/capabilities.ts`); a custom store
declares its own:

| Field | In-memory | Postgres | libSQL |
|---|---|---|---|
| `vectorSearch` | `"exact"` | `"approximate"` (HNSW) | `"exact"` (a scan of the scope) |
| `filteredVectorSearch` | `"prefilter"` | `"iterative"` (pgvector 0.8 iterative scans) | `"prefilter"` |
| `lexicalSearch` | `"overlap"` | `"ts_rank"` | `"bm25"` (FTS5) |
| `locking` | `"database"` (calls never interleave) | `"row"` (`SELECT … FOR UPDATE`) | `"database"` (`BEGIN IMMEDIATE`) |
| `maxDimensions` | `Number.POSITIVE_INFINITY` | 4,000 (`halfvec` in an HNSW index) | 65,536 (libSQL's vector limit) |

The other values the types allow are `"postfilter"` and
`lexicalSearch: "none"`; no backend declares them. The core reads
capabilities in two places: `search` asks for no lexical list when
`lexicalSearch` is `"none"`, as it skips a list whose fusion weight is 0,
and `migrate()` checks `dimensions` against `maxDimensions` (an infinite
one, the in-memory store's, keeps the Postgres limit). Nothing warns on
them (decision 63). The shared contract reads them to set expectations
(decision 65). The Postgres and libSQL constants live apart from the
backends, so the lazy store for `store: client` declares them before the
backend loads. `test/memory/capabilities.test.ts` and
`test/contract/libsql-behavior.test.ts` pin the declarations.

## Conventions

- Shared behavior goes in `memory/client-core.ts`; backend mechanics stay in
  the `MemoryStore` implementations. Every backend must pass the same shared
  fixtures in `test/fixtures/`.
- Validation runs before any embedder or storage call. Invalid input throws
  `MnemocyteError` with code `"VALIDATION"`; invalid configuration throws
  `"CONFIG"` synchronously from `createMemory`. Config and option objects
  reject unknown keys through `assertKnownKeys` (`src/options.ts`), so a
  new option must be added to its list; an object that carries free-form
  JSON (`providerOptions`, `purposes[*].body`, `headers`) is not checked
  inside. Method inputs, their `scope` and each `addMany` memory reject
  unknown keys with `"VALIDATION"` through `assertInputKeys`
  (`memory/validation.ts`), first, before any other check. Its lists are
  built with `inputKeys<T>()`, whose record type makes `tsc` fail when a
  list and its input type disagree, so a new input key is added there.
  `metadata` and `tokenCounter` are not checked inside.
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
  unknown rows from `insert` (matching by id, or by key for keyed
  upserts) and restores input order.
- Every store method that touches memories takes a scope: a visibility for
  reads and writes by id, a selector for bulk operations (see
  [features/scopes.md](./features/scopes.md)).
- Vectors are written with the shortest round-trip number format
  (`db/vector.ts`). Fixed decimal precision would turn small components into
  zero.
- Driver errors are mapped to `MnemocyteError`: missing tables or columns
  become `"MIGRATION"` with reason `"SCHEMA_MISSING"`, everything else `"DB"`.
- `@types/node` stays on the major of the minimum supported Node version.

## Public API

Exports:

- `mnemocyte`: `createMemory`, `migrate`, `setTextSearchConfig`, `MnemocyteError`,
  `isMnemocyteError`, `ProviderError`, `isProviderError` and the public
  types, including
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
  `AiSdkProviderOptions` and `AiSdkPurposeHints` (with its deprecated
  alias `AiSdkPurposeOptions`) types; `memoryTools` and
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
- `mnemocyte/libsql`: `libsqlStore({ client })`, its `LibsqlStoreOptions`,
  and the `LibsqlClient` and `LibsqlDriverClient` types (also exported
  from the root). See [features/libsql.md](./features/libsql.md).
- `mnemocyte/store`: `defineMemoryStore({ store })`, its
  `DefineMemoryStoreOptions`, and `MemoryStoreV1` with every type its
  methods take and return (`MemoryStoreV1Capabilities`,
  `MemoryStoreV1Row`, `MemoryStoreV1Visibility`, `MemoryStoreV1Selector`,
  the `…Input` and `…Result` types). See "Store contract" above.
- `mnemocyte/store/test`: `describeMemoryStoreContract`, its
  `MemoryStoreContractOptions` and `FailAuditWritesInput` types, and
  `STORE_CONTRACT_DIMENSIONS` and `STORE_CONTRACT_EMBEDDING_MODEL`; needs
  the `vitest` peer.
- `mnemocyte/postgres`: `postgresStore({ client })`, its
  `PostgresStoreOptions`, and the `SqlExecutor`, `SqlStatement`, `SqlQueryOptions`, `PostgresClient`, `PostgresJsClient`, `NodePostgresPool` (with its
  client and result types), `PGliteClient` (with its transaction and result
  types) and `DrizzleClient` types.
- The `mnemocyte` bin: `init`, `migrate`, `check`, `sql`,
  `generate --adapter drizzle` and `text-search <name>`, with `--config`,
  `--dimensions`, `--env-file`, `--text-search-config`, `--schema`,
  `--yes`, `--dry-run`, `--json`, `--embedder`, `--adapter` and `--out`.
  The schema file `generate` writes is public too. Its
  commands, flags and exit codes (0, 1, 2) are public; its modules are not
  exported. See [features/cli.md](./features/cli.md).

`package.json` lists each subpath explicitly, with a `types` and a `default`
condition; there are no wildcard subpaths, so a new entry needs its own
`exports` line. The `default` condition lets CommonJS load the package:
since Node 22.12, `require()` loads synchronous ES modules and returns their
namespace. It throws `ERR_REQUIRE_ASYNC_MODULE` if any module in the graph
uses top-level `await`, so `dist/` must not.

Client methods: `add`, `addMany`, `search`, `get`, `list`, `update`,
`delete`, `deleteScope`, `context`, `prune`, `findDuplicates`,
`listAuditLog`, `pruneAuditLog`, `stats`, `consolidate` and `for`, plus
`experimental.findDuplicatesPage` and `experimental.contextWithMemories`.
There is no `close()`.
`for(scope)` returns a `BoundMemoryClient` with the same methods minus
`scope`, `allNamespaces` and `for`, plus a read-only `scope`.

Design rules for the public surface:

- One object parameter per method; new options are optional fields.
- Optional fields of inputs and options (method inputs, scopes, config,
  embedder and AI SDK options) are typed `?: T | undefined`, and the runtime
  treats `undefined` as absent: read them with `?? default` or
  `!== undefined`, never spread them over defaults. Under
  `exactOptionalPropertyTypes` a bare `?: T` rejects a `T | undefined`
  variable. Result and event types the package produces keep `?: T`, and
  so do types it passes into user code, such as `EmbedOptions`: an embedder
  that declares its options as `{ signal?: AbortSignal }` stops being an
  `Embedder` if `signal` gains `| undefined`. Internal store types stay
  exact, so the store never sees a key set to `undefined`.
  `test/memory/explicit-undefined.test.ts` and the export type test check
  both sides.
- Errors are `MnemocyteError` with a stable `code`, and a `reason` on every
  `"CONFIG"`, `"CONFLICT"` and `"MIGRATION"` (the constructor input requires
  one, so the compiler catches a throw without it); callers branch on those,
  never the message. A new case that callers would handle differently gets
  a new reason. `isMnemocyteError` checks the `Symbol.for("mnemocyte.error")`
  brand on the prototype; code that inspects an error the package may not
  have created (an embedder's, a driver's) uses it instead of `instanceof`.
  `isProviderError` adds no brand of its own: it checks that brand, the
  `"EMBEDDING"` code, a numeric `status` and a numeric or `undefined`
  `retryAfterMs`, so it also recognizes a `ProviderError` from a 1.0.x
  copy.
- Error codes and reasons, `MnemocyteOperation`, `MnemocyteBackend`,
  `AuditEventType` and `MemoryMiddlewareError.phase` may gain members in a
  minor; the other unions change
  only in a major (`guide/api.md` "Stability").
- A time filter on memories names its field: `createdBefore` /
  `createdAfter` (`search`, `list`, `context`; `prune` takes
  `createdBefore`), `notAccessedSince`. Bare `before` /
  `after` are for audit events, which have one time (decision 40).
- Every long-running method accepts `signal: AbortSignal`, on the bound
  client too: bound `stats`, whose only option is `signal`, takes an
  optional `BoundStatsInput`.
- New or unproven behavior goes under `experimental` first.
- Every method that reads or writes memories takes a `scope` (or is bound
  to one); a global operation needs `allNamespaces: true`, which bound
  clients do not offer.
- A new method that takes a `scope` gets a `DefaultNamespace` type
  parameter on its input, a wrapper in `createScopedClient` and one in
  `bindScope` (`memory/scope-binding.ts`), and a `Bound…Input` type.
- A public type renamed in 1.x keeps its old name as a `@deprecated` type
  alias until the next major. The new name is the declaration, so hovers
  and errors show it (TypeScript does not keep the name of an alias to an
  interface): `PruneSelectors` is an alias of `BoundPruneInput`, and
  `AiSdkPurposeOptions` of `AiSdkPurposeHints` (decision 42).
- From 1.0, breaking changes ship only in a major, with a `CHANGELOG.md`
  entry and a section in `docs/guide/upgrading.md`. `guide/api.md`
  "Stability" lists what semver covers (decision 39): not `experimental.*`
  and its types, messages, CLI text, `context()` wording, the text the AI
  SDK integration gives the model, or score values; types derived from
  `ai` follow the peer. Additive changes and the open unions above go in a
  minor.

## Testing

Vitest has four projects (`packages/mnemocyte/vitest.config.ts`). Test
and script paths in this section are relative to `packages/mnemocyte/`,
where pnpm runs the package's scripts; `docs/`, `examples/` and the root
`scripts/` are the repository's.

| Project | Files | Imports | Command |
|---|---|---|---|
| `unit` | `test/**/*.test.ts` except integration, contract, package, benchmarks | `src/` through aliases | `pnpm test:unit` |
| `contract` | `test/contract/**/*.test.ts` | `src/` through aliases | `pnpm test:contract` |
| `package` | `test/package/*.test.ts` | built `dist/` through self-reference | `pnpm test:exports` |
| `integration` | `test/integration/**/*.test.ts` | `src/` through aliases | `pnpm test:integration` (`pnpm test:integration:libsql` for the libSQL server file alone) |

- `unit` and `integration` map `mnemocyte` to `src/` with `resolve.alias`,
  and `tsconfig.json` does the same with `paths`. The `package` project
  and `test/package/tsconfig.json` have neither: `mnemocyte` resolves to
  `dist/` through the package's own `exports` (package self-reference), the
  way a consumer resolves it.

- `pnpm test` at the root runs `pnpm test:links`, the package's `test`
  (`test:checks`, then `test:ci`), `@mnemocyte/mcp`'s `test` (its build
  and Vitest, against the `mnemocyte` build just made), then
  `pnpm test:examples`. `pnpm checktypes` and `pnpm build` cover both
  packages too; `checktypes` builds `mnemocyte` first, because
  `@mnemocyte/mcp` type-checks against its `dist/`. The `*:mcp` scripts
  (`build:mcp`, `checktypes:mcp`, `test:mcp`, `lint:package:mcp`,
  `pack:check:mcp`) run one step for `@mnemocyte/mcp` alone, building
  `mnemocyte` first where they need it (decision 75); its tests are in
  [features/mcp.md](./features/mcp.md#tests). The root
  `test:checks` is the package's `test:checks`, which builds and runs the
  type-level checks `test:types`, `test:readme` and `test:jsdoc`, then
  `pnpm test:examples`. `test:ci` builds again (under a second) and runs
  `unit`, `contract` and `package`. CI runs `test:links` in the Links
  job, `test:checks` once, in the Checks job, and `test:ci` on each Node
  version ("What CI runs" below). `pnpm test:exports` builds and runs
  `test:types` and `package` alone.
- `pnpm test:types` runs `tsc --noEmit -p test/package/tsconfig.json`, which
  type-checks every public export in `test/package/exports-types.test-d.ts`
  against the built `dist/*.d.mts`, so it needs a build first. The file has
  no `test()` blocks, and Vitest's `--typecheck` drops type errors outside
  test blocks, so plain `tsc` checks it instead. The `@ts-expect-error`
  negative cases fail with TS2578 if they stop being errors.
- `pnpm test:readme` (`scripts/check-readme.mjs`) type-checks the root
  `README.md` code blocks fenced as `ts` or `typescript`, so it also needs
  a build first. The blocks build on each other, so they are joined in
  order into `test/package/.readme/readme.ts`, and every line outside a
  block becomes a blank line: line N of that file is line N of the README,
  and errors print as `README.md:<line>:<col>`. The folder is gitignored
  and rewritten on each run. It has to sit inside the package because
  `mnemocyte` resolves to `dist/` through the package's own `exports` only
  from files in the package (a `paths` alias would skip `exports`). Its
  `tsconfig.json` extends `test/package/tsconfig.json`. Limits: types
  only, nothing runs; all blocks share one top-level scope, so two blocks
  cannot declare the same name; indented fences (inside lists) are not
  picked up; a block that should not compile needs another fence language.
  No `ts` blocks or an unclosed fence fails the check. `docs/guide/`
  snippets are not checked.
- `pnpm test:jsdoc` (`scripts/check-jsdoc.mjs`) type-checks the `ts` blocks
  in `@example` doc comments under `src/` the same way, and needs a build
  first. Each block becomes an `async function` in
  `test/package/.readme/jsdoc.ts` (gitignored, own `tsconfig.jsdoc.json`),
  so two examples can declare the same name. A shared preamble declares the
  application-side names examples use without defining them (`memory`,
  `user`, `embedder`, `store`, `scope`, `id`, `userId`, `openai`, ...); add
  to it in the script when a new example needs another. Mnemocyte exports
  are not in the preamble: the example imports them. Import lines are merged
  per module at the top, relative imports are skipped, and only single-line
  default or named imports are read. The generated file does not keep line
  numbers, so the script maps errors back and prints
  `src/<file>:<line>:<col>` (the column is relative to the text after the
  ` * ` prefix). Types only, nothing runs.
- `pnpm test:examples` runs the `typecheck` script of
  `@mnemocyte/examples` (`tsc --noEmit` with `examples/tsconfig.json`),
  which type-checks the scripts in `examples/` against the built `dist/`,
  so it needs a build first. The examples import `mnemocyte` by name and
  resolve it through `examples/node_modules/mnemocyte`, the `workspace:*`
  link to `packages/mnemocyte/`, and the tsconfig is the one the
  getting-started guide recommends for running `.ts` files with Node.
  `examples/package.json` lists the drivers and `ai` they import, which are
  optional peers of `mnemocyte`. Types only: nothing runs, since every
  example needs an API key and some need a database. `examples/` is
  outside the package, so it does not ship.
- `pnpm test:links` (the root `scripts/check-links.mjs`) checks that
  relative links and `#anchors` in `README.md`, `CHANGELOG.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, `examples/README.md`,
  `packages/mcp/README.md`, `packages/mcp/CHANGELOG.md` and
  `docs/**/*.md` point at files and headings that exist. It needs no build and prints
  `<file>:<line>: <problem>` per broken link.
  - Files come from `git ls-files --cached --others --exclude-standard`
    that still exist on disk, so a link to a gitignored file (`dist/`,
    `.env`) fails, and paths compare case-sensitively on Windows too, as
    on GitHub. A link may point at a folder.
  - Heading anchors are slugged with `github-slugger` (a dev dependency,
    decision 56), which follows GitHub's rules: lowercase, spaces become
    `-`, other punctuation is dropped, and a repeated heading gets `-1`,
    `-2`. `## 1.0 → 1.1` is `#10--11`, and `## [1.2.1] - 2026-11-20` in
    the changelog is `#121---2026-11-20`. Before slugging, the script
    keeps the text of code spans and links and drops emphasis markers and
    HTML tags. ATX and setext headings count.
  - `<a id="…">` and `<a name="…">` add custom anchors, which do not take
    part in the `-1` numbering (GitHub's docs say the same).
  - Links with a scheme (`https:`, `mailto:`) are skipped, so external
    URLs are not checked. So are links inside fenced code blocks and code
    spans. An anchor is checked only when the target is a `.md` file, so
    `#L12` on a source file passes.
  - It reads inline links and images (`[text](href)`, `<href>` and a
    title allowed) and reference definitions (`[label]: href`) a block at
    a time (adjacent non-blank lines; a list item, table row or heading
    starts a new one), so code spans and links may wrap. GitHub's docs
    ("Relative links and image paths in markdown files") say a relative
    link's text must stay on one line, so a wrapped one fails; a wrapped
    external link passes. A malformed `%` escape fails too.
  - HTML links (`<a href>`) are not read, and a link in an indented code
    block (four spaces, no fence) is checked like prose.
- The `package` project's global setup (`test/package/pack.global-setup.ts`)
  packs the tarball once and extracts it with the system `tar` using
  relative paths, so GNU tar, bsdtar and Windows' `tar.exe` all work.
  Each test file that needs it copies the package into a temporary
  consumer of its own (`createPackedConsumer` in `packed-consumer.ts`)
  with `drizzle-orm`, `postgres`, `pg`, PGlite, `@libsql/client` and `ai`
  absent. A test that runs scripts in a consumer takes a 30 s timeout of
  its own (the third argument to `test`): `libsql.test.ts` hit Vitest's
  5 s default once in a loaded `pnpm test` on Windows. The in-process
  package tests keep the default. In `lazy-postgres.test.ts` the
  consumer runs an in-memory client from ESM and, through `require()`, a
  client with a `SqlExecutor` as `store`, which loads the Postgres chunk
  lazily; `require()` would throw if any module used top-level `await`.
  Then it links the dev `ai` into its
  `node_modules` (a directory junction, which Windows allows without
  symlink rights) and embeds through `mnemocyte/ai-sdk` with an AI SDK mock
  model, checking that an `APICallError` comes out as the root entry's
  `ProviderError`, runs `searchMemories` from `memoryTools`, and calls
  `generateText` on a `withMemory` mock model to check the context
  reaches the prompt, and `extractMemories` with a mock model to check it
  stores a keyed memory.
  The manifest export (`mnemocyte/package.json`) is read from the
  tarball with `require()` and a JSON import, and from `dist/` through
  self-reference in `exports.test.ts`.
- `require-esm.test.ts` requires every key of the packed `exports` from a
  `.cjs` file (require(esm)) and checks each against `import()` of the
  same entry, with nothing on stderr. Without `ai`, `mnemocyte/ai-sdk`
  must fail with `ERR_MODULE_NOT_FOUND`; with `ai` linked it must load.
  `mnemocyte/store/test` fails the same way without `vitest`, and loads
  through `require()` once it is linked: require(esm) loads the entry as
  ES modules, so its `import` of `vitest` reaches Vitest's ES entry, not
  the CommonJS one that throws. It
  runs on every CI Node version, so it backs the README's `require()`
  sentence; the TypeScript `module` setting it needs is not tested
  ([limitations](./guide/limitations.md#commonjs)).
- The CLI is tested at four levels (see
  [features/cli.md](./features/cli.md#tests)): pure parts in `test/cli/`
  (`unit`); `migrate` and `check` against PGlite in process, with a
  recording `CliIo` standing in for the terminal, in
  `test/contract/cli.test.ts`; the built `dist/cli.mjs` as a child process
  in temporary projects in `test/package/cli.test.ts`, which is where a
  TypeScript memory file, the resolve hook and `.env` run on each CI Node
  version; and the `DATABASE_URL` path on real Postgres in
  `test/integration/cli.test.ts`.
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
- Shared behavior is written once as a fixture in `src/store-test/fixtures/`
  (the ones the shipped suite runs) or `test/fixtures/` (the others) and
  run against the in-memory backend in `unit`, and against Postgres and
  libSQL: through the shared contract (`src/store-test/contract.ts`,
  `registerSharedContract`), or, for the fixtures the Postgres side runs
  in `integration` (`test/integration/*.test.ts`), in
  `test/contract/libsql-fixtures.test.ts` on libSQL.
- The shared contract is what `mnemocyte/store/test` ships:
  `describeMemoryStoreContract` (`src/store-test.ts`) registers it in a
  `describe` of its own, with no namespace cleanup and `failAuditWrites`
  optional (the audit rollback test skips without it).
  `test/store/in-memory-contract.test.ts` runs it in `unit` on the
  in-memory store handed over as a `MemoryStoreV1`
  (`test/store/in-memory-v1.ts`), with and without its optional methods,
  through `defineMemoryStore` and the adapter.
  `test/package/store-contract.test.ts` runs it from the packed tarball:
  a consumer with `@libsql/client` and `vitest` linked runs `vitest run`
  on a test file that points the suite at `libsqlStore` on a database
  file, with a trigger as `failAuditWrites`. The child gets the parent's
  environment minus `VITEST*` and `NODE_OPTIONS`, so it does not think it
  runs inside the parent's worker, and a 180 s timeout. The test reads the
  child's `--reporter json` file, not its console: CI forces colored
  output, which puts escape codes inside the summary lines.
  `test/store/define-memory-store.test.ts` covers the checks and the
  fallbacks, and `test/cli/custom-store.test.ts` the CLI's messages.
- The shared contract runs the scoped-API, bound-scope, context,
  survivor-delete, duplicate and audit fixtures, plus value round trips,
  chunked `addMany`, search, filtered search and cross-scope isolation,
  through the public client. A harness gives it the store value, a client
  factory and `failAuditWrites` (a trigger in the backend's own SQL). Expectations
  that depend on a backend read its `capabilities`
  (`readMemoryClientInternals(memory).store.capabilities`): a selective
  `kinds` filter must keep the vector list full unless
  `filteredVectorSearch` is `"postfilter"`. Search results are checked by
  membership (sorted id sets, `toContain`, the top result in a scope with
  one match), never by a full order, since lexical scores differ by
  backend (ARCHITECTURE decision 65).
- The libSQL contract (`test/contract/libsql.ts`,
  `describeLibsqlContract`) runs the shared contract through
  `libsqlStore`, the client itself and Drizzle on a database file under
  the folder `test/contract/libsql.global-setup.ts` creates, plus the
  libSQL-only tests; `test/integration/libsql-remote.test.ts` runs it on
  a libSQL server at `LIBSQL_URL` (`pnpm test:integration:libsql`, in CI
  and by hand; see [features/libsql.md](./features/libsql.md#tests)).
- The Postgres contract (`test/contract/suite.ts`,
  `describeStoreContract`) runs the shared contract and the Postgres-only
  checks through every driver: migrate, transactions and savepoints, value
  round trips, chunked
  `addMany`, search and context, context with its memories, the
  scoped-API and bound-scope fixtures,
  survivor-aware deletes, nearest-neighbor duplicates, audit payloads,
  audit pages and audit retention (fixtures shared with the in-memory unit
  tests), audit pages over hand-inserted events whose timestamps differ only
  in microseconds, audit rollback (a
  trigger that fails the namespace's audit inserts), and cross-scope
  isolation for search, id
  lookups, prune, duplicates, consolidation, `deleteScope` and stats.
  `test/contract/knn-duplicates-plan.test.ts` checks with `EXPLAIN` that
  `findDuplicates` uses the HNSW index per memory, and
  `test/contract/audit-retention.test.ts` runs the retention fixture with
  `allNamespaces` on a PGlite of its own, aborts between batches, and
  checks that `pruneAuditLog` batches resume along the events' scope
  index. The `contract` project
  runs the suite on PGlite, direct and through Drizzle: an in-process Postgres 18 with
  pgvector 0.8.7, so no service is needed and every Node job in CI runs it.
  Each run is a file of its own, so Vitest spreads them over its workers.
  `pglite-direct.test.ts` passes the PGlite instance itself as `store`
  (`directClient`), which covers detection and the lazily imported
  backend end to end; the other runs go through `postgresStore`
  (`pglite-drizzle.test.ts` with a Drizzle client).
  `pglite-params.test.ts` wraps the executor and fails on any parameter
  that is not a string, finite number or null, the values postgres.js 3.x
  and 4.x write the same.
  `pglite-schema.test.ts` (`schemaName`) keeps the tables in a schema that
  is not on `search_path`, so a query that names a table bare fails.
  `test/integration/drivers.test.ts` runs it on real Postgres through
  postgres.js, a node-postgres `Pool`, and Drizzle over each, and once on
  postgres.js with the tables in a schema, installed from the rendered
  template and adopted, because `public` already holds the other files'
  installation (see features/postgres.md, "Schema name"). Each run
  migrates (adopting an existing schema), works in its own namespaces,
  deletes them afterwards, and uses the integration files' embedding model
  name so it can share their database.
- Contract files open PGlite with `openPGlite({ pgvector })`
  (`test/contract/pglite.ts`), not `PGlite.create`. Without `loadDataDir`,
  PGlite runs initdb on every start: on Node 24 with 8 cores an idle
  `PGlite.create` took about 0.75 s, a start from a saved data folder about
  0.2 s, and `CREATE EXTENSION vector` plus `migrate` about 30 ms. So the
  project's global setup (`test/contract/pglite.global-setup.ts`) starts
  one PGlite, saves its data folder with `dumpDataDir("none")` to a
  temporary file (about 40 MB; the 5 MB gzip took 0.1 s longer to load)
  and passes the path through `provide`. `openPGlite` reads the file once
  per test file, starts each database from it with `loadDataDir` and the
  pgvector extension's files, then runs `CREATE EXTENSION vector` unless
  `pgvector` is false. The saved folder has no extension created and no
  tables, so each test still gets a database of its own in the state it
  needs (decision 60). On the same machine the project took 47 to 51 s
  before this and 23 to 26 s after. It keeps `testTimeout` and
  `hookTimeout` at 60 s: at Vitest's 10 s hook default, opening a PGlite
  in the first hook failed on busy Windows machines before this change.
- The integration suite needs a **disposable** Postgres database with
  pgvector available and a role that can create tables in `public` and
  create schemas. Each file
  applies the bundled migrations, ignoring "already exists" errors, and uses
  random entity ids. Some tests rewrite `mnemocyte_meta` and drop tables
  inside a transaction they roll back. `migrate.test.ts` cannot roll back,
  because `migrate()` commits each migration: every test drops the Mnemocyte
  tables and the file ends by leaving a tracked 1536-dimension schema for the
  files after it. Its `createExtension` tests also drop the `vector`
  extension and create and drop a non-superuser role
  (`mnemocyte_restricted_test`), so the role in `DATABASE_URL` must be a
  superuser, as it is on the Docker image and in CI. `cli.test.ts` drops
  the tables and the extension the same way and leaves the same schema, and
  so does `schema-name.test.ts`, which also creates and drops its own
  schemas. Files run serially with a 60 s timeout. When `DATABASE_URL` is
  unset the tests load `.env` from the folder they run in,
  `packages/mnemocyte/` (not the root), so set it explicitly. A throwaway
  container, as CI uses (create the extension once the server is up, then
  remove the container when done):

  ```bash
  docker run -d --name mnemocyte-test -e POSTGRES_PASSWORD=postgres -p 5434:5432 pgvector/pgvector:0.8.7-pg18
  docker exec mnemocyte-test psql -U postgres -c "CREATE EXTENSION IF NOT EXISTS vector"
  DATABASE_URL=postgres://postgres:postgres@localhost:5434/postgres pnpm test:integration
  docker rm -f mnemocyte-test
  ```
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
  `DATABASE_URL` is set; they apply the schema with `migrate()` (without
  `createExtension`) and give every memory its own seeded vector. It is not
  part of CI.
- `pnpm bench:postgres` runs `test/benchmarks/postgres-plans.bench.ts` in the
  `integration (bench)` project, from `src/`. It is the `EXPLAIN (ANALYZE,
  BUFFERS)` evidence for every default index, and it **drops and recreates
  the Mnemocyte tables**: it skips without `DATABASE_URL`, never loads
  `.env`, and refuses to start without `MNEMOCYTE_BENCH_DISPOSABLE=1`. The
  role must be able to create the `vector` extension (it migrates with
  `createExtension: true`). The documented numbers come from:

  ```bash
  docker run -d --name mnemocyte-bench --shm-size=2g -e POSTGRES_PASSWORD=postgres -p 5433:5432 pgvector/pgvector:0.8.7-pg18
  DATABASE_URL=postgres://postgres:postgres@localhost:5433/postgres MNEMOCYTE_BENCH_DISPOSABLE=1 pnpm bench:postgres
  ```

  `--shm-size` must exceed the 1 GB `maintenance_work_mem` the HNSW build
  uses, or parallel builds fail. Five phases (`MNEMOCYTE_BENCH_PHASES`,
  default `halfvec,vector,audit,history,textsearch`) seed with SQL (`test/benchmarks/postgres/seed.ts`): rows of all
  entities interleaved in time order, vectors from 256 random cluster centers
  plus noise, one memory in ten a near-copy and one in ten superseded, and
  the HNSW index rebuilt after the load. A recording executor captures the
  statements the library sends (writes are stopped before they run), and
  each is measured in a transaction that rolls back: one warm-up and
  `MNEMOCYTE_BENCH_RUNS` (5) runs in savepoints, reporting the median. Index
  counterfactuals drop a default index or create a rejected one inside that
  transaction. Recall compares HNSW results with the same statement under
  `SET LOCAL enable_indexscan = off`. The search sweep (`searchSweep`) runs
  the large entity's vector search, with and without a `kinds` filter, for
  20 query vectors at the library's `hnsw.ef_search` and at 40, 100, 150,
  200, 300 and 400, each under `relaxed_order` (the library's statement)
  and `strict_order` (the query inside its CTE), and reports per row the
  median and p90 time, mean buffers, recall and the plans used.
  `findDuplicates` on the mid entity is measured under both orderings too,
  with the scope index and without it (its HNSW path, one warm-up and 3
  runs per ordering, since each run takes about 30 s).
  `experimental.findDuplicatesPage` walks the mid and large entities
  through the library (wall clock per page and in total, pairs against the
  exact ones for mid and against one `findDuplicates` call for large), and
  measures the middle page with and without its re-check. The `history`
  phase loads the retention dataset at the 1.0 schema, times migration
  0004 against a plain column filled by one `UPDATE` (rolled back), then
  measures `listAuditLog({ memoryId })` for a five-event and a 500-event
  memory at each selector, with the default index, without it and with the
  other shapes considered, and what the column and its index cost a
  1,000-event insert. The `textsearch` phase loads the main dataset,
  measures keyword search, times the `setTextSearchConfig` rewrite to
  `simple` at 1 GB `maintenance_work_mem` for both statement lists (rolled
  back) and through the function at the server's setting, then measures
  keyword search again. Warm rows report the
  slowest run next to the median. Results go to
  `MNEMOCYTE_BENCH_OUT` or `bench-results/postgres-plans-<time>.md`
  (ignored by git); Vitest hides a passing test's console output. At the
  full scale (`MNEMOCYTE_BENCH_SCALE=1`) the run fails when a plan stops
  using the index the docs name. It takes about an hour and is not part of
  CI. Before a full run, run new or changed bench code once at a reduced
  `MNEMOCYTE_BENCH_SCALE` so every new code path executes: a typo in a new
  case once failed a full run after 46 minutes. The plan checks run only
  at scale 1, so assert that the index is used, not the exact plan shape,
  which the planner may change (a BitmapAnd plus a sort, say). The numbers are in [features/postgres.md](./features/postgres.md#indexes-measured)
  and [features/maintenance.md](./features/maintenance.md).
- Benchmarking `dist/` avoids most of the export getters Vite's module runner
  adds to `src/` cross-module calls. One call between tsdown's shared chunks
  still goes through a getter, so Vitest prints a getter warning; the
  overhead is small next to a search.

## What CI runs

`.github/workflows/ci.yml` runs on pull requests, on pushes to `main` and
when the release calls it (`workflow_call`). It has these jobs:

| Job | Runs | A PR runs it when it changes |
|---|---|---|
| `Node 22.18`, `Node 24`, `Node 26` | `test:ci` (build, then `unit`, `contract` and `package`) | `packages/mnemocyte/**`, `examples/**`, `README.md`, `LICENSE`, `docs/guide/getting-started.md` |
| `Checks` | `checktypes`, `lint`, `test:checks` (build, then `test:types`, `test:readme`, `test:jsdoc`, `test:examples`), on Node 24 | the same files as the Node jobs |
| `Package` | `lint:package` (build, pack, publint, attw) | in `packages/mnemocyte/`: `src/**`, `migrations/**`, `scripts/**`, `tsconfig*.json`, `tsdown.config.ts`; and `README.md`, `LICENSE` |
| `Postgres 17/18 integration (postgres.js 3/4)` | `test:integration`, four jobs | in `packages/mnemocyte/`: `src/**`, `test/**`, `migrations/**`, `vitest.config.ts` |
| `libSQL server integration` | `test:integration:libsql` on a libSQL server (sqld) container, on Node 24 | the same files as the Postgres jobs |
| `Site` | the root `lint`, then the site's typecheck, test and build | `apps/site/**`, `CHANGELOG.md` |
| `Links` | `test:links` (relative links and anchors in the Markdown) | `docs/**`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, `LICENSE`, `examples/README.md`, `apps/site/AGENTS.md`, `scripts/check-links.mjs`, `packages/mcp/README.md`, `packages/mcp/CHANGELOG.md` |
| `MCP (Node 22.18/24/26)` | `test:mcp` (build `mnemocyte`, then `@mnemocyte/mcp`'s build and tests); on Node 24 also `checktypes:mcp`, `lint` and `lint:package:mcp` | `packages/mcp/**`, `packages/mnemocyte/src/**` (the public API it uses and the CLI loader it copies), `LICENSE` |

- A change to `.github/**`, the root `package.json`,
  `packages/mnemocyte/package.json`, `examples/package.json`,
  `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `biome.json`, `.gitignore` or
  `.gitattributes` runs every job. Biome skips what `.gitignore` ignores
  (`vcs.useIgnoreFile` in both Biome configs), and `.gitattributes` sets
  the line endings of every checked-out file.
- Other files run no job: `CLAUDE.md`, `.editorconfig` and `.vscode/`.
  Biome reads `.editorconfig` only with `formatter.useEditorconfig`,
  which is off.
- The Links list holds the Markdown files the check reads and the
  non-Markdown files they link to (only `LICENSE` today), so renaming or
  deleting a link target also runs it. A doc that starts linking to
  another kind of file (a migration, a source file) needs that path on
  the Links list. The job installs dependencies for `github-slugger` and
  does not build.
- `README.md` and `LICENSE` are on the Node and Package lists because the
  package's `prepack` copies them into the tarball, which the `package`
  project and `lint:package` pack. `apps/site/AGENTS.md` is on the Links
  list because `CONTRIBUTING.md` links to it.
- `docs/guide/getting-started.md` is on the Node list because
  `test/cli/init.test.ts` compares its `memory.ts` blocks with the
  `mnemocyte init` templates. A test or script that starts reading another
  file needs that file on its job's list.
- The MCP list has `packages/mnemocyte/src/**` because `@mnemocyte/mcp`
  builds against that source's `dist/` and `test/loader-copy.test.ts`
  compares the CLI's loader with its copy. A change to only
  `packages/mcp/**` runs no `Checks` job, so the MCP job runs `lint`
  itself. `packages/mcp/package.json` is on the MCP list, not the list
  that runs every job; a dependency change also changes `pnpm-lock.yaml`,
  which is.
- Lint and the type-level checks give the same result on every Node
  version, so they run once, in `Checks`, and the Node jobs run only the
  build and the Vitest projects. The `contract` project on PGlite still
  takes the most Vitest time summed over its files, but since it starts
  each database from a saved data folder ("Testing" above) none of its
  files took over 15 s on PR #127, where the Vitest runs took 41 to 69 s
  (103 to 111 s before). The slowest single file is now
  `test/package/cli.test.ts` (17 to 29 s there), which runs the built CLI
  in child processes.
- The Node jobs' `contract` project includes the libSQL contract on
  database files, through `@libsql/client`'s native `libsql` binding for
  the runner's platform; no service is needed. The libSQL server run
  (`test/integration/libsql-remote.test.ts`) skips in the Postgres jobs,
  which set no `LIBSQL_URL`, and runs in `libSQL server integration`
  (decision 71). That job runs only this file
  (`pnpm test:integration:libsql`), on Node 24 only: it tests the Hrana
  protocol and the server's SQL parser, and the Node jobs already run
  the libSQL contract on files. Its list is the Postgres list in an output
  of its own: the suite reaches `src/store-test/`, `test/fixtures/` and
  `test/helpers.ts`, and `migrations/libsql/` through the
  bundle in `src/db/libsql/bundled.ts`, so a narrower list would miss the
  next shared file.
- The libSQL server service is
  `ghcr.io/tursodatabase/libsql-server:d6c75af@sha256:6dd3eb27…` in
  `ci.yml`: the image's newest tags are short commit SHAs, and the digest
  keeps a re-pushed tag from changing the image. The image has no `curl`
  or `wget` for a `--health-cmd`, so a step polls `GET /health` from the
  runner before the tests, with `--retry-all-errors` (plain `--retry`
  gives up on a connection reset or an empty reply, which Docker's port
  proxy can return before the server listens). Dependabot's `github-actions` ecosystem
  documents updates to `uses:` references only, not service images, so
  the pin is bumped by hand: compare the digest of `latest` with the pin,
  and when it differs, take the newest SHA tag with the same digest from
  the [package page](https://github.com/tursodatabase/libsql/pkgs/container/libsql-server)
  and update `ci.yml`, this bullet and the local command in
  [features/libsql.md](./features/libsql.md#tests):

  ```bash
  docker buildx imagetools inspect ghcr.io/tursodatabase/libsql-server:latest --format '{{.Manifest.Digest}}'
  ```
- The Postgres jobs run all four combinations on every PR that changes
  their files (decision 55). They enable pgvector with `docker exec` on
  `job.services.postgres.id`, the service container's id, so `psql` runs
  inside the container and the runner needs no PostgreSQL client.
- Every job installs the whole workspace, site included.
  `pnpm install --filter mnemocyte` skips the site's dependencies, but the
  install step takes 1 to 4 seconds from the pnpm store cache, and the
  cache (keyed on `pnpm-lock.yaml`) is restored whole either way. A
  filtered job that saved the cache first would also leave the Site job a
  partial store until the lockfile changes.
- The Site job runs the root `pnpm lint`: it checks `apps/site/` with
  `apps/site/biome.json`, as the site's own `lint` does, but also fails on
  warnings. A site-only PR skips `Checks`, so a warning would
  otherwise first fail on `main`.
- The first job, `Changes`, decides. On a pull request the checkout is the
  PR's test merge commit (`refs/pull/N/merge`); `fetch-depth: 2` also
  fetches its parents. The base is the parent that is not the PR head
  (`github.event.pull_request.head.sha`), so the diff does not depend on
  the parent order, which GitHub does not document. If `HEAD` is not a
  two-parent merge with the PR head, the job warns and runs everything.
  The lists are `grep -E` patterns in that step: add a new top-level file
  or folder to the jobs that read it. A push or a release run (a called
  workflow sees its caller's event) skips the diff and runs everything,
  except that the release passes `release: true` and skips `Site`
  (decision 59).
- The last job, `CI ok`, needs all the others and runs unless the run was
  cancelled. It fails when any of them failed or was cancelled. A job
  skipped by its `if` reports success. If `main` ever gets a ruleset,
  require `CI ok`, which runs on every PR, rather than the jobs it sums
  up. A skipped matrix job reports one check under its unexpanded name
  (`Node ${{ matrix.node-version }}`, seen on PR #123), so a required
  `Node 24` would never report on a docs-only PR. (A workflow skipped by
  a path filter would leave its required checks Pending, which blocks the
  merge.)
- Built-in `on.pull_request.paths` was not used because it filters whole
  workflows, not jobs (decision 54).
- The diff is the PR's net change against the current base, not its last
  push: a later commit that reverts a file takes it off the list, and
  commits that reached `main` after the branch was cut are left out.
- `concurrency` groups runs by `github.workflow` and `github.head_ref ||
  github.run_id`. `head_ref` is set only for pull requests, so a new push
  to a PR cancels its older run, while pushes to `main` and release runs
  get their unique run id and are never cancelled. In a called workflow
  `github.workflow` is the caller's name (`Release`), which differs from
  the release's own `release-<tag>` group; GitHub warns that a caller and
  callee sharing one group with `cancel-in-progress` cancels the caller.
- The token is read-only (`permissions: contents: read`; a called workflow
  can only keep or lower its caller's permissions), and every checkout
  sets `persist-credentials: false`, so checkout does not store the token
  for later steps, such as dependency install scripts, to read.
- Every job sets `timeout-minutes` (the default is 360), well above its
  usual time on the last `main` run before this change: Node 15 (1.5 to
  2.5 minutes), Postgres 15 (1 to 1.5), Package 10 (under 30 seconds),
  Site 10 (under a minute), `Changes` and `CI ok` 5. `Checks`, added
  later, has 10, `Links` 5 and `libSQL server integration` 10.
- Both workflows pin each action to a full-length commit SHA with its
  release after it (`actions/checkout@<sha> # v7.0.1`), since the release
  runs `ci.yml` and its publish job holds the npm OIDC token (decision
  58). Take a new SHA from the action's own repository, not a fork
  (`gh api repos/OWNER/REPO/commits/TAG --jq .sha`), and keep the comment
  on the same line. `.github/dependabot.yml` updates the `github-actions`
  ecosystem only, weekly, in one `actions` group, with a 7-day
  `cooldown` (`default-days`; the `semver-*-days` keys do not apply to
  actions) and the `chore(ci)` commit prefix. It does not manage npm
  dependencies, which follow pnpm's minimum release age. Dependabot
  alerts do not cover SHA-pinned actions. Edit a Dependabot PR's title to
  the repository's commit rules before the squash merge if it is too long.

## Releasing

The maintainer cuts a release; `.github/workflows/release.yml` publishes it
when a `v*` tag is pushed.

When to release (agreed 2026-11-15), with no fixed schedule:

- **Patch (1.x.y):** right away, for a bug that hurts users, when
  `[Unreleased]` holds fixes only.
- **Security fix:** a patch of the newest 1.x minor, the only line that
  gets them (`SECURITY.md`). Reports arrive through GitHub private
  vulnerability reporting as a draft advisory; fix it there or in its
  temporary private fork, release, and publish the advisory once npm has
  the version.
- **Minor (1.x.0):** after a group of features lands, such as a finished
  ROADMAP section. Any `Added` or `Deprecated` entry in `[Unreleased]`
  makes the next version a minor.
- **Major (2.0):** only for changes that break the documented API. The
  ROADMAP is a work queue, not a version plan; its items ship across 1.x
  minors.
- A question about releasing is not a request for one. Open a release PR
  only when the maintainer asks for it.

1. On a `chore/release-vX.Y.Z` branch, run
   `pnpm version patch --no-git-tag-version` (or `minor`) in
   `packages/mnemocyte/`, which changes only its `package.json`, then move
   the `CHANGELOG.md` `[Unreleased]` entries under the new version. Bump first: pnpm 12 stops with
   `ERR_PNPM_UNCLEAN_WORKING_TREE` when the tree has changes (or add
   `--no-git-checks`). For the first release candidate, give the version
   (`pnpm version 1.0.0-rc.1 --no-git-tag-version`), since `premajor` would
   produce `rc.0`.
2. Open a PR titled `chore(release): vX.Y.Z` and squash merge it once CI
   passes. The tag is created after the merge, because a squash merge gives
   the commit a new SHA.
3. Pull `main`, then `git tag -a vX.Y.Z -m vX.Y.Z` and
   `git push origin vX.Y.Z`.
4. Once npm has the version, create the GitHub release. For a version with
   a prerelease part, mark it as a prerelease and say it installs with
   `mnemocyte@next`.
5. After a final release, the publish job removes a stale `next` (see
   below). If its `Remove stale next dist-tag` step warns, check
   `npm view mnemocyte dist-tags`, remove a stale `next` with
   `npm dist-tag rm mnemocyte next` from your own npm login, and check
   that "Allow npm dist-tag" is on for the trusted publisher.

The release workflow runs three stages:

- `verify` fails unless the tag equals `v` + the
  `packages/mnemocyte/package.json` version,
  `CHANGELOG.md` has a `## [X.Y.Z] - YYYY-MM-DD` heading and an
  `[X.Y.Z]: https://github.com/Meenic/mnemocyte/…` compare link for that
  version, and the tagged commit is on `main`. It runs before `ci`, so a
  missing section fails in seconds. The heading takes a hyphen, not a
  dash: entries before 0.1.3 use `—` (`## [0.1.2] — 2026-05-20`), some
  with no date, and would fail it.
- `ci` runs `ci.yml` (through `workflow_call`, with `release: true`) on the
  tagged commit. Path filtering applies only to pull requests, so every
  job runs except `Site`: the Node matrix, `Checks`, the package lint,
  `Links`, the four Postgres integration jobs and `libSQL server
  integration`. The site is not in the tarball, and the release PR and
  the push to `main` already ran it (decision 59). A job that calls a
  reusable workflow cannot set `timeout-minutes`; each `ci.yml` job has
  its own, and `verify` and `publish` have theirs.
- `publish` runs in the `npm` GitHub environment, the only job with
  `id-token: write`. It installs without a dependency cache and runs
  `pnpm publish --no-git-checks` in `packages/mnemocyte/`;
  `prepublishOnly` builds `dist/` and `prepack` copies the root
  `README.md` and `LICENSE` in ("Structure"). A version
  with a prerelease part (`0.6.0-rc.1`) gets the `next` dist-tag, any other
  `latest`, and the other tag stays where it was. `--no-git-checks` is
  needed because a tag checkout is a detached HEAD; `verify` does the
  branch check instead.
  `--publish-wait-timeout 600000` keeps the job running until the version
  is installable: npm scans each upload before it shows up, which took about
  two minutes for 0.5.1. If it is not available after 10 minutes the job
  fails with `ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT`, but the upload stays
  accepted and can still appear later, so check npm before retrying.
- After a final release (no `-` in the tag), `publish` also runs
  `Remove stale next dist-tag`, which reads `next` with `pnpm view`. When
  `next` is older than or equal to the version just published once its
  prerelease part is dropped (`1.3.0-rc.2` after `1.3.0`), it runs
  `pnpm dist-tag rm mnemocyte next`; otherwise `mnemocyte@next` would
  keep installing the old prerelease. A `next` ahead of the release
  (`1.4.0-rc.1` after `1.3.1`) stays. pnpm 12.12.1 and newer does the
  OIDC exchange for `dist-tag` itself, so the npm CLI version on the
  runner does not matter (Node 24.22.3 bundles npm 11.19.1, below the
  11.21.0 npm needs for dist-tags over OIDC). If the read or the removal
  fails, the step prints a warning and the job still passes: the version
  is already published, and a re-run would fail on the publish. pnpm
  does not prompt: against a local registry stub that refused the
  request with a 403, `pnpm dist-tag rm` exited at once with
  `ERR_PNPM_FORBIDDEN`.

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
  it when saved; a mistake shows up as a failed publish. It needs "Allow
  npm dist-tag" turned on (off by default; publish access does not
  include it) for the publish job to remove a stale `next`.
- After the first trusted publish, the package's publishing access is
  "Require two-factor authentication and disallow tokens". Trusted publishing
  keeps working under that setting.

A failed publish can be retried by re-running the workflow; the tag stays.
If the fix needs a new commit, delete the tag, merge the fix and tag again.
npm never accepts the same version twice, so once a version is published a
fix needs a new version.

### `@mnemocyte/mcp`

`@mnemocyte/mcp` has its own version (0.x) and changelog
(`packages/mcp/CHANGELOG.md`) and releases on its own, whenever its
`[Unreleased]` has entries, with the same rules for patch and minor
(decisions 84 and 89). A change that needs a newer `mnemocyte` raises the
peer range and waits for that `mnemocyte` release.

1. On a `chore/release-mcp-vX.Y.Z` branch, run
   `pnpm version patch --no-git-tag-version` (or `minor`) in
   `packages/mcp/`, then move its `[Unreleased]` entries under
   `## [X.Y.Z] - YYYY-MM-DD` and add an
   `[X.Y.Z]: https://github.com/Meenic/mnemocyte/releases/tag/mcp-vX.Y.Z`
   link at the end of that file.
2. Open a PR titled `chore(release): mcp-vX.Y.Z` and squash merge it once
   CI passes.
3. Pull `main`, then `git tag -a mcp-vX.Y.Z -m mcp-vX.Y.Z` and
   `git push origin mcp-vX.Y.Z`. `release.yml` reads the package from the
   tag prefix, checks `packages/mcp/package.json` and its changelog, runs
   CI, builds `mnemocyte` (the workspace link the build needs) and
   publishes from `packages/mcp/`. The dist-tag and the stale-`next`
   check read the version, not the tag, which has a hyphen of its own.
4. Once npm has it, create a GitHub release titled `@mnemocyte/mcp
   vX.Y.Z`, not marked as latest, so the repository's latest release stays
   `mnemocyte`'s.

The first version cannot go through the workflow: npm configures a
trusted publisher only for a package that already exists. Step 1 above
still applies, with two differences: the version is already 0.1.0, so
only the changelog moves, and 0.1.0 gets no tag (see below), so its link
is `[0.1.0]: https://www.npmjs.com/package/@mnemocyte/mcp/v/0.1.0`. Then
the maintainer, once:

1. makes sure the `@mnemocyte` scope on npm belongs to them (an
   organization or user named `mnemocyte`);
2. publishes 0.1.0 from their own login on an up-to-date `main`:
   `pnpm --filter mnemocyte build`, then
   `pnpm publish --access public --no-provenance` in `packages/mcp/`
   (provenance needs the workflow's OIDC token, and pnpm's docs name
   `--no-provenance` as the way to publish without it), and does not
   push an `mcp-v0.1.0` tag, whose workflow would try to publish the
   version again and fail;
3. adds the trusted publisher for `@mnemocyte/mcp`: GitHub Actions,
   `Meenic` / `mnemocyte`, workflow `release.yml`, environment `npm`, with
   "Allow npm dist-tag", and sets publishing access to "Require two-factor
   authentication and disallow tokens";
4. adds `mcp-v*` to the tags the `npm` GitHub environment allows.

From then on, `mcp-v*` tags publish with provenance.

### Release text

GitHub release title: `mnemocyte vX.Y.Z`. Description:

```markdown
### Category
- **Short label**: concise description of the change

**Full Changelog**: https://github.com/Meenic/mnemocyte/compare/vPREVIOUS...vCURRENT
```

Categories: Performance, Accuracy, Reliability, Embedders, Documentation,
Tooling, API. Keep it factual, with no validation section.
