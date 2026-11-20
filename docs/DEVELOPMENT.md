# Development

What is built today and how to work on it. The target design lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); when one of its items lands, its section
moves here or into [features/](./features/).

User-facing documentation is `README.md` plus [guide/](./guide/): getting
started, the API reference, the CLI, Postgres setup, embedders, the AI SDK,
limitations and upgrading. A change users can see
updates the matching guide page in the same PR.

Feature areas:

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

Mnemocyte is a library with a small CLI; there is no app to run. Try changes
through the tests or from a consuming project. After `pnpm build`,
`node dist/cli.mjs sql --dimensions 768` runs the bin without a database;
`migrate` and `check` read `.env` in the current folder, so run them from
a scratch project, never from this repository's root.

## Structure

```txt
src/
  index.ts              root entry: createMemory, migrate, setTextSearchConfig, errors, public types
  client.ts             createMemory: config checks, store (resolveStore | in-memory), overloads for namespace
  migrate.ts            migrate() and setTextSearchConfig(): validate input, resolve { memory } or { store } (resolveStore), call the store
  postgres.ts           `mnemocyte/postgres` entry: postgresStore, client types
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
    store.ts            the internal MemoryStore contract, scopes and selectors
    in-memory.ts        in-memory MemoryStore
    postgres.ts         Postgres MemoryStore (runs on a SqlExecutor)
    store-input.ts      resolveStore: a store config, or a client detected by shape → lazy store
    store-config.ts     the opaque store config envelope from postgresStore()
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
  retrieval/scorer.ts   cosine, lexical overlap, rank fusion, boosts
  context/              context(): formatters, token budget
  embedders/            openai, openai-compatible, voyage, cohere, google (fetch only); each file is an export
    internal/           http-embedder.ts (createFetchEmbedder, the fetch core of every HTTP embedder; createHttpEmbedder, OpenAI-shaped; option checks) and provider-error.ts (createProviderError, error body and Retry-After parsing)
migrations/             numbered SQL migrations, fresh-install.sql, the schema template
scripts/                bundle-migrations.mjs, check-package.mjs
examples/               runnable scripts that import `mnemocyte` by name; not shipped
test/                   unit, package, integration, fixtures, benchmarks
```

`dist/` is built by tsdown from the entries in `tsdown.config.ts`:
`src/index.ts`, `src/ai-sdk.ts`, `src/cli.ts`, `src/postgres.ts` and
`src/embedders/*.ts`. `dist/cli.mjs` is the
`mnemocyte` bin (`bin` in `package.json`), not an export. The package has no runtime dependencies. `postgres`,
`pg`, `@electric-sql/pglite` and `drizzle-orm` are optional peer dependencies
at the versions the tests run; source files import at most their types
(`postgres` and `drizzle-orm` only), so no built entry imports a driver (a
package test checks this). They are also dev dependencies, with `@types/pg`
and `@electric-sql/pglite-pgvector`. `ai` is an optional peer too
(`^7.0.135`) and a dev dependency (it brings `zod`, its peer, into the
lockfile); `src/ai-sdk.ts` and the files in `src/ai-sdk/` import it at
runtime, the only source files that do, and a package test follows
the static imports of every other entry to check that none reaches it.

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
resolve `mnemocyte` to `dist/` (see `pnpm test:examples` under Testing).
 The `.mjs` files ship with source maps that embed
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
  unknown rows from `insertMemories` (matching by id, or by key for keyed
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

Vitest has three projects (`vitest.config.ts`):

| Project | Files | Imports | Command |
|---|---|---|---|
| `unit` | `test/**/*.test.ts` except integration, contract, package, benchmarks | `src/` through aliases | `pnpm test:unit` |
| `contract` | `test/contract/**/*.test.ts` | `src/` through aliases | `pnpm test:contract` |
| `package` | `test/package/*.test.ts` | built `dist/` through self-reference | `pnpm test:exports` |
| `integration` | `test/integration/**/*.test.ts` | `src/` through aliases | `pnpm test:integration` |

- `unit` and `integration` map `mnemocyte` to `src/` with `resolve.alias`,
  and `tsconfig.json` does the same with `paths`. The `package` project
  and `test/package/tsconfig.json` have neither: `mnemocyte` resolves to
  `dist/` through the package's own `exports` (package self-reference), the
  way a consumer resolves it.

- `pnpm test` builds, runs `pnpm test:types`, `pnpm test:readme`,
  `pnpm test:jsdoc` and `pnpm test:examples`, then runs `unit`, `contract`
  and `package`. This is what CI runs on every push. `pnpm test:exports`
  does the same for `package` alone, without `test:readme`, `test:jsdoc`
  and `test:examples`.
- `pnpm test:types` runs `tsc --noEmit -p test/package/tsconfig.json`, which
  type-checks every public export in `test/package/exports-types.test-d.ts`
  against the built `dist/*.d.mts`, so it needs a build first. The file has
  no `test()` blocks, and Vitest's `--typecheck` drops type errors outside
  test blocks, so plain `tsc` checks it instead. The `@ts-expect-error`
  negative cases fail with TS2578 if they stop being errors.
- `pnpm test:readme` (`scripts/check-readme.mjs`) type-checks the
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
- `pnpm test:examples` runs `tsc --noEmit -p examples/tsconfig.json`, which
  type-checks the scripts in `examples/` against the built `dist/`, so it
  needs a build first. The examples import `mnemocyte` by name and resolve
  it through self-reference, and the tsconfig is the one the
  getting-started guide recommends for running `.ts` files with Node.
  Types only: nothing runs, since every example needs an API key and some
  need a database. `examples/` is not in `files`, so it does not ship.
- The `package` project's global setup (`test/package/pack.global-setup.ts`)
  packs the tarball once and extracts it with the system `tar` using
  relative paths, so GNU tar, bsdtar and Windows' `tar.exe` all work.
  Each test that needs it copies the package into a temporary consumer of
  its own (`createPackedConsumer` in `packed-consumer.ts`) with
  `drizzle-orm`, `postgres`, `pg`, PGlite and `ai` absent. In
  `lazy-postgres.test.ts` the consumer runs an in-memory
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
  The manifest export (`mnemocyte/package.json`) is read from the
  tarball with `require()` and a JSON import, and from `dist/` through
  self-reference in `exports.test.ts`.
- `require-esm.test.ts` requires every key of the packed `exports` from a
  `.cjs` file (require(esm)) and checks each against `import()` of the
  same entry, with nothing on stderr. Without `ai`, `mnemocyte/ai-sdk`
  must fail with `ERR_MODULE_NOT_FOUND`; with `ai` linked it must load. It
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
- Shared behavior is written once as a fixture in `test/fixtures/` and run
  against the in-memory backend in `unit` and against Postgres in
  `integration`.
- The Postgres contract (`test/contract/suite.ts`,
  `describeStoreContract`) runs the same checks through every driver:
  migrate, transactions and savepoints, value round trips, chunked
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
  pgvector 0.8.7, so no service is needed and every Node job in CI runs it
  (about 20 s). Opening a PGlite takes several seconds under load, so the
  project raises both `testTimeout` and `hookTimeout` to 60 s; the files
  open it in `beforeAll` or `beforeEach`, and at Vitest's 10 s hook default
  the first hook failed on busy Windows machines. Those runs go through
  `postgresStore`; another passes the
  PGlite instance itself as `store` (`directClient`), which covers
  detection and the lazily imported backend end to end. One more
  PGlite run wraps the executor and fails on any parameter that is not a
  string, finite number or null, the values postgres.js 3.x and 4.x write
  the same. A last PGlite run (`schemaName`) keeps the tables in a schema
  that is not on `search_path`, so a query that names a table bare fails.
  `test/integration/drivers.test.ts` runs it on real Postgres through
  postgres.js, a node-postgres `Pool`, and Drizzle over each, and once on
  postgres.js with the tables in a schema, installed from the rendered
  template and adopted, because `public` already holds the other files'
  installation (see features/postgres.md, "Schema name"). Each run
  migrates (adopting an existing schema), works in its own namespaces,
  deletes them afterwards, and uses the integration files' embedding model
  name so it can share their database.
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
  schemas. Files run serially with a 60 s timeout. When `DATABASE_URL` is unset the tests load `.env`, so set it
  explicitly. A throwaway container, as CI uses (create the extension once
  the server is up, then remove the container when done):

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
   `pnpm version patch --no-git-tag-version` (or `minor`), which changes only
   `package.json`, then move the `CHANGELOG.md` `[Unreleased]` entries under
   the new version. Bump first: pnpm 12 stops with
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
