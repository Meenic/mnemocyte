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
  the env files, the `DATABASE_URL` fallback, `init`, `migrate`, `check` and
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
`migrate` and `check` read `.env.local` and `.env` in the current folder,
so run them from a scratch project, never from this repository's root.

## Structure

The repository is a pnpm workspace (`pnpm-workspace.yaml`: `packages/*`,
`apps/*`, `examples`):

```txt
packages/mnemocyte/     the published `mnemocyte` package: src/, test/, migrations/, scripts/, its configs and package.json
packages/mcp/           the published `@mnemocyte/mcp` package: the MCP server and its bin; README.md and CHANGELOG.md of its own
packages/loader/        the private `@mnemocyte/loader` package: the env file order, the memory file lookup and the resolve hook both bins bundle
packages/release/       the private `@mnemocyte/release` package: the published packages' list, the changelog parser the site shares, and `release:prepare`, `release:notes` and `release:check`
apps/site/              the website (Next.js), the private `@mnemocyte/site` package; rules in apps/site/AGENTS.md
examples/               runnable scripts, the private `@mnemocyte/examples` package on "mnemocyte": "workspace:*"
docs/                   the user guide, these contributor docs, ARCHITECTURE.md and ROADMAP.md
scripts/                check-links.ts: relative links in the repository's Markdown
package.json            the private workspace root: packageManager, Biome, github-slugger, TypeScript for scripts/, pass-through scripts
tsconfig.json           types for the root scripts/ only
README.md, CHANGELOG.md, LICENSE, CONTRIBUTING.md, SECURITY.md, AGENTS.md, CLAUDE.md, biome.json, .github/, .vscode/
```

Libraries go under `packages/`, things that are run or deployed under
`apps/` (decision 53). `@mnemocyte/mcp` is `packages/mcp/`, with
`mnemocyte` as a peer and a `workspace:*` dev dependency, so it builds and
tests against `packages/mnemocyte/dist/`; see
[features/mcp.md](./features/mcp.md).
`@mnemocyte/loader` is `packages/loader/`: what both bins need to read
an app's env files and find and load its memory file
(`src/env-files.ts`: `.env.local`, then `.env`; `src/memory-file.ts`: the
folders and names searched and `findMemoryFile`; `src/resolve-hook.ts`;
`src/tsconfig.ts`). It is `"private": true` and never published. Its
`exports` point at its TypeScript source, so it has no build: both
packages list it as a `workspace:*` dev dependency, and tsdown bundles
it into their `dist/cli.mjs`, since tsdown leaves only `dependencies`
and peer and optional dependencies external (decision 93). A
`dependencies` entry would not publish (pnpm refuses a private
workspace package there). Its tests are its own
(`pnpm test:loader`); see
[features/cli.md](./features/cli.md#loading-the-memory-file).
`@mnemocyte/release` is `packages/release/`: `src/packages.ts` lists
the published packages (name, folder, changelog, tag prefix, GitHub
release title, whether it is the repository's latest release, and the
oldest release `release:check` reads), `src/changelog.ts` parses a Keep a
Changelog file, and `src/bin/` holds the three commands and `list.ts`,
which release.yml's plan job runs ("Releasing").
It is `"private": true` and never published. Node runs its TypeScript
through type stripping, so files import each other by their `.ts` name.
The site imports `@mnemocyte/release/changelog`, which imports no file
of its own because the site type-checks it with its own settings, and
Turbopack compiles workspace packages without `transpilePackages`.
`src/packages.ts` imports nothing and `src/bin/list.ts` only it and
Node's own modules, so that job runs before installing. Its tests are
its own (`pnpm test:release`).
`examples/` stays at the root, where GitHub readers look for it, and
installs `mnemocyte` from the workspace the way an app installs it from
npm. Only the root `package.json` sets `packageManager`; `engines` is in
both.

`README.md` and `LICENSE` live at the root, where GitHub shows them. The
package's `prepack` script (`scripts/copy-readme.ts`) copies both into
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
  cli/                  main, args, io, memory-file, target, init, init-app, migrate, check, sql, generate, drizzle, text-search (the resolve hook is in packages/loader/)
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
    detect.ts           detectClient, detectLibsqlClient, directConnectionFor: shape checks, PostgresClient and LibsqlClient types (no adapters, in the root entry)
    clients.ts          executorFor / toSqlExecutor / detectSqlClient: detected client → its adapter
    postgres-js.ts      the postgres.js adapter (internal)
    node-postgres.ts    the node-postgres Pool adapter
    neon-http.ts        the Neon HTTP adapter (neon() from @neondatabase/serverless): query plus batch, no transaction
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
scripts/                bundle-migrations.ts, bundle-libsql-migrations.ts, bench-libsql.ts, check-package.ts, check-readme.ts, check-jsdoc.ts, copy-readme.ts
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
`@libsql/client`, `@neondatabase/serverless` (`>=1.0`) and `drizzle-orm`
are optional peer dependencies at the
versions the tests run; source files import at most their types
(`postgres` and `drizzle-orm` only; the libSQL and Neon client types are
structural), so no built entry imports a driver (a package test follows
each entry's static imports to check this). They are also dev
dependencies, with `@types/pg` and `@electric-sql/pglite-pgvector`. `ai` is an optional peer too
(`^7.0.135`) and a dev dependency (it brings `zod`, its peer, into the
lockfile); `src/ai-sdk.ts` and the files in `src/ai-sdk/` import it at
runtime, the only source files that do, and a package test follows
the static imports of every other entry to check that none reaches it.
`vitest` is an optional peer (`^5.0.0`) the same way: `src/store-test.ts`
and `src/store-test/` import it at runtime, and a package test checks that
no entry but `mnemocyte/store/test` reaches it. The bundled
`@mnemocyte/loader` is for the bin alone: a package test checks that no
export reaches `registerHooks`, so an app that imports the library never
installs a module hook.

TypeScript compiles against `target` and `lib` `es2024`, the newest edition
Node 22.18 fully supports. There are two configs:

- `tsconfig.build.json` holds the build settings for `src/` alone; tsdown
  reads it (`tsconfig` in `tsdown.config.ts`), and so does
  `test/package/tsconfig.json`. `isolatedDeclarations` is on there, so
  every export needs a type a declaration emitter can read without
  inference (explicit return types on exported functions).
  `erasableSyntaxOnly` is on there too, so no file uses syntax Node's type
  stripping cannot remove: no `enum`, no runtime `namespace`, no parameter
  properties (`constructor(readonly x: T)`; declare the field instead).
- `tsconfig.json` extends it for the whole package: `src/`, `test/`,
  `scripts/` and the config files, with `paths` to `src/` and
  `isolatedDeclarations` off. Editors only pick up files named
  `tsconfig.json`, so this is the one that must cover the tests and
  scripts; a file no config includes lands in an inferred project, where
  TypeScript 6 loads no `@types` and `node:` imports and `process` fail.
  `pnpm checktypes` runs both, so the editor does not flag a missing
  return type in `src/` but CI does.

`examples/tsconfig.json` stands on its own: no `paths`, so the examples
resolve `mnemocyte` to `packages/mnemocyte/dist/` through the
`workspace:*` link (see `pnpm test:examples` under Testing).

The scripts in `scripts/` (the root's and each package's) are TypeScript
that Node runs directly: `node scripts/<name>.ts`, with no build step,
through type stripping, which is on by default from Node 22.18 (decision
91). Node reads no `tsconfig.json`, so a script imports types with
`import type` (`verbatimModuleSyntax` checks it). No script imports
another: Node needs the `.ts` extension in such an import, and the
configs would then need `allowImportingTsExtensions`, which `src/` must
not get. Each package's `tsconfig.json` covers its own
`scripts/`, and the root `tsconfig.json` covers the root `scripts/`
(`pnpm checktypes:scripts`, which `pnpm checktypes` runs first).
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
| `integration` | `test/integration/**/*.test.ts` | `src/` through aliases | `pnpm test:integration` (`pnpm test:integration:libsql` for the libSQL server file alone, `pnpm test:integration:neon` for the Neon file) |

- `unit` and `integration` map `mnemocyte` to `src/` with `resolve.alias`,
  and `tsconfig.json` does the same with `paths`. The `package` project
  and `test/package/tsconfig.json` have neither: `mnemocyte` resolves to
  `dist/` through the package's own `exports` (package self-reference), the
  way a consumer resolves it.

- `pnpm test` at the root runs `pnpm test:links`, `pnpm test:loader`
  (`@mnemocyte/loader`'s Vitest: the env file order, the lookup,
  `parseJsonc`, `paths` through `extends`, import candidates and
  `resolveAppImport` on temporary folders), the package's `test`
  (`test:checks`, then `test:ci`), `@mnemocyte/mcp`'s `test` (its build
  and Vitest, against the `mnemocyte` build just made), then
  `pnpm test:examples`. `pnpm checktypes` covers all three packages and
  `pnpm build` the two published ones (the loader has no build), and
  `checktypes` the root `scripts/` as well;
  `checktypes` builds `mnemocyte` first, because
  `@mnemocyte/mcp` type-checks against its `dist/`. The `*:mcp` scripts
  (`build:mcp`, `checktypes:mcp`, `test:mcp`, `lint:package:mcp`,
  `pack:check:mcp`) run one step for `@mnemocyte/mcp` alone, building
  `mnemocyte` first where they need it (decision 75); its tests are in
  [features/mcp.md](./features/mcp.md#tests). The root
  `test:checks` is the package's `test:checks`, which builds and runs the
  type-level checks `test:types`, `test:readme` and `test:jsdoc`, then
  `pnpm test:examples`. `test:ci` builds again (under a second) and runs
  `unit`, `contract` and `package`. CI runs `test:links` in the Links
  job, `test:checks` once, in the Checks job, and `test:ci` and
  `test:loader` on each Node version ("What CI runs" below).
  `pnpm test:exports` builds and runs `test:types` and `package` alone.
- `pnpm test:types` runs `tsc --noEmit -p test/package/tsconfig.json`, which
  type-checks every public export in `test/package/exports-types.test-d.ts`
  against the built `dist/*.d.mts`, so it needs a build first. The file has
  no `test()` blocks, and Vitest's `--typecheck` drops type errors outside
  test blocks, so plain `tsc` checks it instead. The `@ts-expect-error`
  negative cases fail with TS2578 if they stop being errors.
- `pnpm test:readme` (`scripts/check-readme.ts`) type-checks the root
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
- `pnpm test:jsdoc` (`scripts/check-jsdoc.ts`) type-checks the `ts` blocks
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
- `pnpm test:links` (the root `scripts/check-links.ts`) checks that
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
  with `drizzle-orm`, `postgres`, `pg`, PGlite, `@libsql/client`,
  `@neondatabase/serverless` and `ai` absent. A test that runs scripts in
  a consumer takes a 30 s timeout of its own (the third argument to
  `test`): `libsql.test.ts` hit Vitest's
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
  TypeScript memory file, the resolve hook (`server-only` included) and
  the env files run on each CI Node version; and the `DATABASE_URL` path
  on real Postgres in `test/integration/cli.test.ts`.
- `test/embedders/voyage.test.ts`, `cohere.test.ts` and `google.test.ts`
  stub `fetch` (helpers in `fetch-mock.ts`) and check each request's URL,
  headers and body per purpose, the dimension rules, response checks and
  error mapping against the error bodies the provider docs show. No test
  calls a provider.
- `test/embedders/ai-sdk.test.ts` drives `aiSdkEmbedder` with the AI SDK's
  `MockEmbeddingModelV4` and `customProvider` (as the global provider for
  string ids), and with a real `createGateway` provider over a mocked
  `fetch`, which checks the gateway request body and its error mapping.
  It also runs the guide's `@openrouter/ai-sdk-provider` example over a
  mocked `fetch` (decision 103).
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
  `test/integration/neon.test.ts` runs it over Neon's serverless driver:
  `neon()`, which has no `transaction`, so `ContractTarget.migrator` (a
  Neon `Pool`) migrates for it, and the WebSocket `Pool` itself. Drizzle
  over `neon()` (`neon-http`) gets a smoke test (save and search through
  `db.$client`) instead of a third run: Mnemocyte runs on the same
  function through the same adapter, so a second run would repeat the
  first. Last, it runs the CLI's `migrate`, `check` and `text-search` on
  a `neon()` memory file, whose own `Pool` the CLI opens on
  `DATABASE_URL_UNPOOLED` (features/cli.md, "Stores without
  transactions"); that part drops the Mnemocyte tables in `public` first,
  so the database must be disposable. It reads only
  `NEON_DATABASE_URL`, `NEON_FETCH_ENDPOINT` and `NEON_WS_PROXY`, never
  `.env`, and skips without the first, so it also runs against a real
  Neon branch by hand. For a client without `transaction` the suite
  skips its savepoint test and `migrate` must throw `"CONFIG"` (the
  shared bound-scope fixture takes `migrates: false` for that); a client
  with `batch` also runs a test that a batch commits and rolls back as
  one, with a `set_config(…, true)` reaching the later statements.
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
| `Node 22.18`, `Node 24`, `Node 26` | `test:ci` (build, then `unit`, `contract` and `package`), then `test:loader` | `packages/mnemocyte/**`, `packages/loader/**`, `examples/**`, `README.md`, `LICENSE`, `docs/guide/getting-started.md` |
| `Checks` | `checktypes`, `lint`, `test:checks` (build, then `test:types`, `test:readme`, `test:jsdoc`, `test:examples`), on Node 24 | the same files as the Node jobs |
| `Package` | `lint:package` (build, pack, publint, attw) | in `packages/mnemocyte/`: `src/**`, `migrations/**`, `scripts/**`, `tsconfig*.json`, `tsdown.config.ts`; `packages/loader/src/**` and `packages/loader/package.json`; and `README.md`, `LICENSE` |
| `Postgres 17/18 integration (postgres.js 3/4)` | `test:integration`, four jobs | in `packages/mnemocyte/`: `src/**`, `test/**`, `migrations/**`, `vitest.config.ts` |
| `libSQL server integration` | `test:integration:libsql` on a libSQL server (sqld) container, on Node 24 | the same files as the Postgres jobs |
| `Neon HTTP integration` | `test:integration:neon` through the local Neon proxy in front of Postgres 17, on Node 24 | the same files as the Postgres jobs |
| `Site` | the root `lint`, then the site's typecheck, test and build | `apps/site/**`, `packages/release/**` (the changelog parser it uses), `CHANGELOG.md` |
| `Links` | `checktypes:scripts` (the root `scripts/`), then `test:links` (relative links and anchors in the Markdown) | `docs/**`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md`, `LICENSE`, `examples/README.md`, `apps/site/AGENTS.md`, `scripts/**`, the root `tsconfig.json`, `packages/mcp/README.md`, `packages/mcp/CHANGELOG.md` |
| `Release check` | `checktypes:release`, then `test:release` (the release scripts' tests, then `release:check`) | `packages/release/**`, `CHANGELOG.md`, `packages/mcp/CHANGELOG.md`, `packages/mcp/package.json` |
| `MCP (Node 22.18/24/26)` | `test:mcp` (build `mnemocyte`, then `@mnemocyte/mcp`'s build and tests); on Node 24 also `checktypes:mcp`, `lint` and `lint:package:mcp` | `packages/mcp/**`, `packages/loader/**` (the loader it bundles), `packages/mnemocyte/src/**` (the public API it uses), `LICENSE` |

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
  builds against that source's `dist/`. `packages/loader/**` is on the
  Node, Package and MCP lists because both bins bundle it: each package's
  `loader-bundle.test.ts` compares the loader sources embedded in its
  `dist/cli.mjs.map` with `packages/loader/src/`, so the two tarballs are
  shown to carry the same, current loader. A change to only
  `packages/mcp/**` runs no `Checks` job, so the MCP job runs `lint`
  itself. `packages/mcp/package.json` is on the MCP list, not the list
  that runs every job; a dependency change also changes `pnpm-lock.yaml`,
  which is.
- `Release check` reads only the two changelogs and the two
  `package.json` versions, so a PR that touches none of them cannot
  change its result. `packages/mnemocyte/package.json` is not on its
  list because it already runs every job. `release.yml` calls `ci.yml`
  before it publishes, so a release runs it too.
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
- `Neon HTTP integration` (decision 76) runs Neon's driver against
  `pgvector/pgvector:0.8.7-pg17`, the version Neon's local-development
  guide uses, through `ghcr.io/timowilhelm/local-neon-http-proxy`, the
  proxy that guide documents: Neon's own proxy binary (its log reports
  `git:58abce0`) behind Caddy, which serves `/sql` over HTTP and `/v2`
  over WebSockets on port 4444. The Postgres service gets no port; the
  proxy starts with `docker run` on `job.services.postgres.network` after
  pgvector is enabled, because its start script runs `psql` once and exits
  when Postgres is not ready yet, which a service container could hit.
  Before that, a step stores the throwaway password with one SCRAM round
  (`SET scram_iterations = 1`, then `ALTER ROLE … PASSWORD`, the value
  read with psql's `\getenv` from the container's `POSTGRES_PASSWORD`).
  The proxy is a debug build (its binary is 628 MB) and checks the
  password with SCRAM on every HTTP request: at the default 4096 rounds a
  query took about 130 ms through it, at one round about 22 ms (16 ms over
  the `Pool`'s WebSocket, which logs in once per connection), and the
  suite went from about 125 s to 40 s locally. Through the proxy, each
  HTTP request also opens a new Postgres connection unless it sends
  `Neon-Pool-Opt-In: true`, which the driver does not; a new direct
  connection with its login took about 13 ms here, so that is left as it
  is. The proxy connects to the service's IP address, read with
  `docker inspect`:
  GitHub documents the service's label as a hostname for the job's own
  container, not for others on the network. The image has no health check,
  so a step posts `SELECT 1` to `/sql` with `curl --retry-all-errors`
  first. The connection string's host, `db.localtest.me`, only names the
  endpoint; the driver sends it in a header (HTTP) or as the `address`
  parameter (WebSockets) and never resolves it (checked with DNS lookups
  of it made to fail), so `NEON_FETCH_ENDPOINT` and `NEON_WS_PROXY` point
  at `127.0.0.1:4444` and the runner needs no DNS. The proxy logs are
  printed when the job fails. The image has one tag, `main`, and no
  releases, so `ci.yml` pins `main@sha256:cd2ae14e…` (built 2026-03-27
  from commit `7c86dc3`) and the pin is bumped by hand: compare the digest
  of `main` with the pin, and when it differs, rerun the job on the new
  digest before updating `ci.yml` and this bullet:

  ```bash
  docker buildx imagetools inspect ghcr.io/timowilhelm/local-neon-http-proxy:main --format '{{.Manifest.Digest}}'
  ```

  To run it locally, start `pgvector/pgvector:0.8.7-pg17` and the proxy on
  a Docker network of your own (`PG_CONNECTION_STRING` naming the Postgres
  container, the proxy's port 4444 published), run
  `CREATE EXTENSION IF NOT EXISTS vector` and the SCRAM step from
  `ci.yml` (without it the suite takes about three times as long), then run
  `pnpm test:integration:neon` with `NEON_DATABASE_URL` set to the
  container's login on host `db.localtest.me`, port 5432,
  `NEON_FETCH_ENDPOINT=http://127.0.0.1:<port>/sql` and
  `NEON_WS_PROXY=127.0.0.1:<port>/v2`. `ci.yml` builds that connection
  string from `NEON_HOST` rather than writing it out, because GitGuardian's
  PostgreSQL detector skips local hosts but not `localtest.me`, and flags
  the throwaway login next to it; keep it that way here and in `ci.yml`.
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
  later, has 10, `Links` 5, `libSQL server integration` 10 and
  `Neon HTTP integration` 15 (the suite takes about 40 s locally; on
  GitHub its first run took 5 minutes, before the changes in the Neon
  bullet above). `Release check` has 5: its tests and the check take
  about 7 s locally.
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

The maintainer cuts a release by merging a release PR and approving the
run it starts: `.github/workflows/release.yml` runs on every push to
`main` and publishes each package whose `package.json` version npm does
not have yet (decisions 99 and 101).

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
  ROADMAP is a work queue; its items ship across 1.x minors, grouped by
  a section's release plan where it has one ("Drivers, CLI and ORMs").
- A question about releasing is not a request for one. Open a release PR
  only when the maintainer asks for it.

1. On a `chore/release-vX.Y.Z` branch, run `pnpm release:prepare
   mnemocyte`. It reads `[Unreleased]` and picks the version: minor when
   it has an `Added` or `Deprecated` section, else patch. It stops on a
   `**Breaking…**` lead-in or a `### Breaking…` section, since a major is
   the maintainer's call; name the version then (`mnemocyte@2.0.0`). A
   version or `@patch`, `@minor`, `@major` after the name also overrides
   the proposal, so a release candidate is `mnemocyte@1.5.0-rc.1`. It
   then:
   - moves the entries under `## [X.Y.Z] - YYYY-MM-DD` (today's local
     date), leaving `## [Unreleased]` empty above it;
   - points the `[Unreleased]` link at `compare/vX.Y.Z...HEAD` and adds
     `[X.Y.Z]: …/compare/vPREVIOUS...vX.Y.Z` below it;
   - runs `pnpm version X.Y.Z --no-git-tag-version --no-git-checks` in
     `packages/mnemocyte/`, which changes only its `package.json`. Without
     the first flag `pnpm version` commits and tags; without the second
     it stops with `ERR_PNPM_UNCLEAN_WORKING_TREE` on the changelog edit.

   It prints each version with its reason, the branch name and the PR
   title. It checks every package it is given before it writes anything,
   and an empty `[Unreleased]`, a version that is not newer or one the
   changelog already has stops it. Read the diff before committing.
2. Open a PR titled `chore(release): vX.Y.Z` and squash merge it once CI
   passes.
3. The merge starts `release.yml`. After its CI passes, the
   `Publish to npm` job waits in the `npm` environment: open the run,
   choose "Review deployments" and approve. Approving is the release,
   not merging, and agents never approve. GitHub cancels a run whose
   approval waits more than 30 days; the next push to `main` starts a
   new one.
4. The run publishes, tags the merge commit `vX.Y.Z` and creates the
   GitHub release `mnemocyte vX.Y.Z` from `pnpm release:notes mnemocyte`
   ("Release text"). If its `Remove stale next dist-tags` step warns,
   check `npm view mnemocyte dist-tags`, remove a stale `next` with
   `npm dist-tag rm mnemocyte next` from your own npm login, and check
   that "Allow npm dist-tag" is on for the trusted publisher.

The release workflow has these jobs:

- `Plan` runs on every push, before installing anything:
  `packages/release/src/bin/list.ts` prints each package at its
  `package.json` version, and `npm view <pkg>@<version>` says whether
  npm has it. Only an `E404` answer means it does not; any other failure
  fails the job, so a failed lookup never reads as nothing to do. When
  npm has every version, the run stops here, so an ordinary merge runs
  CI once, on its own push. A tag for a version npm does not have stops
  the run, since the workflow never makes one before publishing. A
  version on npm without its tag or GitHub release only warns (see
  "When a release fails" below).
- `CI` runs `ci.yml` (through `workflow_call`, with `release: true`) on
  the merge commit. Path filtering applies only to pull requests, so
  every job runs except `Site`: the Node matrix, `Checks`, the package
  lint, `Links`, `Release check`, the four Postgres integration jobs,
  `libSQL server integration`, `Neon HTTP integration` and the `MCP`
  matrix. The site is not in the tarball, and the release PR and the
  push to `main` already ran it (decision 59). A job that calls a
  reusable workflow cannot set `timeout-minutes`; each `ci.yml` job has
  its own, and the release jobs have theirs.
- `Publish to npm` waits for the approval in the `npm` GitHub
  environment and is the only job with `id-token: write`. It installs
  without a dependency cache and writes each package's release text
  first, so a changelog that cannot give one stops the run before
  anything is published. It builds `mnemocyte` when `@mnemocyte/mcp` is
  listed (the workspace link its build needs), then runs
  `pnpm publish --no-git-checks` in each package's folder, in the
  package list's order, and stops at the first failure. A package npm
  already has is skipped, which makes a re-run safe. `prepublishOnly`
  builds `dist/` and `prepack` copies the root `README.md` and `LICENSE`
  in ("Structure"). A version with a prerelease part (`0.6.0-rc.1`) gets
  the `next` dist-tag, any other `latest`, and the other tag stays where
  it was. `--no-git-checks` is needed because the release text in the
  untracked `notes/` folder fails pnpm's clean-tree check
  (`ERR_PNPM_GIT_UNCLEAN`); the checkout is the `main` branch, not a
  detached HEAD.
  `--publish-wait-timeout 600000` keeps the job running until the version
  is installable: npm scans each upload before it shows up, which took about
  two minutes for 0.5.1. If it is not available after 10 minutes the job
  fails with `ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT`, but the upload stays
  accepted and can still appear later, so check npm before retrying.
  The job then fails when `npm view <pkg>@<version> dist.attestations`
  stays empty for two minutes: pnpm's `trustPolicy: no-downgrade` refuses
  a version with less trust evidence than earlier ones, which broke
  installs of Sanity's codegen 8.3.3.
- After a final release, `Publish to npm` also runs
  `Remove stale next dist-tags`, which reads `next` with `pnpm view`. When
  `next` is older than or equal to the version just published once its
  prerelease part is dropped (`1.3.0-rc.2` after `1.3.0`), it runs
  `pnpm dist-tag rm <package> next`; otherwise `<package>@next` would
  keep installing the old prerelease. A `next` ahead of the release
  (`1.4.0-rc.1` after `1.3.1`) stays. pnpm 12.12.1 and newer does the
  OIDC exchange for `dist-tag` itself, so the npm CLI version on the
  runner does not matter (Node 24.22.3 bundles npm 11.19.1, below the
  11.21.0 npm needs for dist-tags over OIDC). If the read or the removal
  fails, the step prints a warning and the job still passes, since the
  version is already published. pnpm does not prompt: against a local
  registry stub that refused the request with a 403, `pnpm dist-tag rm`
  exited at once with `ERR_PNPM_FORBIDDEN`.
- `Tag and release` has `contents: write` and no other permission, and
  runs no checkout and no install: `main` has no branch protection, so
  this token could push to it. It reads the release text the publish
  job uploaded, creates each annotated tag (`vX.Y.Z`, `mcp-vX.Y.Z`) on
  the run's commit through the API, as `git tag -a` would, and runs
  `gh release create --verify-tag` with the title from `releaseTitle`
  and that text. A final `mnemocyte` release gets `--latest`;
  `@mnemocyte/mcp` and prereleases get `--latest=false`, and a version
  with a prerelease part `--prerelease`. It skips a tag or release that
  exists. Events made with the job's `GITHUB_TOKEN` start no workflows,
  so the new tags trigger nothing.

A manual run (Actions, then Release, then "Run workflow", or
`gh workflow run release.yml`) is always a dry run: `Plan` lists every
package, CI runs, `Publish (dry run)` writes the release text and runs
`pnpm publish --dry-run` outside the `npm` environment and without
`id-token`, and `Tag and release` makes the same checks for existing
tags and releases and prints what it would do. pnpm warns
`Skipped OIDC: ERR_PNPM_ID_TOKEN_GITHUB_WORKFLOW_INCORRECT_PERMISSIONS`
for each package, which is expected without `id-token`. It does not
test the approval, the OIDC exchange, the attestation check or the API
writes. GitHub takes `workflow_dispatch` only for a workflow on the
default branch. Release runs queue one at a time: a run waiting for
approval keeps its place, and a newer push replaces any run still queued
behind it, which is safe because every run plans from scratch. Dry runs
queue on their own.

Publishing uses npm trusted publishing: pnpm exchanges the job's GitHub OIDC
(OpenID Connect) token for a short-lived npm token, so no npm token is
stored in the repository. npm then attaches a provenance attestation, a
signed statement of the repository, commit and workflow that built the
tarball, because the repository and the package are public. pnpm 11 and
newer does the exchange itself and does not need the npm CLI. Releases up to
0.5.0 were published from a laptop and have no provenance.

Repository and registry settings the workflow depends on:

- GitHub environment `npm` with a deployment rule that allows only the
  `main` branch, the maintainer as its required reviewer, and "Prevent
  self-review" off, since the maintainer's own merge starts the run they
  approve. Required reviewers work on public repositories on every plan.
- npm trusted publisher for `mnemocyte`: GitHub Actions, `Meenic` /
  `mnemocyte`, workflow `release.yml`, environment `npm`. It names no
  branch or tag, so publishing from `main` needs no change, but the
  workflow file name must stay. npm does not check it when saved; a
  mistake shows up as a failed publish. It needs "Allow npm dist-tag"
  turned on (off by default; publish access does not include it) for
  the publish job to remove a stale `next`.
- After the first trusted publish, the package's publishing access is
  "Require two-factor authentication and disallow tokens". Trusted publishing
  keeps working under that setting.

### When a release fails

npm never accepts the same version twice, so once a version is published
a fix needs a new version. Otherwise:

- CI fails before the approval: fix it on a branch and merge; the next
  push's run plans again.
- `Publish to npm` fails: "Re-run failed jobs" runs it again after a new
  approval and skips what npm already has. If the fix needs a commit,
  merge it, and the next run publishes what npm still lacks. A package
  that did publish in the failed run is then left without a tag, and the
  plan warns about it on every run. Tag the commit that run published
  and create its release by hand, as the tags job would:

  ```bash
  git tag -a vX.Y.Z -m vX.Y.Z <sha>
  git push origin vX.Y.Z
  pnpm release:notes mnemocyte > notes.md
  gh release create vX.Y.Z --verify-tag --title "mnemocyte vX.Y.Z" --notes-file notes.md
  ```

  A tag pushed by hand starts no workflow.
- `Tag and release` fails: re-run it; it skips what exists.

### `@mnemocyte/mcp`

`@mnemocyte/mcp` has its own version (0.x) and changelog
(`packages/mcp/CHANGELOG.md`) and releases on its own, whenever its
`[Unreleased]` has entries, with the same rules for patch and minor
(decisions 84 and 89). A change that needs a newer `mnemocyte` raises the
peer range and waits for that `mnemocyte` release. Both bins bundle
`packages/loader/`, so a user-visible change there needs an entry in
both changelogs and reaches each bin with that package's next release.

1. On a `chore/release-mcp-vX.Y.Z` branch, run `pnpm release:prepare
   @mnemocyte/mcp`, which works as for `mnemocyte` in
   `packages/mcp/CHANGELOG.md` and `packages/mcp/`. That changelog has no
   `[Unreleased]` link, so the version's link goes above the others: a
   compare from the last `mcp-v` tag, or `releases/tag/mcp-vX.Y.Z` when
   there is none. A version counts as tagged when its link is a compare
   or tag URL in this repository; 0.1.0's links to npm.
2. Open a PR titled `chore(release): mcp-vX.Y.Z` and squash merge it once
   CI passes.
3. Approve the run as for `mnemocyte`. It builds `mnemocyte` and
   publishes from `packages/mcp/`, tags `mcp-vX.Y.Z` and creates the
   GitHub release `@mnemocyte/mcp vX.Y.Z` with `--latest=false`, so the
   repository's latest release stays `mnemocyte`'s. The dist-tag and the
   stale-`next` check read the version, not the tag, which has a hyphen
   of its own.

When both packages release together, as 1.4.0 and mcp 0.2.0 did, one PR
can carry both: `pnpm release:prepare mnemocyte @mnemocyte/mcp` prepares
both and prints the title, `chore(release): vX.Y.Z, mcp-vA.B.C`. Its
merge starts one run with one approval, which publishes `mnemocyte`
first and tags both on the merge commit. If `@mnemocyte/mcp` fails after
`mnemocyte` published, re-run the failed job ("When a release fails").

The first version could not go through the workflow: npm configures a
trusted publisher only for a package that already exists. 0.1.0 was
published by hand on 2026-11-23, without a tag, so its changelog link is
`[0.1.0]: https://www.npmjs.com/package/@mnemocyte/mcp/v/0.1.0`. The
steps, for the record and for any new package:

1. Own the scope on npm (here the `mnemocyte` organization, with the
   maintainer as owner: `npm org ls mnemocyte <user>`).
2. Sign in with `pnpm login`. pnpm 12 does not use the token `npm login`
   writes; with only that one, `pnpm whoami` failed with 401 and
   `pnpm publish` with "404 Not Found" (2026-11-23).
3. On an up-to-date `main`, `pnpm --filter mnemocyte build`, then
   `pnpm publish --access public --no-provenance` in the package folder.
   Provenance needs the workflow's OIDC token, and pnpm's docs name
   `--no-provenance` as the way to publish without it. Push no tag for
   this version.
4. Wait a minute or two. A new package first shows only a public
   `0.0.0-stage` placeholder, tagged `latest`; once npm has scanned the
   upload, the real version appears and `latest` moves to it. The
   placeholder version stays.
5. Add the trusted publisher: GitHub Actions, `Meenic` / `mnemocyte`,
   workflow `release.yml`, environment `npm`, with both "Allow npm
   publish" and "Allow npm dist-tag" ticked. Trusted publishers created
   after 2026-09-03 allow only `npm stage publish` by default, and the
   workflow runs a plain `pnpm publish`. These fields cannot be changed
   later. Then set publishing access to "Require two-factor
   authentication and disallow tokens".
6. Add the package to `packages/release/src/packages.ts` only after this
   publish. Before it, the plan would find a version npm does not have,
   and the publish would fail without a trusted publisher. Until its
   next version, the plan warns on every run that the hand-published
   one has no tag, and `release:check` fails on its npm link (see
   ROADMAP.md, "Release automation"; to decide with the next new
   package).

From then on, the package publishes through `release.yml` with
provenance. Its first such release is also the first run of that path,
so watch its `Publish to npm` job.

### Release text

`pnpm release:notes <package> [<version>]` prints a version's GitHub
release text, for the version in the package's `package.json` unless
one is given (decision 99). It reads the version's section in the
package's changelog and prints:

- the intro, the section's first paragraph, on one line;
- for a version with a prerelease part, "This is a prerelease: install it
  with `npm install <package>@next`.";
- each `###` heading with its entries' bold lead-ins as a list, without
  the rest of each entry;
- `Every change in full:` and a link to the section's heading on GitHub;
- `**Full Changelog**:` and a compare link from the package's previous
  tag, when it has one (decided as in `release:prepare` above).

Relative links become GitHub URLs on `main`, as the README's do in the
tarball (decision 74): from the changelog's folder, so `../../docs/…` in
`packages/mcp/CHANGELOG.md` works, and `#anchor` to the changelog itself.
A link outside the repository, a reference-style link (`[text][label]`,
or `[1.4.0]` alone, since the text carries no link definitions), an
entry without a lead-in or a section without an intro stops it. For `mnemocyte` the intro and lead-ins are
what the site's changelog page shows; both read them with
`@mnemocyte/release/changelog`. pnpm prints its `$ node …` line on
standard error, so `pnpm release:notes mnemocyte > notes.md` holds only
the text.

The text only reads well when each lead-in is a whole sentence, so
`pnpm release:check`, in the `Release check` CI job, fails on an entry
without a bold lead-in or with one that does not end with `.`, `!` or
`?`. It reads `[Unreleased]` and the releases from `checkedFrom` up
(1.0.0 for `mnemocyte`, 0.1.0 for `@mnemocyte/mcp`), and also fails
when a package's version has no `## [X.Y.Z] - YYYY-MM-DD` heading or
`[X.Y.Z]: https://github.com/Meenic/mnemocyte/…` link: the release
text reads the heading, and the next release's text finds this
version's tag through the link for its compare link. Write an entry
as a lead-in sentence, then the details:

```markdown
- **The CLI reads `.env.local`, then `.env`.** That is the order Next.js
  uses, so a Next.js app no longer needs `--env-file .env.local`.
```
