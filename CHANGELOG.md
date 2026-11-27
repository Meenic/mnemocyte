# Changelog

All notable changes to `mnemocyte` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from
1.0; before it, minor versions (`0.x.0`) could contain breaking changes,
marked **Breaking** in their entries. What semver covers is in
[docs/guide/api.md](docs/guide/api.md#stability).

`@mnemocyte/mcp`, the MCP server, is released on its own; its changes are
in [packages/mcp/CHANGELOG.md](packages/mcp/CHANGELOG.md).

## [Unreleased]

The fifth minor release, for apps on OpenRouter: `openrouterEmbedder`
embeds through it with one key, `aiSdkEmbedder` knows its models,
`init --embedder openrouter` writes the memory file, and HTTP 529 is
retried. The AI SDK's `forgetMemory` now returns the content it deleted,
as `@mnemocyte/mcp` 0.3.0 does. Postgres has no migration, so 1.4 and
1.5 clients work with the same installation in either deploy order.

### Added

- **`openrouterEmbedder` embeds through OpenRouter.** It is in
  `mnemocyte/embedders`, reads `OPENROUTER_API_KEY`, knows the vector
  sizes of the common models, pins hosts with `routing` (OpenRouter's
  `provider` object), credits your app with `app: { url, name }`, and
  reports the model without its vendor (`text-embedding-3-small`), so an
  installation can move to and from `openaiEmbedder`. Perplexity v2,
  Cohere and Voyage models get `input_type` and `google/gemini-embedding-2`
  the Gemini text prefixes by default. A failure OpenRouter reports in
  the body of a 200 is a `ProviderError` with the failure's status, and
  is retried like one
  ([embedders](docs/guide/embedders.md#openrouterembedder)).
- **`aiSdkEmbedder` knows OpenRouter models.** Models from
  `@openrouter/ai-sdk-provider` no longer need `dimensions` when
  `openrouterEmbedder` knows their size, and Perplexity's v2 models get
  `input_type`. Their `model` keeps the vendor, as before
  ([embedders](docs/guide/embedders.md#aisdkembedder)).
- **`mnemocyte init --embedder openrouter`.** Writes `memory.ts` with
  `openrouterEmbedder({ model: "openai/text-embedding-3-small" })` and adds
  `OPENROUTER_API_KEY=` to `.env.local` or `.env`, as the default does
  with `OPENAI_API_KEY=` ([CLI](docs/guide/cli.md#openrouter)).

### Changed

- **`forgetMemory` returns the content it deleted.** The AI SDK tool now
  returns `{ forgotten: true, content }`, so the model can see when it
  passed the wrong id, and its description asks it to check. An id with
  no visible memory still deletes nothing and returns
  `{ forgotten: false, message }`, where the message tells the model to
  search for the id. The description also tells the model never to guess
  an id, which models did from `withMemory`'s context, where memories
  have no ids. `ForgetMemoryOutput` is now
  `{ forgotten: true; content: string } | { forgotten: false; message: string }`,
  a type instead of an interface: code that builds one itself, such as a
  test fake, needs the `content` or the `message`, and an interface can no
  longer extend it ([AI SDK](docs/guide/ai-sdk.md#forgetmemory)).
- **HTTP 529 is retried like 503.** The built-in retry rule now also
  retries 529, which OpenRouter returns when a provider is overloaded,
  with the same backoff and `Retry-After` handling, for every embedder. A
  custom `provider.shouldRetry` replaces the built-in rule, so add 529 to
  it if you list statuses yourself
  ([embedders](docs/guide/embedders.md#timeouts-and-retries)).

## [1.4.0] - 2026-11-24

The fourth minor release, for Next.js apps on Neon: `store` takes Neon's
HTTP driver, `mnemocyte migrate` and `text-search` open a connection of
their own for it, the CLI reads `.env.local` and loads memory files that
import `server-only`, and `init` writes a memory file that imports the
app's Drizzle client. `@mnemocyte/mcp` 0.2.0 reads env files and memory
files the same way. Postgres has no migration, so 1.3 and 1.4 clients
work with the same installation in either deploy order; see
[upgrading](docs/guide/upgrading.md#13--14).

### Added

- **Neon's serverless driver.** `createMemory({ store })` and
  `postgresStore({ client })` take the `neon()` function from
  `@neondatabase/serverless` 1.x, and a Drizzle instance over it
  (`drizzle-orm/neon-http`), with no `SqlExecutor` to write. Each
  statement is one HTTP request, and statements that must commit together
  go out as one `sql.transaction([...])`. `@neondatabase/serverless`
  (`>=1.0`) is an optional peer, and `NeonHttpClient` is exported from
  `mnemocyte/postgres`. HTTP has no interactive transactions, so
  `migrate()` and `setTextSearchConfig()` still throw `"CONFIG"` on such
  a store; run them over Neon's `Pool`, which now has an integration test
  of its own ([postgres.md](docs/guide/postgres.md#neon)). An aborted
  `signal` rejects with `"ABORTED"` at once, but the statement may still
  finish on the server.
- **`mnemocyte migrate` and `text-search` on Neon's HTTP driver.** With a
  memory file whose store is `neon()`, a Drizzle `neon-http` `db` or
  another `batch`-only `SqlExecutor`, they open a connection of their own
  instead of failing: Neon's `Pool` on `DATABASE_URL_UNPOOLED`, falling
  back to `DATABASE_URL`, or the `postgres` package on `DATABASE_URL` for
  other stores. The embedding size and schema name come from the memory
  file. The command names the variable it used, never the URL, and stops
  with nothing changed (exit 2) when that connection sees a different
  installation than the app's client; it exits 1 when the app's client
  does not see the change afterwards. `migrate --dry-run --json` and
  `text-search --dry-run --json` gained `connection`: the variable the
  command connected with, or `null` when the memory file's own client ran
  it
  ([cli.md](docs/guide/cli.md#stores-that-cannot-migrate)).
- **Memory files that import `server-only` load in the CLI.** Next.js apps
  guard server code with `import "server-only"`, and the package throws
  when Node loads it outside React Server Components, so the CLI could
  not load such a file. The import now loads as an empty module, whether
  or not the package is installed, for `import` and `require()` alike.
  Every other package resolves as before, `client-only` included
  ([cli.md](docs/guide/cli.md#typescript-files)).
- **`mnemocyte init` imports your app's Drizzle client.** When a file
  where apps keep it (`src/db/`, `src/lib/db.ts`, `src/server/db/` and the
  like) exports a `drizzle(...)` client over
  postgres.js, node-postgres, PGlite, Neon (HTTP or `Pool`) or libSQL, the
  memory file imports it instead of creating a second client. `--db
  <path>` names the file when `init` does not find it, or finds several,
  which now exits 2 with nothing written. A client over another driver is
  skipped, and `init` writes its own as before
  ([cli.md](docs/guide/cli.md#your-drizzle-client)).

### Changed

- **`mnemocyte init` writes the memory file where a Next.js app keeps
  its code.** In an app with `next` in `package.json`, that is
  `src/lib/memory.ts`, or `lib/memory.ts` when the app keeps `app/` or
  `pages/` in the root or has no `src/`, and the file starts with
  `import "server-only"`. Other apps still get `memory.ts` in the root.
  When the app has a `next.config.js`, the `"type": "module"` note says to
  rename it first ([cli.md](docs/guide/cli.md#nextjs)).
- **The CLI reads `.env.local`, then `.env`.** That is the order Next.js
  uses, so a Next.js app no longer needs `--env-file .env.local`. A value
  in `.env.local` wins over `.env`, and a variable that is already set
  still wins over both. `.env.local` is skipped when `NODE_ENV` is `test`,
  as in Next.js. The `.env.$(NODE_ENV)` files are not read, and
  `--env-file` still replaces both files
  ([cli.md](docs/guide/cli.md#environment-variables)).
- **`mnemocyte init` writes the key to `.env.local` when the project has
  that file.** Otherwise it writes to `.env` as before. A key either file
  defines is left as is, and the `.gitignore` note checks the file `init`
  wrote to ([cli.md](docs/guide/cli.md#init)).
- **A clearer error for clients without transactions.** The `"CONFIG"`
  error that `migrate()` and `setTextSearchConfig()` throw for a client
  without interactive transactions names Neon's HTTP driver and how to run
  them instead: over a `Pool`, or with `mnemocyte migrate` and
  `mnemocyte text-search`.

## [1.3.0] - 2026-11-21

The third minor release: memories can live in libSQL and Turso, and other
packages can add storage backends through a public store contract and the
test suite the built-in backends pass. Postgres has no migration, so 1.2
and 1.3 clients work with the same installation in either deploy order;
see [upgrading](docs/guide/upgrading.md#12--13).

### Added

- **libSQL and Turso.** Memories can live in a libSQL database: a local
  file, Turso Cloud or a libSQL server. Pass an `@libsql/client` client,
  or a Drizzle instance over one, as `store`, or use `libsqlStore({ client })`
  from the new `mnemocyte/libsql` entry. `@libsql/client` 0.18
  (`^0.18.0`) is an optional peer. `migrate()` installs the schema, and
  `mnemocyte migrate`, `check` and `text-search` work through your memory
  file; see [docs/guide/libsql.md](docs/guide/libsql.md).
  - Vector search is an exact scan of the scope, with filters applied
    first, so it never returns fewer results than exist. Its time grows
    with the scope: at 10,000 memories of 1,536 dimensions on a local
    file, a search took about 0.5 s, or 0.7 s when keyword search also
    matched every memory.
  - Keyword search uses FTS5 and `bm25`, with English stemming by default
    (`textSearchConfig: "porter"`) or `"unicode61"`. Any word of the query
    matches, and query syntax is matched as words.
  - Embeddings up to 65,536 dimensions. The CLI's `--dimensions` flag
    still stops at 4,000; for a larger embedder, let the memory file set
    it.
  - Limits are in [limitations](docs/guide/limitations.md#libsql).
- **Custom stores.** The store contract is public as `MemoryStoreV1`, in
  the new `mnemocyte/store` entry, so a package can add a storage backend.
  Wrap it with `defineMemoryStore({ store })` and pass the result as
  `store`. Twelve methods are required; `migrate` and
  `ensureEmbeddingCompatibility` are optional. `mnemocyte check` and
  `setTextSearchConfig()` have nothing to report or change for a custom
  store. See [docs/guide/custom-stores.md](docs/guide/custom-stores.md).
- **The contract suite.** `describeMemoryStoreContract` from the new
  `mnemocyte/store/test` entry runs the tests every built-in backend passes
  against your store, under Vitest. `vitest` 5 is a new optional peer,
  needed only for this entry.
- **New backend values.** `MnemocyteBackend` has new members, `"libsql"`
  and `"custom"` (a store from `defineMemoryStore`).

### Changed

- **`findDuplicates` on the in-memory store does less work.** It compares
  each pair once instead of twice, from vectors prepared once, and keeps
  each memory's nearest neighbors without sorting every other memory;
  results are unchanged.
- **A store from another installed copy fails early.** When an app has two
  copies of `mnemocyte` installed and passes a store from an older copy
  to `createMemory`, it now throws `"CONFIG"` with reason
  `"INVALID_OPTION"` at once. The internal store methods were renamed, so
  such a store would otherwise fail on its first call. Install one version
  (`npm ls mnemocyte` lists them). `migrate()` and the CLI still accept
  such a store.

## [1.2.1] - 2026-11-20

A patch release: `context` marks only the memories it puts in the text,
the CLI keeps keyword search settings that drizzle-kit manages, and the
1.2 note on mixed 1.1 and 1.2 deploys is corrected. No API change and no
migration.

### Fixed

- **`context` counted memories it left out.** With `trackAccess` on,
  `context` and `experimental.contextWithMemories` marked every search
  result as accessed, including the ones `maxTokens` left out of the
  text. They now mark only the memories in the text, on both backends;
  `search` still marks every result. Memories that keep getting cut by the
  budget no longer gain `accessCount` or `lastAccessedAt`, so
  `prune({ notAccessedSince })` treats them as unused.
- **`text-search` on a drizzle-kit installation said nothing.** It changed
  `content_tsv` and left drizzle-kit's schema file behind, so the next
  `drizzle-kit generate` rewrote the column again. When the migrations are
  not recorded, it now adds a note to the dry run, the question and the
  result that points to `generate --adapter drizzle --text-search-config`.
  The Postgres guide's `psql` recipes also say to put your `schemaName`
  in front of the table name.
- **`generate --adapter drizzle` kept the wrong language.** Run again
  without `--text-search-config`, it wrote `english` over a file made for
  another configuration, and `drizzle-kit generate` then dropped and
  re-added `content_tsv`, rewriting the table. It now keeps the
  configuration of the existing file and changes it only when you pass the
  flag. If the file's `content_tsv` line was edited by hand, it exits 2
  unless you pass the flag.
- **Mixed 1.1 and 1.2 deploys.** The 1.2 notes said 1.1 and 1.2 clients
  work on the same installation in either deploy order. That holds only
  while the installation keeps `english` keyword search and its tables on
  `search_path`. A 1.1 client searches with `english` whatever the
  installation uses, so on a `simple` installation its keyword matches
  are lost without an error, and it ignores `schemaName`. Update every
  process to 1.2 before you pick another keyword search language or a
  `schemaName`; [upgrading](docs/guide/upgrading.md#11--12) now says so.
  `mnemocyte text-search` says it too when it asks, in `--dry-run` and
  after the change, unless the new configuration is `english`.

### Documentation

- **Examples in the editor.** Every `MemoryClient` method and
  `openaiEmbedder` now has an example in its doc comment, so hovering a
  call shows how to use it. The `MemoryClient` comment lists the error
  codes any method can throw, and each method's own `@throws` names the
  codes and reasons particular to it, such as `"KEY_IN_USE"` on `update`
  and `"HAS_DEPENDENTS"` on `delete`, `deleteScope` and `prune`. The
  options of the AI SDK helpers and the HTTP embedders have a comment of
  their own.

## [1.2.0] - 2026-11-16

The second minor release: pick the language of keyword search, keep the
tables in their own schema, and let drizzle-kit manage them. There is no
migration, so 1.1 and 1.2 clients work with the same installation in either
deploy order; see [upgrading](docs/guide/upgrading.md#11--12).

### Added

- **Pick the keyword search language.** On Postgres, keyword search used
  English stemming and stop words for every installation. Pick another
  Postgres text search configuration when you install:
  `mnemocyte migrate --text-search-config simple`, or
  `migrate({ memory, textSearchConfig: "simple" })`. `simple` does no
  stemming and suits memories in several languages; `german`, `french`,
  `turkish` and the other configurations your database lists work too.
  `english` stays the default. `mnemocyte sql` takes the same flag, and
  `mnemocyte check` shows the configuration (`textSearchConfig` in
  `--json`) and, with `--text-search-config`, fails when it differs
  (`TEXT_SEARCH_CONFIG_MISMATCH`). No migration: the configuration is
  read from the existing keyword column, so nothing changes for current
  installations.
- **`setTextSearchConfig` and `mnemocyte text-search <name>`.** Change the
  configuration of an existing installation. It rewrites the memories
  table and rebuilds its indexes, HNSW included, while reads and writes of
  memories wait, so the command asks first (`--yes` skips the question,
  `--dry-run` changes nothing). App processes that are already running
  keep the old configuration until they restart. See
  [keyword search language](docs/guide/postgres.md#keyword-search-language).
- **`TEXT_SEARCH_CONFIG_MISMATCH`.** A `"CONFIG"` reason for a `migrate`
  whose `textSearchConfig` differs from the installation's.
- **Keep the tables in their own schema.**
  `postgresStore({ client, schemaName: "memory" })` puts every Mnemocyte
  table, `mnemocyte_migrations` included, in that schema instead of
  wherever `search_path` points, and every query names it. `migrate`
  creates the schema on a fresh install when it is missing and reports
  `schemaCreated`. Without a memory file, `migrate`, `check`, `sql` and
  `text-search` take `--schema <name>`; `check` shows the schema
  (`installation.schema` in `--json`). `migrate` does not move an existing
  installation: it stops with the new `"CONFIG"` reason
  `INSTALLATION_ELSEWHERE`, and the guide shows the `ALTER TABLE … SET
  SCHEMA` to run. Without `schemaName` nothing changes. See
  [keep the tables in their own schema](docs/guide/postgres.md#keep-the-tables-in-their-own-schema).
- **Let drizzle-kit manage the tables.**
  `mnemocyte generate --adapter drizzle` writes Mnemocyte's tables as a
  Drizzle schema file (`mnemocyte-schema.ts`, or `--out`) for your
  embedding size, keyword search language and schema. Add it to
  `drizzle.config.ts` and drizzle-kit creates and upgrades the tables with
  the rest of your schema. drizzle-kit cannot write three parts of it (the
  pgvector extension, the unique key index and the installation row), so
  the command prints them as SQL for two custom migrations. Run
  `generate` again after an upgrade; it only replaces a file it wrote.
  Don't use `drizzle-kit push` or `mnemocyte migrate` on these tables. It
  needs no database, and nothing changes for apps that use `migrate`. See
  [manage the tables with drizzle-kit](docs/guide/postgres.md#manage-the-tables-with-drizzle-kit).

### Changed

- **`mnemocyte check` names drizzle-kit's upgrade path.** On a schema
  installed without `migrate`, it now says that drizzle-kit installations
  keep upgrading through `mnemocyte generate --adapter drizzle`, instead
  of only suggesting `mnemocyte migrate`.

## [1.1.0] - 2026-11-16

The first minor release after 1.0: more control over embedder requests,
created-date filters on `list` and `context`, `delete` results, a context
call that returns its memories, scope on observability events, `--json` on
the CLI and a per-memory audit history. One migration,
`0004_audit_memory_id.sql`, which 1.0 and 1.1 clients both work with; see
[upgrading](docs/guide/upgrading.md#10--11).

### Added

- **`mnemocyte/package.json` is exported.** Tools can read the installed
  version with `require("mnemocyte/package.json")` or
  `import manifest from "mnemocyte/package.json" with { type: "json" }`;
  before, the `exports` map blocked it.
- **`isProviderError`.** A type guard next to `isMnemocyteError` that
  narrows a caught `unknown` to a `ProviderError`, with its `status` and
  `retryAfterMs`. Like `isMnemocyteError`, it works when the app ends up
  with two copies of the package, including a 1.0.x copy, where
  `instanceof ProviderError` fails. It replaces checking `code` and
  `status` by hand.
- **`signal` on `stats`.** `stats({ scope, signal })` and the bound
  `stats({ signal })` stop with `"ABORTED"` when the signal aborts. On
  Postgres with postgres.js the count query is cancelled while it runs;
  node-postgres and PGlite check the signal before sending it. The bound
  input is exported as `BoundStatsInput`. Bound `stats()` with no argument
  works as before.
- **`BoundPruneInput` and `AiSdkPurposeHints`.** Bound `prune` now names
  its input `BoundPruneInput`, like every other bound method, and the AI
  SDK embedder's `purposes` type is `AiSdkPurposeHints`, matching
  `PurposeHints` from `mnemocyte/embedders`. Both are the same types as
  before, so existing code compiles unchanged.
- **`headers` on `openaiEmbedder`, `voyageEmbedder`, `cohereEmbedder` and
  `googleEmbedder`.** Pass extra request headers for a proxy or AI gateway,
  such as `cf-aig-authorization` for Cloudflare AI Gateway, or a provider
  header such as `OpenAI-Project` or Cohere's `X-Client-Name`. It works as
  on `openaiCompatibleEmbedder`: names are sent in lower case, and the
  embedder's own API key header and `content-type` replace a copy in
  `headers`. When a gateway wants its key in `authorization`, pass it as
  `apiKey`.
- **`fetch` on every HTTP embedder.** `openaiEmbedder`,
  `openaiCompatibleEmbedder`, `voyageEmbedder`, `cohereEmbedder` and
  `googleEmbedder` take a `fetch` of the same type as the global one, as
  the AI SDK providers do. Every request goes through it, retries included,
  with the URL as a string and an `init` carrying the call's `signal`. Use
  it to test without a network, to log requests or to go through a proxy
  agent. A value that is not a function throws `"CONFIG"` when the embedder
  is created.
- **`experimental.contextWithMemories`.** Like `context`, but it also
  returns the memories behind the text, for citations and debugging:
  `{ context, memories, omitted }`. `context` is the same string `context`
  returns for that input, `memories` are the memories in it, in order, and
  `omitted` are the matches `maxTokens` left out. Each carries its
  `score` and `scores`, and `explain: true` adds the full breakdown. It
  works on the bound client too. It is experimental, so it may change in a
  minor release.
- **`createdBefore` / `createdAfter` on `list` and `context`.** The strict
  `createdAt` bounds `search` takes now work on `list` and `context`, and
  on the bound client: `memory.list({ scope, createdAfter: lastWeek })`.
  `context` applies them in its search, so `limit` and `maxTokens` are
  spent only on matching memories. An invalid date throws `"VALIDATION"`,
  and so do bare `before` / `after`, which name no field.
- **`agentId` and `sessionId` on observability events.** Events now carry
  the agent and session of the call's scope next to `namespace` and
  `entityId`, on the plain, default-namespace and bound clients, so a
  trace or metric can be split by agent or session. A scope without an
  agent or session leaves the field out. `prune`, `deleteScope`, `stats`,
  `listAuditLog` and `pruneAuditLog` report the agent and session their
  selector names; calls with `allNamespaces: true` report no scope.
- **`--json` for `mnemocyte check` and `mnemocyte migrate --dry-run`.**
  Both print one JSON object on one line, so CI can read the result:
  `migrate --dry-run --json | jq -e '.upToDate'` fails a step when a
  deploy would run a migration. `check` lists each problem and note with a
  `code` such as `MIGRATIONS_PENDING`. When a command cannot run, the error
  is printed as JSON too. Exit codes stay the same, and so does the text
  output without the flag. Field names and codes are covered by semver;
  the `message` text is not. `--json` on `migrate` needs `--dry-run`. See
  [JSON output](docs/guide/cli.md#json-output).
- **`mnemocyte init --embedder openai-compatible`.** Writes `memory.ts`
  with the local Ollama embedder from the getting-started guide
  (`nomic-embed-text`, 768 dimensions, at `http://localhost:11434/v1`)
  instead of `openaiEmbedder`, and leaves `.env` alone, since a local
  server needs no key. Before, `init` always wrote `openaiEmbedder` and
  `OPENAI_API_KEY=`. Without the flag nothing changes. See
  [A local Ollama](docs/guide/cli.md#a-local-ollama).
- **`listAuditLog({ memoryId })` and migration
  `0004_audit_memory_id.sql`.** Lists the events about one memory, at any
  scope, with `allNamespaces: true` or on a bound client, with the usual
  cursor and `before` / `after`. On Postgres the migration adds a
  `memory_id` column that Postgres fills from each event's
  `metadata.memoryId`, and an index on it, so the history is found without
  reading the log. Run `mnemocyte migrate`: the migration rewrites
  `mnemocyte_events` under an `ACCESS EXCLUSIVE` lock, so audit reads and
  audited writes wait for it. Writes are unchanged, so the app keeps
  working before and after it; only the new filter needs it. See
  [upgrading](docs/guide/upgrading.md#10--11).

### Changed

- **`delete` returns what it changed.** It used to resolve with nothing;
  now it resolves with a `DeleteResult`, on the bound client too:
  `deletedIds` lists the memory and, with `dependents: "delete"`, the
  memories deleted with it, and `restoredIds` lists the memories
  `dependents: "restore"` made active again.
  `const { restoredIds } = await memory.delete({ scope, id, dependents: "restore" })`
  tells you which memories show up in search again. Code that awaits
  `delete` keeps working. TypeScript now flags code that writes the old
  return type down: a `Promise<void>` annotation on the call or on a
  function returning it, or a hand-written `MemoryClient` fake whose
  `delete` returns nothing. Return a `DeleteResult` there, or
  `await` the call inside an `async` function.
- **Invalid `headers` throw `"CONFIG"` when the embedder is created.** A
  header name or value HTTP does not allow, such as a name with a space or
  a value with a line break, used to fail with a `TypeError` from `fetch`
  on the first `embed`. `openaiCompatibleEmbedder` and the four above now
  reject it up front; the error names the header, not its value.

### Deprecated

- **`PruneSelectors` and `AiSdkPurposeOptions`.** They stay as aliases of
  `BoundPruneInput` and `AiSdkPurposeHints` through 1.x and go in 2.0.
  Your editor marks them; switch to the new names when you touch the code.

### Fixed

- **A `ProviderError` from another copy of the package keeps its
  `status`.** When a custom embedder threw a `ProviderError` imported from
  a second installed copy, Mnemocyte wrapped it in a new `"EMBEDDING"`
  error, so `status` and `retryAfterMs` were only on its `cause`. It now
  reaches the caller as it is, like one from the same copy.

- **`ProviderError` accepts `retryAfterMs: undefined` under
  `exactOptionalPropertyTypes`.** A custom embedder can pass the wait it
  parsed from a response straight through, even when there was none:
  `new ProviderError({ message, status, retryAfterMs })` with a
  `number | undefined`. `undefined` means the same as leaving it out, and
  the retry falls back to the usual backoff. `EmbedOptions.signal` stays
  `?: AbortSignal`, because Mnemocyte passes it into your embedder, and
  widening it would stop embedders that declare their options as
  `{ signal?: AbortSignal }` from compiling.

- **`createdAfter` agrees with the returned `createdAt` on Postgres.**
  Postgres stores `created_at` in microseconds, and the `createdAt` you get
  back stops at the millisecond. Rows with microseconds (written by 0.x, by
  the column default or by hand) could match
  `createdAfter: memory.createdAt` on Postgres but not in memory, so
  `search`, `list` and `context` could return the memory you passed as the
  bound. Both backends now compare at the millisecond `createdAt` shows.
  `createdBefore`, `prune` and `notAccessedSince` already agreed.

## [1.0.1] - 2026-11-15

A patch release: the hints that tell you how to run `migrate` now work in
pnpm projects. No API change.

### Fixed

- **The `migrate` hints no longer name `npx`.** In a project that `pnpm
  init` created, `package.json` names pnpm in `devEngines` and npm's `npx`
  stops with `EBADDEVENGINES`. `mnemocyte init` now ends with the runner
  your project uses (`pnpm exec mnemocyte migrate`, `yarn mnemocyte
  migrate`, `bunx mnemocyte migrate` or `npx mnemocyte migrate`), taken
  from `devEngines.packageManager` or `packageManager`, else the lockfile.
  The `"MIGRATION"` / `SCHEMA_MISSING` message says `Run mnemocyte migrate`
  without a runner. The error code and reason are unchanged.

## [1.0.0] - 2026-11-15

The first stable release. The code is the one 1.0.0-rc.2 shipped; this
release adds the rewritten README and guides. From here the API documented
in `docs/guide/` follows semantic versioning, and a breaking change waits
for 2.0.

### Documentation

- **README and guides rewritten for a first-time user.** The README has a
  new tagline, a one-screen quickstart, Postgres setup in a few commands
  and one documentation list. `guide/api.md` opens with a method index and
  a `createMemory` options table, lists the input rules in their own
  section and documents `migrate` after the client methods. Each topic has
  one home: `migrate` and pgvector in `guide/postgres.md` and
  `guide/cli.md`, scopes in `guide/api.md`, drivers in
  `guide/postgres.md`. The 0.x notes moved to `guide/upgrading.md`, and
  `guide/getting-started.md` says why a script ends its database client.
  Every guide file name and every linked anchor still works.
- **The guides run the command with `pnpm exec mnemocyte`.** In a project
  that `pnpm init` created, `package.json` names pnpm in `devEngines`, and
  npm's `npx` refuses to run there with `EBADDEVENGINES`. `guide/cli.md`
  lists the command for pnpm, npm and Yarn.

## [1.0.0-rc.2] - 2026-11-15

The second release candidate for 1.0. It installs with `mnemocyte@next`. It
fixes what the rc.1 review and a real-app run against Ollama and Postgres
found: input validation, error codes, extraction and the middleware's error
handling. The API is otherwise the one rc.1 documented; the two **Breaking**
changes below are small corrections to error behavior, and 1.0 freezes the
API as it stands here.

### Changed

- **Breaking: `consolidate` into a survivor that is already superseded
  throws `"CONFLICT"`** with reason `"CONSOLIDATION_CHANGED"`, the error a
  race that supersedes it already gave, instead of `"VALIDATION"`.
- **Breaking: `extractMemories` throws `"ABORTED"` when its `signal`
  aborts during the model call**, with the AI SDK's error as `cause`,
  instead of rethrowing that error.
- **Extraction skips items that add nothing**: a memory the model was shown
  returned unchanged (no re-embed, `updatedAt` stays), the content of a
  shown memory under another key (a fact `saveMemory` stored this turn),
  and content that is only the key. A changed kind or importance under the
  same key still updates. Its prompt also says a key names the topic, not
  the value.
- **`mnemocyte init` no longer writes a `closeDatabase()` helper.** The
  `memory.ts` it writes exports the database client (`sql`, `pool`, `db` or
  `client`) next to `memory`, and a script ends it the driver's way, as the
  getting-started guide now shows. A file written by an earlier `init`
  keeps working.
- **The middleware keeps a failed `context()` for that query**: it reaches
  `onError` once, and the AI SDK's retries and later tool steps run without
  memory instead of calling the embedder again. A new query tries again;
  an abort is never kept.

### Fixed

- **A `null` or missing input throws `"VALIDATION"`** on every method of
  the unbound client; `add`, `addMany`, `search`, `get`, `list`, `update`,
  `delete`, `context`, `findDuplicates` and `consolidate` threw a
  `TypeError`.
- **Search measures recency from one clock reading per search**, so two
  memories created in the same millisecond with equal scores follow the
  documented tie-break (newer, then lower id) instead of swapping places
  when a search crosses a millisecond boundary.
- **CLI text:** `check --dimensions` without a memory file names the flag
  instead of an embedder it never loaded, and `migrate` without a terminal
  no longer capitalises "have" after "or".

### Documentation

- A local-model setup for extraction (`createOpenAICompatible` with
  `supportsStructuredOutputs: true`) in `guide/ai-sdk.md` and the Ollama
  section of `guide/getting-started.md`; `timeoutMs` covers the search, the
  model call and the write, and should be raised for local models.
- `MemoryMiddlewareError.phase` is one of the unions a minor may extend.
- A keyed upsert keeps `createdAt`, which recency uses.
- `guide/ai-sdk.md` imports `./memory.ts`, which `nodenext` and Node need.

## [1.0.0-rc.1] - 2026-11-15

The first release candidate for 1.0. It installs with `mnemocyte@next`; the
API it documents is the one 1.0 freezes, and it changes only if testing
finds a problem.

### Added

- **`MnemocyteError.reason`** says which case of `"CONFIG"`, `"CONFLICT"`
  or `"MIGRATION"` an error is, for example `"KEY_IN_USE"`,
  `"DIMENSIONS_MISMATCH"` or `"SCHEMA_MISSING"`, so callers never match on
  messages. It is `undefined` on the other codes. The reasons are listed in
  `docs/guide/api.md` "Errors", along with the unions a minor release may
  extend (error codes and reasons, observability operations, backends,
  audit event types).

### Changed

- **Breaking: `new MnemocyteError` takes one object.** Custom embedders and
  stores that throw it pass `{ message, code, reason, cause }`;
  `"CONFIG"`, `"CONFLICT"` and `"MIGRATION"` require a `reason`. The
  positional form throws a `TypeError`.

  ```ts
  // 0.8
  throw new MnemocyteError("model is required", "CONFIG");
  // now
  throw new MnemocyteError({
    message: "model is required",
    code: "CONFIG",
    reason: "INVALID_OPTION",
  });
  ```
- **`isMnemocyteError` recognizes errors from another copy of the
  package.** It checks a `Symbol.for("mnemocyte.error")` brand instead of
  `instanceof`, which fails when an app and a library each install
  Mnemocyte.
- **The dimensions-mismatch `"CONFIG"` message names a fix that exists:**
  configure an embedder with the installation's dimensions, or install in
  a fresh database. It used to suggest a migration for a new dimension,
  which `migrate` does not do.
- **Breaking: unknown option keys throw `"CONFIG"`.** `createMemory`'s config
  and its nested objects (`retrieval`, `retrieval.fusion`, `defaults`,
  `provider` and the others), `postgresStore`, every embedder, and the AI SDK
  functions (`aiSdkEmbedder`, `memoryMiddleware`, `withMemory`,
  `memoryTools`, `extractMemories`, with `context` and `save`) reject a key
  they do not take, instead of ignoring it. A misspelled `baseURL` used to
  send texts and the API key to the provider's default endpoint. A key set
  to `undefined` still counts as absent.
- **Breaking: `baseUrl` is `baseURL`** in `openaiEmbedder`,
  `openaiCompatibleEmbedder`, `voyageEmbedder`, `cohereEmbedder` and
  `googleEmbedder`, the AI SDK's spelling. The old name throws an error that
  names the new one.

  ```ts
  // 0.8
  openaiEmbedder({ model, baseUrl: "https://proxy.example/v1" });
  // now
  openaiEmbedder({ model, baseURL: "https://proxy.example/v1" });
  ```
- **Breaking: the extraction `timeout` is `timeoutMs`**, in
  `extractMemories` and `memoryMiddleware({ save })`, like
  `provider.timeoutMs`.
- **Breaking: `search` filters `createdAt` with `createdBefore` /
  `createdAfter`**, the name `prune` already uses, instead of `before` /
  `after`. The old keys throw `"VALIDATION"` naming the new one, even set
  to `undefined`, so a search never silently drops its time filter.
  `listAuditLog` and `pruneAuditLog` keep `before` / `after`.

  ```ts
  // 0.8
  await memory.search({ scope, query, after: lastWeek });
  // now
  await memory.search({ scope, query, createdAfter: lastWeek });
  ```
- **Breaking: unknown keys on method inputs throw `"VALIDATION"`.** Every
  client method, on plain, default-namespace and bound clients, and
  `migrate` reject a key they do not take, even set to `undefined`, and so
  do `scope` (also in `for()`) and each memory of `addMany`, before
  anything is embedded or stored. A misspelled `kinds` used to widen a
  search, a misspelled scope `sessionId` made `deleteScope` erase every
  session, and `migrate({ dryrun: true })` ran for real. `metadata` and
  `tokenCounter` are not checked inside. A bound client's `stats()` rejects
  any key, since it takes none.
- **`kinds` and `tags` inputs take `readonly` arrays** in `add`, `update`,
  `search`, `list`, `context`, `prune` and `findDuplicates`, and in the
  `searchMemories` tool's input type. Plain arrays still work.
- **Breaking: `listAuditLog` pages like `list`.** It returns
  `{ events, nextCursor }` instead of an array, and takes the opaque
  `nextCursor` back as `cursor`. `beforeCursor`, `afterCursor` and the
  `AuditLogCursor` type are gone; `before` and `after` stay as strict time
  filters. The cursor keeps the microseconds Postgres stores, so events in
  the same millisecond are never skipped.

  ```ts
  // 0.8
  const events = await memory.listAuditLog({ scope, beforeCursor });
  // now
  const { events, nextCursor } = await memory.listAuditLog({ scope, cursor });
  ```
- **Breaking: `AuditEvent.type` replaces `description`.** It is typed as
  `AuditEventType`, the union of the five event names. The Postgres column
  keeps its name, so no migration is needed.
- **`listAuditLog` takes a selector.** `entityId` is optional, so
  `{ namespace }` lists every entity in a namespace, and
  `allNamespaces: true` lists every namespace, as in `pruneAuditLog`. On
  Postgres these pages sort the selected events; a page of one entity still
  reads an index. Bound clients list within their scope and reject
  `allNamespaces`.

### Removed

- **Breaking: `postgresJs()` and the `PostgresJsExecutor` type.** Pass the
  postgres.js client itself; Mnemocyte recognises it.

  ```ts
  // 0.8
  const store = postgresStore({ client: postgresJs(sql) });
  // now
  const store = postgresStore({ client: sql }); // or createMemory({ store: sql, embedder })
  ```

- **Breaking: `drizzleStore()` and the `mnemocyte/stores/drizzle` subpath.**
  Pass the Drizzle instance as `store: db` or `postgresStore({ client: db })`.
  An instance annotated as drizzle-orm's `PostgresJsDatabase`, which does
  not declare `$client`, passes `db.$client` or lets `drizzle()` infer its
  type.

  ```ts
  // 0.8
  import { drizzleStore } from "mnemocyte/stores/drizzle";
  const memory = createMemory({ store: drizzleStore(db), embedder });
  // now
  const memory = createMemory({ store: db, embedder });
  ```

- **Breaking: `experimental.consolidate`**, deprecated in 0.8, on unbound
  and bound clients. Call `consolidate` with the same input.
- **Breaking: `migrations/render-initial.mjs`, `migrations/meta/_journal.json`
  and `migrations/0000_initial.sql.template` are no longer in the package.**
  `mnemocyte sql --dimensions <n>` prints the rendered schema. The numbered
  SQL files and `fresh-install.sql` still ship. The empty `dist/cli.d.mts`
  is gone too.

### Fixed

- **Optional fields accept an explicit `undefined` under
  `exactOptionalPropertyTypes`.** Method inputs, bound-client inputs, scopes,
  the `createMemory` and `migrate` config, embedder options and the AI SDK
  options are typed `?: T | undefined`, so a `string | undefined` cursor or
  an optional `signal` passes straight through. Before, the cursor loops in
  `docs/guide/api.md` failed with TS2379. `undefined` means the same as
  leaving the field out.

  ```ts
  let cursor: string | undefined;
  do {
    const page = await memory.list({ scope, cursor }); // compiles now
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  ```
- **A `retrieval.fusion` or `retrieval.boosts` weight set to `undefined`
  keeps its default.** It used to replace the default and throw
  `"CONFIG"`.

### Documentation

- **Upgrade guide.** [docs/guide/upgrading.md](docs/guide/upgrading.md)
  covers 0.5 to 1.0, one section per release; it replaces the 0.5 → 0.6
  table in the API reference.
- **What 1.0 promises.** The API reference's "Stability" section lists what
  semantic versioning covers and what it leaves out: `experimental.*` and
  the types that describe it, error and CLI text, the wording of
  `context()` output and of the text the AI SDK tools, middleware and
  extraction give the model, and score values. Types derived from the `ai`
  peer's types follow the installed `ai` version.
- **Limitations.** New entries for English-only keyword search on Postgres,
  switching embedding models, and updating from 0.7; the approximate
  search figures are those of the current `relaxed_order` query.

## [0.8.0] - 2026-11-14

### Added

- **The `mnemocyte` command.** `npx mnemocyte migrate` creates or upgrades
  the schema using the client your app exports as `memory` from
  `memory.ts` (the root, `lib/`, `src/`, `src/lib/`, or `--config
  <path>`). It asks before enabling pgvector (`--yes` for CI) and has
  `--dry-run`. `npx mnemocyte check` reports the pgvector version, the
  applied migrations, the dimensions and the embedding model, and exits 1
  on anything that would make the app throw. `npx mnemocyte sql
  --dimensions <n>` prints the fresh-install schema without a database.
  TypeScript memory files load without a build step; `.env` in the current
  folder is read first. Without a memory file, `migrate` and `check`
  connect to `DATABASE_URL` with the `postgres` package. See the
  [CLI guide](docs/guide/cli.md).
- **`npx mnemocyte init`.** Writes a `memory.ts` for the driver in
  `package.json` (Drizzle over the driver next to it, else `postgres`,
  `pg` or PGlite; the in-memory backend without one), named after your
  package, and adds `OPENAI_API_KEY=` to `.env` when it is not defined
  there. It never overwrites a file, prints every change, and has
  `--dry-run`.
- **`consolidate` is stable.** `memory.consolidate` and
  `boundClient.consolidate` replace `experimental.consolidate`, with the
  same input, result and one-statement locking.
- **Survivor-aware `delete`.** `delete({ scope, id, dependents })` decides
  what happens to the memories consolidated into the one deleted:
  `"reject"` (the default, as before) throws `"CONFLICT"`, `"restore"`
  makes them active again, and `"delete"` deletes them too, including
  memories consolidated into those. A dependent that is not visible at the
  call's scope makes it throw `"CONFLICT"` and change nothing. The
  `DependentsPolicy` type is exported.
- **`neighbors` on `findDuplicates`.** How many nearest memories each
  memory is compared with (default 10, at most 100).
- **`experimental.findDuplicatesPage`.** `findDuplicates` in pages for
  large scopes: each call compares the next `batchSize` memories (default
  500, at most 1,000) with the whole scope and returns
  `{ pairs, nextCursor, compared }`. A run of pages returns each pair once;
  pairs are sorted within a page. Bound clients have it too. Exported types:
  `FindDuplicatesPageInput`, `BoundFindDuplicatesPageInput`,
  `DuplicatePage`.
- **`observability.onError`.** Receives `{ error, event }` when `onEvent`
  throws or rejects.
- **`pruneAuditLog`.** Deletes audit events older than `before` for a scope
  selector or `allNamespaces: true`, with `dryRun` to count first. On
  Postgres it deletes `batchSize` events per statement (default 1,000), so
  a large backlog never runs as one long transaction; an abort keeps the
  batches already deleted. Bound clients have it too. The API guide has
  retention guidance for a scheduled job.

### Changed

- **The missing-schema error names the command.** The `"MIGRATION"` error
  for a missing table or column now says to run `npx mnemocyte migrate`
  instead of `migrate({ memory })`.
- **Observability hooks are not awaited.** A slow or failing `onEvent` no
  longer delays or fails a call. Events are still delivered in order, and
  errors from the hook go to `onError` (dropped when unset). A synchronous
  hook still blocks while it runs.
- **`findDuplicates` uses nearest neighbors.** Each memory is compared
  with its `neighbors` nearest instead of every other memory. On Postgres a
  large scope uses the HNSW index once per memory (7.4 s instead of 32.8 s
  for 2,000 memories on PGlite), which is approximate, so a pair can be
  missed. Pairs now always have the smaller id as `a` and tie-break by id.
- **`prune` deletes a survivor with its dependents.** A prune that selects
  a consolidation survivor and every memory consolidated into it deletes
  them all, as `deleteScope` does; before, it threw `"CONFLICT"`. A
  dependent left outside the selection still makes it throw.
- **`forgetMemory` forgets merged duplicates.** The AI SDK tool deletes
  with `dependents: "delete"`, so the model can forget a memory that
  duplicates were consolidated into instead of getting `"CONFLICT"`.
- **Audit events are written with their change.** With audit enabled,
  `add`, `addMany`, `update`, `delete` and `prune` write their events in
  the same statement as the change, as `consolidate` already did. A failed
  audit write now fails the call (`"DB"` on Postgres) and changes nothing;
  before, it was ignored and the change kept. Event timestamps are the
  write's own time, which for `add`, `addMany` and `update` equals the
  memory's `updatedAt`.
- **`delete` audit events.** Each memory a `delete` removes gets its own
  `memory.deleted` event; dependents carry `deletedWith`, and the
  survivor's event lists `restoredIds` after a restore.
- **Closer vector matches on Postgres.** The search vector query uses
  `hnsw.iterative_scan = relaxed_order` and sorts its rows again in a
  materialized CTE. Where the planner uses the HNSW index, more of the
  exact nearest memories come back under a selective filter: 95.8% instead
  of 82.7% on a 30,000-memory entity at 1,536 dimensions, 80.7% instead of
  61.7% with a `kinds` filter, with the same plans and a lower p90.
  Results are still in distance order.
- **More duplicate pairs on Postgres.** `findDuplicates` uses
  `hnsw.iterative_scan = relaxed_order` too. Where the planner uses the
  HNSW index for each memory, it found 200 of 200 near-copy pairs instead
  of 187 on a 2,000-memory entity, in 21 s instead of 30 s, with the same
  plan. Pairs are still sorted by similarity.

### Deprecated

- **`experimental.consolidate`** on unbound and bound clients. It calls
  `consolidate` and is removed in 1.0.

### Removed

- **drizzle-kit snapshots from the package.** `migrations/meta/` now ships
  only `_journal.json`; the three `*_snapshot.json` files (about 20 KB) are
  gone. Applying the shipped migrations with drizzle-kit or drizzle-orm's
  `migrate` still works, since both read only the journal and the SQL files.

## [0.7.0] - 2026-11-13

### Added

- **`openaiCompatibleEmbedder`.** A `fetch`-based embedder for any server
  with an OpenAI-shaped `/embeddings`: Ollama, LM Studio, vLLM, Mistral,
  Together, Azure OpenAI. `baseUrl`, `model` and `dimensions` are required;
  `apiKey` is optional, so local servers need no placeholder key. `headers`
  adds request headers, and `sendDimensions: true` sends `dimensions` for
  models that can shorten their vectors. `purposes` marks queries and
  documents for models that embed them differently, with a text `prefix`
  (nomic `search_query: `, E5 `query: `) or request `body` fields (NVIDIA
  NIM `input_type`, Jina `task`); the stored content is unchanged. From
  `mnemocyte/embedders` and `mnemocyte/embedders/openai-compatible`.
- **Query and document embeddings.** `embed(texts, options)` now receives
  `options.purpose`: `"document"` from `add`, `addMany` and `update`,
  `"query"` from `search` and `context`. `EmbedOptions` and
  `EmbeddingPurpose` are exported types.
- **`maxBatch`.** An embedder may set `maxBatch`, the most texts `addMany`
  sends per call (default 100, as before); `openaiEmbedder` and
  `openaiCompatibleEmbedder` take it as an option. Lower it when memories
  are long enough to pass a provider's per-request token limit.
- **`ProviderError`.** When a provider answers with an error status, both
  shipped embedders throw a `ProviderError`: a `MnemocyteError` with code
  `"EMBEDDING"`, `status`, `retryAfterMs` and the response body as `cause`,
  so the provider's explanation (such as OpenAI's `rate_limit_exceeded`) is
  no longer lost. It reaches the caller as it is instead of being wrapped
  in `"Failed to embed text."`. Custom embedders can throw it too.
- **`aiSdkEmbedder`.** Any AI SDK embedding model as an embedder, from
  `mnemocyte/ai-sdk`: `aiSdkEmbedder({ model })` takes a model object such
  as `openai.embedding("text-embedding-3-small")` or a `"provider/model"`
  string, which the AI SDK resolves through its global provider (the AI
  Gateway by default). `ai` 7.0.135 or newer is an optional peer
  dependency; `import "mnemocyte"` does not load it. Known models
  (OpenAI, Gemini, Cohere `embed-v4.0`, Mistral, Titan v2) have a default
  `dimensions`, and any other model requires it. Google, Cohere and Voyage
  models get query and document hints (`taskType`, `inputType`) by default,
  or for `gemini-embedding-2` the text prefixes Google documents for it;
  `purposes` replaces them and `providerOptions` is sent with every call.
  The AI SDK's own retries are off, so the client's `provider` settings
  apply, and AI SDK errors with an HTTP status become a `ProviderError`
  with `retryAfterMs` from the response headers.
- **Voyage, Cohere and Gemini embedders.** `voyageEmbedder`,
  `cohereEmbedder` and `googleEmbedder` call each provider's embeddings API
  with `fetch` (no SDK), from `mnemocyte/embedders` and
  `mnemocyte/embedders/voyage`, `/cohere` and `/google`. The key comes from
  `apiKey` or `VOYAGE_API_KEY`, `COHERE_API_KEY` or `GEMINI_API_KEY`.
  Current models have a default `dimensions`, and those that can shorten
  their vectors accept a smaller one, which is sent; other models require
  `dimensions`. Queries and documents are marked for each provider: Voyage
  `input_type` `query` / `document`, Cohere `search_query` /
  `search_document`, Gemini `taskType` `RETRIEVAL_QUERY` /
  `RETRIEVAL_DOCUMENT`, or for `gemini-embedding-2` the text prefixes
  Google documents for it. `truncate` (default `true`) cuts texts longer
  than the model's context instead of failing the request. `cohereEmbedder`
  sends at most 96 texts per request (Cohere's limit) and `googleEmbedder`
  100 by default. `googleEmbedder` calls the Gemini API (Google AI Studio),
  not Vertex AI. Errors are a `ProviderError`, retried by the client's
  `provider` settings like the other embedders; a Gemini error's message
  names its canonical status, such as `RESOURCE_EXHAUSTED`.
- **AI SDK memory tools.** `memoryTools({ memory: memory.for(scope) })` from
  `mnemocyte/ai-sdk` returns `searchMemories`, `saveMemory` and
  `forgetMemory` for `generateText`, `streamText` and agents. The scope is
  fixed on the server: no tool takes a scope field, and a model that sends
  one gets a tool error. `searchMemories` returns id, content, kind,
  importance, tags, creation time and score, never metadata;
  `saveMemory` stores content, kind and importance with
  `source: "saveMemory"`; `forgetMemory` deletes by id and returns
  `forgotten: false` when there is no such memory. The call's abort signal
  cancels a running tool. Passing the unbound client throws `"CONFIG"`.
- **AI SDK memory middleware.** `withMemory({ model, memory })` from
  `mnemocyte/ai-sdk`, with `memory.for(scope)`, wraps a language model so
  each call recalls memories for the last user message with `context()`
  and adds them to the prompt; `memoryMiddleware` is the same middleware
  for `wrapLanguageModel`. The context goes into the last user message, or
  a system message with `placement: "system"`, and never into your stored
  messages; nothing is added when no memory matches. `context` sets
  `context()`'s options, `query` replaces the query, and the call's abort
  signal cancels the recall. A failed recall goes to `onError` and the
  call runs without memory. An opt-in `save` hook runs after the final
  response of each call with the prompt and response text; the response
  does not wait for it. `withMemory` takes a model object (use
  `gateway("provider/model")` for a gateway id).
- **Memory extraction with your own model.** `save: { model }` on
  `withMemory` and `memoryMiddleware` has that model read each turn after
  the response and store lasting facts about the user in the bound scope,
  with structured output. It sees the user's messages of the turn, the
  assistant message before them, the response and up to 20 stored
  memories, never system messages or tool results. Memories get a key
  `extracted:<name>` and `source: "extractMemories"`; a changed fact
  updates its memory in place, and keys your app chose are never
  overwritten. `instructions` adds guidance, `maxMemories` (default 10)
  and `timeout` (default 30 s) limit it, and `waitUntil` receives the
  extraction's promise for serverless platforms. It is off by default,
  never delays or fails the response, and reports failures to `onError`.
  `extractMemories({ model, memory, prompt, text })` runs the same
  extraction from your own code and returns the stored memories.
- **Pass your database client as `store`.** `createMemory({ store: sql })`
  takes a postgres.js `sql`, a `pg` Pool, a PGlite instance, a Drizzle
  instance over one of them or a `SqlExecutor` directly, recognised by
  shape as `postgresStore` does; `migrate({ store: sql, dimensions })` too.
  `postgresStore()` and `drizzleStore()` keep working and are not
  deprecated. An unrecognised value still throws `"CONFIG"` from
  `createMemory`. The Postgres code is imported on the first call that
  needs it, so apps on the in-memory backend do not load it (about 15 KB
  gzipped at startup instead of 26 KB when bundled). `PostgresClient` is
  also exported as a type from `mnemocyte`.

### Changed

- **`context()` returns `""` when no memory matches.** It used to return
  the format's header with no memories in it (`# Memory Context` and
  `## Relevant Memories` in Markdown). Check for an empty string instead of
  parsing the header.
- **Embedder calls are retried twice by default, with jitter and
  `Retry-After`.** `provider.retries` now defaults to 2 (was 0),
  `baseDelayMs` to 500 (was 100) and `maxDelayMs` to 8000 (was 2000), as in
  the OpenAI SDK. Each wait is a random 50–100% of the backoff delay. A
  provider's `Retry-After` or `retry-after-ms` replaces the backoff; a wait
  longer than the new `provider.maxRetryAfterMs` (default 60000) fails at
  once. Set `retries: 0` for the old behaviour.
- **Retries are decided by status, not message text.** The built-in rule
  retries HTTP 408, 429, 500, 502, 503 and 504 (`error.status`), network
  errors with a transient `code` such as `ECONNRESET` on the error or its
  `cause`, and `"TIMEOUT"`. It no longer retries errors whose message
  contains "500", "network", "timeout" or similar words, nor `"EMBEDDING"`
  and `"DB"` `MnemocyteError`s. A custom embedder that relied on message
  text should throw an error with `status`, or a `ProviderError`.
- **`Embedder.embed` takes a required options object.** Its type is
  `embed(texts, options: { purpose; signal? })`. Embedders that ignore the
  options keep compiling, but a parameter default such as `options = {}`
  no longer type-checks (drop the default), and code that calls
  `embed(texts)` directly must pass `{ purpose: "query" }` or
  `{ purpose: "document" }`.
- **`openaiEmbedder` errors.** A failed request throws `ProviderError`
  instead of a plain `Error` with `status`, and a non-JSON success body
  throws `"EMBEDDING"`. `openaiEmbedder` now shares its code with
  `openaiCompatibleEmbedder`; requests are unchanged.
- **Missing-schema errors name the fix.** A Postgres call that needs a
  missing Mnemocyte table or column still throws `"MIGRATION"`, but the
  message now says to run `migrate({ memory })`, links the Postgres guide
  and repeats the driver's text (for example `relation "mnemocyte_memories"
  does not exist`), instead of naming SQL files. The driver error is still
  the `cause`. A missing `mnemocyte_meta` `installation` row has its own
  message, because `migrate` does not restore a deleted row; the guide
  shows the `INSERT` that does.

## [0.6.0] - 2026-11-13

### Added

- **Default namespace and bound scopes.** `createMemory({ namespace })`
  sets a namespace for every scope that leaves it out; a scope that names
  its own wins. `memory.for(scope)` returns a client bound to one scope
  whose methods take no `scope`: `memory.for({ entityId: user.id }).add({
  content })`. On a bound client, `deleteScope()`, `prune`, `stats()` and
  `listAuditLog` select within the bound scope, `allNamespaces` is not
  available, and a `scope` or `allNamespaces` field passed anyway throws
  `"VALIDATION"`. `migrate({ memory })` accepts a bound client. A malformed
  `namespace` throws `"CONFIG"` from `createMemory`. `MemoryClient` and the
  scoped input types take a `DefaultNamespace` type parameter that defaults
  to `false`, so existing annotations keep their meaning; `createMemory`
  returns `MemoryClient<true>` when `namespace` is set. Code that
  implements `MemoryClient` by hand, such as a test double, needs a `for`
  method.

- **`migrate({ memory })`, `createExtension` and `dryRun`.** `migrate` now
  takes the client from `createMemory()` and reads the store and the
  embedding size from it; `{ store, dimensions }` keeps working, and a
  `dimensions` that differs from the embedder's throws `"CONFIG"`.
  `createExtension: true` runs `CREATE EXTENSION IF NOT EXISTS vector` when
  pgvector is missing, in the fresh install's transaction; it needs a
  superuser or the provider's admin role, and without it throws
  `"MIGRATION"` naming the step. `dryRun: true` returns what a run would
  return from one read-only transaction and changes nothing. The result has
  a new `extensionCreated` field. `MigrateInput` is now a union of the two
  input shapes, so code that reads `input.store` from a `MigrateInput`
  needs to narrow it first.

- **postgres.js 4.** The `postgres` peer range is now `^3.4.9 || ^4`.
  Mnemocyte's statements send only strings, numbers and null, so 4.x
  leaving parameter types to the server changes nothing for them. On
  postgres.js 4.1 and later, a search's settings and vector query and
  `addMany`'s insert chunks go out as one `sql.batch`: one round trip
  instead of `BEGIN`, the statements and `COMMIT`. A transaction's `sql`
  is now accepted by the `postgresStore` types on 3.x as well; a reserved
  connection (`sql.reserve()`) throws `"CONFIG"` on both majors.

- **node-postgres, PGlite and Drizzle clients in `postgresStore`.**
  `postgresStore({ client })` now takes the client your app already has: a
  postgres.js `sql`, a node-postgres `Pool`, a PGlite instance (with
  `@electric-sql/pglite-pgvector`), or a Drizzle instance over one of them,
  recognised by shape without importing any driver. A hand-written
  `SqlExecutor` still works; a `pg.Client` or anything else throws
  `"CONFIG"`. `postgresJs(sql)` keeps working, and `drizzleStore(db)` now
  also accepts `drizzle-orm/node-postgres` and `drizzle-orm/pglite`
  instances. `pg` and `@electric-sql/pglite` are new optional peer
  dependencies. node-postgres and PGlite cannot cancel a statement that is
  already running; an aborted signal stops the next one.

- **Scoped API: `createMemory`.** Every call names a scope:
  `{ namespace, entityId, agentId?, sessionId? }`. Reads see the scope plus
  memories shared by every agent or outside any session (`exactAgent` /
  `exactSession` turn that off); bulk operations select, with an omitted
  agent or session matching any. Records and audit events carry their
  `scope`. See the [upgrade table](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/upgrading.md#05--06).
- **Keyed `add`.** A `key` that already exists in the exact scope updates
  that memory in place (one `INSERT … ON CONFLICT … DO UPDATE` on Postgres),
  keeping its id, creation time and access counts. Audited as
  `memory.updated`.
- **`get`, `list`, `update`, `deleteScope`.** `get` reads one memory by id
  or key. `list` pages newest first with an opaque cursor. `update` changes
  fields of one memory and re-embeds only new content; a key collision
  throws `"CONFLICT"`. `deleteScope` erases an entity (or one agent or
  session) and its audit events in one statement, even after a
  consolidation.

- **`migrate({ store, dimensions })`.** Creates or upgrades the Postgres
  schema from the root `mnemocyte` import. Each migration runs in its own
  transaction behind a transaction-level advisory lock, so app instances
  that migrate at the same time apply each migration once, and applied
  migrations are recorded in a new `mnemocyte_migrations` table. A fresh
  install takes `dimensions` (`halfvec` above 2,000); an installation set up
  with `psql` or drizzle-kit is detected from its schema and adopted. The SQL
  files keep shipping in `migrations/`.

- **`SqlExecutor.batch`.** An optional
  `batch(statements, { signal })` runs statements in order in one
  transaction, all or nothing, and returns each one's rows. `transaction` is
  now optional too; an executor needs `query` plus at least one of the two
  (`"CONFIG"` otherwise). Drivers without interactive transactions (Neon's
  HTTP driver) can implement `batch` alone and still search and write;
  `migrate` still needs `transaction`. `postgresJs` implements both and
  pipelines a batch inside `sql.begin`, which saves a round trip per search.

- **`SqlExecutor` and `mnemocyte/postgres`.** The Postgres backend now runs on
  a two-method `SqlExecutor` (`query` with an optional `AbortSignal`, and
  `transaction`). `postgresJs(sql)` wraps a postgres.js client and
  `postgresStore({ client })` passes it to `createMemory({ store })`.

- **`trackAccess` and the `"trackAccess"` event.** `retrieval.trackAccess`
  turns access tracking on for a client and `trackAccess` on `search` or
  `context` overrides it per call. Each access write emits its own
  `start` and `success` or `error` events to `onEvent`, with operation
  `"trackAccess"`, `namespace`, `entityId` and `count`.

### Changed

- **`addMany` is chunked and all or nothing.** It embeds at most 100 texts
  per embedder call, one call after another, then writes every memory in one
  transaction in `INSERT`s of 250 rows; when any embedder call or insert
  fails, nothing is stored. Audit events are written as multi-row `INSERT`s
  instead of one statement per event.
- **Breaking: input size caps.** These now throw `"VALIDATION"` before any
  embedder or database call: `limit` above 1,000; `content` or a search
  `query` above 32,000 characters; more than 64 tags or a tag above 128
  characters; `metadata` above 64 KiB as JSON or nested deeper than 32
  levels; a `key` above 512 bytes or a scope field above 256 bytes in UTF-8;
  more than 1,000 memories in one `addMany`.

- **Breaking: methods renamed and scoped.** `remember` → `add`,
  `rememberMany({ inputs })` → `addMany({ scope, memories })` (one scope per
  batch), `recall` → `search`, `buildContext` → `context`, `forget` →
  `delete({ scope, id })`, `forgetAll` → `deleteScope`; `findDuplicates`,
  `listAuditLog`, `stats` and `experimental.consolidate` take `scope`
  instead of `entityId`. Memories written before 0.6 are in namespace
  `"default"`. Types follow: `MnemocyteClient` → `MemoryClient`,
  `MnemocyteConfig` → `MemoryConfig`, `RememberInput` → `AddInput`,
  `RecallInput` → `SearchInput`, `BuildContextInput` → `ContextInput`.
- **Breaking: `type` is now `kind`.** The field, the `types` filter and
  `MemoryType` are `kind`, `kinds` and `MemoryKind`.
- **Breaking: `prune` requires a scope.** Pass `scope` (at least a
  `namespace`) or `allNamespaces: true`, plus a selector besides the scope;
  `prune({ kinds: ["fact"] })` no longer deletes across every entity.
- **Breaking: `stats` returns one type.** `stats({ scope })` or
  `stats({ allNamespaces: true })` return `MemoryStats` with `entityCount`;
  `EntityStats` and `GlobalStats` are gone.
- **Breaking: `context` does not echo the query.** The Markdown and plain
  formats lose their query line and the XML its `query` attribute; the
  metadata line says `kind=` instead of `type=`.
- **Search validates every filter.** `tags`, `before`, `after`, `explain`
  and the scope throw `"VALIDATION"` when malformed instead of being passed
  through.

- **Breaking: no runtime dependencies.** `drizzle-orm` and `postgres` moved
  from `dependencies` to optional `peerDependencies`. Mnemocyte now writes its
  own parameterized SQL instead of using the Drizzle query builder; the schema
  and migrations are unchanged. `drizzleStore(db)` keeps working and now runs
  on `db.$client`.
- **Breaking: your client owns TLS and pooling.** Mnemocyte no longer creates
  a pool, so the fixed `max: 10` pool and the `sslmode` override are gone.
  `sslmode=prefer` and `allow` now behave as postgres.js defines them.
  Statements never use named prepared statements, so transaction-mode poolers
  work without `prepare: false`.

- **Breaking: search ranks by reciprocal rank fusion.** The vector and
  keyword searches are fused by rank (`Σ weight / (k + rank)`, `k = 60`)
  instead of a weighted sum of raw scores, so a real full-text match on
  Postgres no longer ranks below a substring coincidence, and both backends
  fuse the same way. Recency and importance now scale the fused score
  instead of adding to it; `confidence` and `accessCount` no longer affect
  ranking. `score` stays between 0 and 1 but values change: a memory found
  by only one search scores at most 0.5, so revisit any `minScore`. When the
  keyword search finds memories the vector search missed, search no longer
  loads their embeddings in a second query.
- **Breaking: retrieval config and scores.** `retrieval.weights` and
  `retrieval.accessSaturation` are replaced by
  `retrieval.fusion: { k, vector, lexical }` and
  `retrieval.boosts: { recency, importance }`; `RetrievalScoreWeights` is
  replaced by `RetrievalFusionConfig` and `RetrievalBoosts`. `scores` now
  has `vectorRank`, `lexicalRank`, `vector`, `lexical` (`null` when the
  memory is not in that list), `fused`, `recency` and `importance`;
  `explanation` has `fusion`, `boosts`, `boostFactor` and `finalScore`.

  ```ts
  // before
  retrieval: { weights: { vector: 0.7, lexical: 0.3 } }
  // after
  retrieval: { fusion: { vector: 0.7, lexical: 0.3 } }
  ```
- **Breaking: access tracking is opt-in and off the response path.** By
  default search no longer writes, so `accessCount` stays 0 and
  `lastAccessedAt` stays null. With `trackAccess` on, the write starts as
  search returns and search does not wait for it: results show the access
  values from before the call, a failed write no longer fails the search
  (it is reported to `onEvent`), and a memory deleted at the same moment no
  longer makes search throw `"DB"`. Search never changes `updatedAt`.

  ```ts
  // keep counting access on every search
  createMemory({ embedder, store, retrieval: { trackAccess: true } });
  ```
- **`prune({ notAccessedSince })` counts never-accessed memories from
  `createdAt`.** Before, a memory that had never been returned by a search
  always matched, so with tracking off every memory in scope did. Now a
  memory created after the date is kept, so this prune deletes the same or
  fewer memories than before.
- **Breaking: Postgres schema v2 (`0003_schema_v2.sql`).** Existing
  installations get it from `migrate()` or by applying
  `migrations/0003_schema_v2.sql`; fresh installs get it from `migrate()`,
  `fresh-install.sql` or the rendered template. It adds `namespace`,
  `agent_id` and `session_id` scope columns (existing rows get namespace
  `default`), an optional `key` with a unique index per scope, renames
  `type` to `kind`, precomputes full text in a stored `content_tsv` column
  with a GIN index, and indexes `superseded_by`. The migration rewrites both
  tables under an `ACCESS EXCLUSIVE` lock.
- **Breaking: UUID ids.** Memory and audit event ids are now UUIDv7 strings
  in `uuid` columns. `0003` converts existing ids that are not UUIDs to
  `md5(id)::uuid`, including the ids inside audit event metadata; convert
  ids your application stored the same way (see
  [Postgres upgrade](docs/guide/postgres.md#upgrading-to-06-0003_schema_v2sql)).
- **Up to 4,000 dimensions on Postgres.** `migrate()` and
  `render-initial.mjs` use `halfvec` with `halfvec_cosine_ops` above 2,000
  dimensions, and refuse more than 4,000. `mnemocyte_meta.vector_type`
  records the choice.
- **Consolidation is one statement.** `experimental.consolidate` no longer
  opens an interactive transaction; aborting it cancels the statement even
  while it waits for a row lock, before anything is written.

### Removed

- **Breaking: `close()`.** The client holds no connections or timers, so
  there is nothing to close; end your own database client. The `"close"`
  observability operation and the `"DB"` "client is closed" error are gone.
- **Breaking: `createMnemocyte`, the positional `rememberMany(inputs)` and
  the `entity.cleared` audit event.** `deleteScope` deletes the scope's audit
  events instead of recording one.

- **Breaking: `databaseUrl`.** Create the client yourself and pass it in.

  Upgrade from 0.5:

  ```ts
  // before
  const client = createMnemocyte({ databaseUrl: process.env.DATABASE_URL!, embedder });

  // after (npm install postgres)
  import postgres from "postgres";
  import { postgresStore } from "mnemocyte/postgres";

  const sql = postgres(process.env.DATABASE_URL!);
  const memory = createMemory({
    namespace: "default",
    store: postgresStore({ client: sql }),
    embedder,
  });
  // end the pool yourself on shutdown: `await sql.end()`.
  ```

### Fixed

- **A failed postgres.js cancel request no longer goes unhandled.** When a
  `signal` aborted, the adapter ignored the promise `query.cancel()`
  returns; on postgres.js 4 it rejects when the server does not answer the
  cancel in time (`CANCEL_UNANSWERED`), which crashed a Node process run
  with the default `--unhandled-rejections=throw`.
- **Breaking: filtered search finds every match on Postgres; needs pgvector
  0.8.0.** The vector search now runs in a short transaction with
  `hnsw.iterative_scan = strict_order` and `hnsw.ef_search` at least the
  candidate count (at most 1,000). Before, the HNSW index returned its 40
  nearest rows and the filters ran afterwards, so a narrow `kinds` or `tags`
  filter, or a small entity in a large table, could return fewer memories
  than exist, or none. Search throws `"MIGRATION"` on pgvector before 0.8.0;
  upgrade the server package, then run `ALTER EXTENSION vector UPDATE`. Each
  search now needs a client with interactive transactions or
  `SqlExecutor.batch`. The cosine
  distance is also computed once per row instead of three times.
- **Scoped id lookups.** Loading embeddings for lexical-only candidates and
  updating access counts now filter by entity as well as id.
- **Embedder checks per model.** The Postgres installation check is cached
  per embedder model and dimensions instead of per store, so two clients with
  different embedders sharing one `drizzleStore(db)` are both checked.

### Documentation

- **Getting started guide.**
  [docs/guide/getting-started.md](docs/guide/getting-started.md) goes from
  an empty folder to a first `context()` call: a local Postgres in Docker,
  `.env`, a `memory.ts` for postgres.js, `pg`, Drizzle or PGlite, a
  `migrate.ts` script, and a bound scope. It also covers Ollama as the
  embedder and the in-memory backend for prototypes. The README links it.
- **Shorter README.** The README now covers install, a quickstart, Postgres
  setup, an API list and embedders. The full reference moved to
  `docs/guide/`: [API](docs/guide/api.md), [Postgres](docs/guide/postgres.md),
  [embedders](docs/guide/embedders.md) and
  [limitations](docs/guide/limitations.md).

## [0.5.1] - 2026-10-26

### Added

- **Consolidated default Postgres fresh install.** Added the generated
  `migrations/fresh-install.sql` for one-command setup of a brand-new
  1536-dimensional database. Unit coverage prevents byte drift from the shared
  initial-migration template, package coverage checks the file in the tarball,
  and Postgres integration coverage compares its tables, columns, constraints,
  indexes, and installation metadata with the existing `0000` → `0001` →
  `0002` sequence on clean schema states. The numbered migrations and Drizzle
  journal remain unchanged for existing-installation upgrades.

### Changed

- **Drizzle ORM 0.45.4.** The `drizzle-orm` dependency range is now
  `^0.45.4`. Development tooling moved to Biome 2.6, tsdown 0.23,
  pnpm 12 and Vitest 5, with `vite` as a dev dependency. The retrieval
  benchmark now times recall alone against the built package.
- **CommonJS `require()`.** `exports` uses the `default` condition instead of
  `import`, so `require("mnemocyte")` and its subpaths work on Node 22.12
  and newer, which covers the supported 22.18 floor. `require()` returns the
  module namespace.
- **Explicit subpaths.** `exports` lists `mnemocyte`, `mnemocyte/embedders`,
  `mnemocyte/embedders/openai` and `mnemocyte/stores/drizzle` instead of the
  `./embedders/*` and `./stores/*` wildcards. These were the only paths the
  wildcards matched, so no import changes.
- **No declaration maps.** The package no longer ships `.d.mts.map` files.
  They pointed at `src/`, which is not published. The `.mjs.map` files, which
  embed their sources, remain.
- **Provenance.** Releases are published from GitHub Actions with npm
  trusted publishing and carry a provenance attestation that links the
  tarball to the commit and workflow that built it. Verify it with
  `npm audit signatures`. Earlier versions were published without one.

### Documentation

- **Runnable Postgres setup commands.** The README now gives concrete `psql`
  commands for pgvector enablement, default and custom-dimension fresh
  installs, and the unchanged 0.1.x and 0.2.x–0.3.x upgrade paths.
- **Safer `psql` commands.** The setup commands now pass
  `-v ON_ERROR_STOP=1 --single-transaction`, so a failing migration stops and
  rolls back instead of leaving a partial schema.
- **README limitations.** The README lists current limitations concretely
  (2,000-dimension HNSW limit, global `prune` without `entityId`, `forgetAll`
  after consolidation) and moves contributor material to
  `docs/DEVELOPMENT.md`.

## [0.5.0] - 2026-07-22

### Added

- **Caller-owned postgres.js Drizzle storage.** Added the
  wildcard-backed `mnemocyte/stores/drizzle` subpath and `drizzleStore(db)` for
  applications that already own a postgres.js-backed Drizzle instance.
  `MnemocyteConfig.store` accepts the adapter's opaque `MnemocyteStoreConfig`
  value, rejects a simultaneous `databaseUrl` with `"CONFIG"`, and leaves the
  supplied Drizzle connection usable after `client.close()`. The v1 adapter
  targets the `public` schema and requires the bundled migrations to be applied
  in advance; other Drizzle drivers remain unsupported.

### Breaking Changes

- **CONSOLIDATION-03 — Consolidation revalidates the survivor atomically.**
  `experimental.consolidate()` now rejects with `"CONFLICT"` if its survivor
  is deleted or becomes superseded after shared preflight but before the
  store mutation. Both adapters protect the survivor together with loser,
  audit, and tag changes, and tag unions now start from the survivor's
  mutation-time tags so concurrent committed merges do not lose tags.
- **CONSOLIDATION-02 — Duplicate loser IDs now reject.**
  `experimental.consolidate()` rejects repeated entries in `supersededIds`
  with `"VALIDATION"` before store access. Calls that previously processed one
  in-memory loser and audit event multiple times, or silently deduplicated the
  same input in Postgres, must now supply each loser exactly once.

### Documentation

- Reverified the `docs/design/` investigation sequence against the current
  source, tests, package boundary, migrations, and Git state. Canonical
  architecture and maintainer docs now record the tagged `0.4.0` baseline,
  lazy Postgres runtime loading, the complete 18-method `MemoryStore`
  disposition, design-record authority, and the consolidation contract
  decisions that were pending at that audit.

## [0.4.0] - 2026-07-17

### Added

- **AUDIT-02 — Experimental composite audit cursors.** Added the exported
  `AuditLogCursor` type plus `beforeCursor` / `afterCursor` inputs. Audit logs
  now order by `(timestamp, event ID)` in descending order and use matching
  tuple comparisons, so equal-timestamp events can be paged without omissions
  or duplicates. Migration note: existing `before` / `after` timestamps remain
  strict filters, not complete pagination cursors; callers that page with
  timestamps alone should switch to the composite fields for tie-safe paging.

### Breaking Changes

- **CONSOLIDATION-01 — Consolidation idempotency is survivor-specific.**
  Retrying a loser against the survivor it already references remains a
  successful zero-count no-op. Requesting a different survivor now rejects
  the entire consolidation with `"CONFLICT"` before any loser, survivor tags,
  or audit events change. Postgres locks requested loser rows inside the
  consolidation transaction so concurrent calls follow the same rule.
- **CONTEXT-02 — Context token budgets are now a hard postcondition.**
  `buildContext()` no longer returns an over-budget truncation marker for
  extremely small `maxTokens` values. It returns the longest marker fragment
  that fits, or an empty string when even one character exceeds the budget, so
  callers that relied on the complete fallback marker must handle shorter
  results.
- **CONFIG-02 — Database URLs require a Postgres protocol.** Client
  construction now rejects URLs whose protocol is not `postgres:` or
  `postgresql:` synchronously with `"CONFIG"`, before creating a connection
  handle. Detailed host, database, and credential validation remains with
  postgres.js.
- **OPENAI-01 — Malformed OpenAI response indices now reject.** The OpenAI
  helper now requires `data` to contain exactly one uniquely indexed array
  embedding per requested input. Duplicate indices, count mismatches,
  non-array data, malformed items, and non-array embeddings fail with
  `"EMBEDDING"` instead of overwriting or returning malformed results.
  Dimension and finite-component checks remain at the shared embedding
  boundary.
- **CONTEXT-01 — Plain-text memory delimiters are now collision-free.** Plain
  context no longer uses the fixed `--- MEMORY N START/END ---` lines. It
  chooses a deterministic `=` fence longer than every run in the query,
  metadata, and included memory content, so untrusted text cannot terminate its
  own frame. Callers parsing the old fixed plain-text delimiters must update;
  Markdown and XML formatting are unchanged.
- **CONFIG-01 — Invalid provider resilience numbers reject at construction.**
  `timeoutMs`, `baseDelayMs`, and `maxDelayMs` must be finite and
  non-negative; `retries` must also be an integer; and `shouldRetry` must be
  callable. Invalid values now throw `"CONFIG"` synchronously instead of
  failing later during provider work. `maxDelayMs` below `baseDelayMs` remains
  supported and is normalized up to the base delay.

- **INPUT-02 — Malformed remember domains now reject at runtime.** Unknown
  memory types or importance levels, non-array/non-string tags, non-string
  sources, and invalid expiration dates now fail with `"VALIDATION"` before
  provider or storage work. Type filters on recall, duplicate search, and
  prune use the same runtime memory-type domain validation.

- **CONSOLIDATION-DELETE-01 — Referenced consolidation survivors cannot be
  deleted.** `forget`, `forgetAll`, and non-dry-run `prune` now reject with
  `"CONFLICT"` when a selected memory still has `supersededBy` dependents.
  Rejection happens before any row is deleted, including multi-row prune and
  `forgetAll` batches. Deleting superseded losers and memories with no
  dependents continues to work.
- **EMBED-02 — Postgres enforces one embedding model per installation.**
  `mnemocyte_meta` now records `embedding_model` alongside dimensions.
  Writes, recall, and duplicate scans reject a different configured model with
  `"CONFIG"` before provider usage or vector comparison. Migration `0002`
  infers a single historical model; mixed historical models leave the metadata
  unset and fail embedding-dependent operations with `"MIGRATION"` until an
  operator explicitly repairs or re-embeds the data.

### Changed

- **AUDIT-01 — Global prune writes per-entity audit events.** When audit is
  enabled, a successful non-dry global prune now records one
  `"memory.pruned"` event with the deleted count for each affected entity.
  Dry runs, zero-deletion runs, and unaffected entities still produce no prune
  event; audit persistence remains best-effort.
- **RETRIEVAL-02 — Recall returns post-update access metadata.** Successful
  recall results now expose the `accessCount`, `lastAccessedAt`, and
  `updatedAt` written by that recall instead of values from the preceding
  access. Ranking and score explanations still use the pre-access count, so a
  recall does not reorder or rescore itself.
- **STORE-01 — Batch inserts validate the store return contract.** Shared
  orchestration now requires exactly one returned memory for every prepared
  input ID, rejects missing, duplicate, or unknown IDs with `"DB"`, and
  restores input order before returning `rememberMany()` results.
- **REFACTOR-01 — Metadata ownership avoids redundant traversals.** Remember
  inputs now carry an internal validated/owned JSON type through record
  creation and storage, freshly created in-memory rows transfer ownership to
  the adapter, and adapter-returned detached memories/audit events are no
  longer cloned again by shared client orchestration. Public validation,
  snapshot, and mutation-isolation behavior is unchanged.
- **OBSERVABILITY-01 — Remember preparation failures emit operation events.**
  `remember` and `rememberMany` now emit exactly one `"start"` and one
  `"error"` event when synchronous snapshotting or validation fails, using the
  same thrown value exposed to the caller. Call-time snapshots still happen
  before awaiting observability hooks, and closed-client errors retain
  precedence over invalid input.
- **INPUT-01 — `remember` snapshots mutable inputs at invocation.** Single and
  batch writes now own copies of caller-supplied tags, metadata, and expiration
  dates before awaiting embedding or storage, so mutations made while a write
  is pending cannot change the stored memory.
- **Documentation reflects the current pre-v1 state.** Architecture and
  maintainer docs now include the consolidation deletion helper and complete
  metadata schema, document the current plain-text framing and tiny-token-budget
  limitations, and label dated audit counts and Git-state claims as historical
  snapshots.
- **LIFECYCLE-01 — `close()` coordinates with in-flight operations.** Closing a
  client now rejects newly started work, waits for already-started operations
  before closing the store, and shares one promise across concurrent/idempotent
  close calls. If the store close fails, operation admission reopens so callers
  can retry `close()`.
- **CANCELLATION-01 — Maintenance-operation signals are now enforced.**
  `prune`, `findDuplicates`, `listAuditLog`, and `experimental.consolidate`
  reject pre-aborted signals before store work. In-memory scans check
  cooperatively; standalone Postgres maintenance queries request postgres.js
  cancellation. Postgres consolidation checks cancellation between transaction
  steps and before its transaction callback returns, so in-flight statements
  may finish before rollback. An abort after the final check, including during
  commit, may still leave the mutation committed.
- **PRUNE-01 — Malformed prune selectors fail before storage access.** Prune
  now validates dates, enum values, arrays, booleans, and signals, then passes
  only a normalized internal filter to storage adapters. False flags and empty
  arrays do not count as selectors, and both adapters reject an empty internal
  filter before scanning or issuing SQL, preventing malformed inputs from
  becoming unbounded deletes.
- **SERIALIZATION-01 — Postgres vectors preserve small finite components.**
  Vector inserts and raw query literals now use a shortest round-trip-safe
  number representation, so finite values such as `1e-20` are no longer
  rounded to zero before pgvector applies its native float4 conversion.
- **EMBED-01 — Zero-norm embeddings are rejected.** Shared embedding
  validation now rejects exact all-zero vectors with `"EMBEDDING"` before
  storage, recall comparison, or duplicate-search participation in either
  backend. Tiny nonzero vectors remain valid.
- **RETRIEVAL-01 — Signed cosine candidates have backend parity.** The
  internal vector-search contract now returns only finite components clamped
  to `[0, 1]`. Postgres applies its vector cutoff to that clamped component,
  so negative-cosine candidates can still participate in shared score fusion;
  public `minScore` remains a final fused-score filter.

## [0.3.0] - 2026-07-16

### Breaking Changes

- **BUG-03 — Metadata uses JSON value semantics.** `Memory.metadata`,
  `RememberInput.metadata`, and `AuditEvent.metadata` now use the exported
  recursive `JsonObject` / `JsonValue` types instead of
  `Record<string, unknown>`. Unsupported or cyclic values fail with
  `"VALIDATION"`, and metadata is deep-cloned at write and read boundaries in
  both backends.
- **BUG-02 — Retrieval tuning rejects invalid values.** Client construction
  now throws `"CONFIG"` for non-finite or negative weights, a zero effective
  weight total, non-positive or non-finite recency/access settings, and a
  `candidateMultiplier` that is not an integer of at least 1. Supplying a
  `maxTokens` value that is not a positive integer now throws `"VALIDATION"`;
  omission keeps the existing default path.
- **BUG-01 — `rememberMany` has one batch cancellation signal.** The canonical
  call is now `rememberMany({ inputs, signal })`; item inputs do not own
  cancellation, and aborting `signal` cancels the whole batch without changing
  its return shape. The positional `rememberMany(inputs)` signature remains as
  a deprecated pre-v1 compatibility overload and continues treating the first
  item's signal as the batch signal.

### Changed

- **Internal `MemoryStore` boundary.** Refactored in-memory and Postgres
  backends behind internal storage adapters. That refactor preserved the public
  API; the separate pre-v1 breaking changes are listed above.
- **Shared client orchestration.** Validation, embedding calls, recall scoring,
  observability, audit opt-in behavior, context building, lifecycle checks, and
  public result mapping now run through one shared client path.
- **Postgres metadata checks are narrower.** Embedding-dimension validation now
  runs only for operations that call the embedder or compare stored embeddings,
  so non-embedding recovery operations are not blocked solely by a dimension
  mismatch.
- **Provider timeouts actively abort attempts.** Configured provider timeouts
  now abort the per-attempt `AbortSignal` passed to embedders.
- **Lint validation is read-only.** `pnpm lint` now checks formatting, lint
  rules, and import organization without modifying files, fails on warnings,
  and leaves fixes to `pnpm lint:fix`.
- **Memory internals have focused module boundaries.** Defaults, embedding
  calls, in-memory filters, record mapping, and validation now live in separate
  leaf modules, with public-memory cloning shared by storage and scoring paths.
- **Postgres benchmarks initialize current metadata.** Retrieval benchmarks now
  apply both bundled migrations and create a missing default installation row
  without overwriting an existing dimension selection.
- **Node declarations match the support floor.** Development now uses Node 22
  type declarations, reducing the chance of accidentally depending on APIs
  unavailable at the minimum supported Node `22.18` runtime.

### Fixed

- **Invalid embedding components fail before storage.** Single and batched
  embedder output now rejects `NaN` and infinite vector values with error code
  `"EMBEDDING"` before either backend can persist them.
- **Client configuration failures are consistently typed.** Explicitly empty
  database URLs fail with `"VALIDATION"`, malformed URLs fail with `"CONFIG"`,
  and malformed embedder models remain in the `"CONFIG"` category.
- **In-memory close releases audit metadata.** Closing the in-memory store now
  clears its audit-event buffer alongside stored memories.
- **In-memory results no longer leak embeddings.** Public `Memory`,
  `MemoryWithScore`, and duplicate-pair results are mapped through explicit
  public-memory clones that omit internal vectors at runtime.
- **Postgres failures are normalized more consistently.** Expected missing
  schema/migration failures are surfaced as `"MIGRATION"` and expected
  storage/query failures as `"DB"` while preserving existing typed errors.

## [0.2.0] - 2026-06-10

### Added

- **Configurable Postgres embedding dimensions.** Added
  `mnemocyte_meta.embedding_dimensions` as installation metadata via
  `0001_add_mnemocyte_meta.sql`, plus a dimension-rendered initial migration
  template and `pnpm migration:render` tooling for explicit custom pgvector
  schemas.

### Changed

- **Postgres dimension validation is metadata-backed.** `createMnemocyte`
  stays synchronous and no longer hard-rejects non-1536 Postgres embedders.
  The Postgres client validates `embedder.dimensions` against
  `mnemocyte_meta` before storage operations, and write/recall paths validate
  before calling external embedders.
- **v1 planning docs are clearer.** README, architecture notes, roadmap,
  project memory, and performance notes now separate current behavior, known
  pre-v1 limitations, planned v1 work, and future considerations.

## [0.1.5] - 2026-05-22

### Fixed

- **Embedder helper autocomplete.** Added a folder-level
  `mnemocyte/embedders` package export so editors can discover
  `openaiEmbedder` while preserving the existing
  `mnemocyte/embedders/openai` subpath.

## [0.1.4] - 2026-05-21

### Added

- **Official OpenAI embedder helper.** Added
  `mnemocyte/embedders/openai` with `openaiEmbedder({ apiKey, model,
dimensions? })`, `OPENAI_API_KEY` defaulting, `AbortSignal` forwarding,
  known OpenAI embedding dimensions, and package export/type coverage.

### Changed

- **OpenAI helper uses direct `fetch` calls.** The root package remains
  provider-SDK-free, and the OpenAI helper does not add an OpenAI SDK
  dependency.
- **Provider retry detection recognizes numeric HTTP statuses.** The default
  retry heuristic now treats provider errors with status `429`, `500`, `502`,
  `503`, or `504` as transient.
- **Documentation now includes production HNSW/index guidance.** README,
  architecture, and roadmap docs explain the bundled
  `mnemocyte_memories_embedding_hnsw_idx` index, HNSW tradeoffs, filtering
  behavior, and when to benchmark alternate full-text/tag/vector indexes.
- **Roadmap wording now uses `MemoryStore`.** Future backend abstraction docs
  now refer to the planned `MemoryStore` boundary rather than generic `Store`.

## [0.1.3] - 2026-05-21

### Changed

- **Postgres recall transfers narrower result rows.** Vector and lexical
  candidate queries no longer return stored embeddings in their main result
  sets; lexical-only candidates fetch embeddings through a narrow follow-up
  lookup only when JS-side cosine rescoring needs them.
- **Postgres `stats()` aggregates in SQL.** Entity and global stats now use
  conditional aggregate queries instead of materializing full memory rows in
  JavaScript.
- **Documentation now matches the shipped schema and driver path.** README,
  architecture, roadmap, and performance notes now describe the actual HNSW,
  full-text, embedder-dimension, postgres.js, and retry behavior.
- **Roadmap documentation now reflects the adapter-first direction.** The
  planning docs prioritize `0.1.x` hardening, `openaiEmbedder()`, configurable
  dimensions with `mnemocyte_meta`, `MemoryStore`, `drizzleStore(db)`,
  and `@mnemocyte/mcp`.
- **Retrieval benchmarks now cover scale curves.** `bench:retrieval` runs
  multiple in-memory sizes and optional Postgres cases when `DATABASE_URL` is
  configured.
- **Recall scoring avoids repeated per-candidate setup.** Recall paths now
  precompute lexical query terms and normalized retrieval weights once per
  request.
- **Tests now run fully through Vitest.** Runtime tests, package export checks,
  strict test type checks, and retrieval benchmarks were migrated from Node
  script-style `.mjs` files to TypeScript Vitest suites with named projects for
  unit, package, and Postgres integration coverage.

### Fixed

- **Postgres consolidation honors audit opt-in.** `"memory.superseded"` audit
  events are only written when `audit.enabled` is true, matching the in-memory
  backend and README contract.
- **`buildContext` no longer depends on method `this` binding.** Both backends
  close over the client object when delegating to `recall`.
- **Postgres `stats()` has broader parity coverage.** Integration assertions
  now cover empty, active, expired, superseded, pruned, deleted, entity, and
  global stats scenarios.
- **Postgres tag filters bind text arrays correctly.** Raw SQL recall and
  duplicate-detection paths now pass requested tags as `text[]` values.
- **Postgres raw recall rows preserve timestamp semantics.** Timestamp fields
  returned from raw SQL candidate queries are normalized to `Date` instances
  before scoring and output.
- **Postgres tooling loads `.env` when present.** `drizzle.config.ts` and
  `test:integration` now pick up `DATABASE_URL` from `.env` if it is not
  already set in the process environment.
- **Migrations now use Drizzle-native format.** Replaced hand-written SQL
  migration with Drizzle-generated migration for better schema sync and
  maintainability.

## [0.1.2] — 2026-05-20

### Changed

- **`rememberMany` batches embedding and insert.** Both backends now call
  `embedder.embed()` once for all texts and the Postgres backend performs a
  single batch `INSERT`, reducing N sequential network round-trips to 1.
- **Hybrid recall computes real scores for non-overlapping candidates.**
  Vector-only results now get a JS-side lexical score and lexical-only
  results get a cosine similarity from the stored embedding, instead of
  defaulting to 0.
- **`buildContext` uses binary search for token-budget fitting.** Reduced
  from O(N) to O(log N) `tokenCounter.count()` calls.
- **`experimental.consolidate` mutations are transaction-wrapped.** The
  `markMemoriesSuperseded`, audit event inserts, and `setMemoryTags` calls
  now execute inside a single `db.transaction()` for ACID safety.

### Added

- `embedMany()` batch embedding helper in `memory/shared.ts`.
- `insertMemories()` batch insert query in `db/queries/memories.ts`.

## [0.1.1] — 2026-05-14

### Fixed

- Postgres recall/buildContext tag filters now require all requested tags,
  matching the public types and in-memory backend.
- pgvector insert and query literals now reject non-finite values and avoid
  scientific notation.
- Context output now uses explicit Markdown/plain text boundaries and trims
  whole ranked memories before falling back to string-level token truncation.
- README, architecture, and roadmap wording now match the current HNSW
  migration, passive dedup/conflict-detection status, and Neon driver plan.

## [0.1.0] — Phase 5 hardening + Phase 6 consolidation tooling

First milestone release. Phase 5 (production hardening) and the first
three Phase 6 items (passive duplicate detection, audit log, active
consolidation) are complete and stable enough to publish as a
coherent surface.

### Added — public API

- **Provider resilience** (`MnemocyteConfig.provider`): `timeoutMs`,
  `retries`, `baseDelayMs`, `maxDelayMs`, `shouldRetry`. Applied to every
  embedder call. Defaults are no-op.
- **`AbortSignal` cancellation** on `remember`, `rememberMany`, `recall`,
  `buildContext`, `prune`, `findDuplicates`, `listAuditLog`, and
  `experimental.consolidate`. Throws `MnemocyteError` code `"ABORTED"`.
- **Observability hooks** (`MnemocyteConfig.observability.onEvent`):
  `start` / `success` / `error` events for every state-changing or
  read operation, with `backend`, `operation`, `entityId`, `memoryId`,
  `count`, `durationMs`. New `MnemocyteOperation` values:
  `"prune"`, `"findDuplicates"`, `"listAuditLog"`, `"consolidate"`.
- **`client.prune(input)`**: bulk-delete by `entityId` / `expired` /
  `superseded` / `createdBefore` / `notAccessedSince` / `types` / `tags` /
  `maxImportance`, with `dryRun` preview. Rejects `prune({})` with code
  `"VALIDATION"` to avoid accidental full deletion.
- **`client.findDuplicates(input)`**: read-only pairwise cosine scan,
  threshold + limit + filters, returns `DuplicatePair[]`. _Experimental._
- **`client.listAuditLog(input)`** + **`MnemocyteConfig.audit.enabled`**:
  opt-in audit log of state changes, persisted to `mnemocyte_events` (or
  an in-memory array). Slugs: `"memory.created"`, `"memory.deleted"`,
  `"entity.cleared"`, `"memory.pruned"`, `"memory.superseded"`.
  _Experimental._
- **`client.experimental.consolidate(input)`**: mark loser memories as
  superseded by a survivor; idempotent for already-superseded losers;
  optional tag merge; emits `"memory.superseded"` audit events.
  _Experimental._
- **Public types**: `ProviderResilienceConfig`, `PruneInput`,
  `PruneResult`, `FindDuplicatesInput`, `DuplicatePair`, `AuditConfig`,
  `AuditEvent`, `ListAuditLogInput`, `ConsolidateInput`,
  `ConsolidateResult`, `ExperimentalMnemocyteClient`.
- **Public type field**: `Memory.supersededAt: Date | null`, set whenever
  `supersededBy` is set.
- **New error codes**: `"TIMEOUT"`, `"ABORTED"`.

### Changed — behaviour

- `forgetAll` no longer cascade-deletes the audit log. The trail is
  sticky; wiping an entity is itself a recorded `"entity.cleared"`
  event.
- `createMnemocyte` now validates `embedder.dimensions === 1536` when a
  `databaseUrl` is supplied, throwing `MnemocyteError` code `"CONFIG"`
  before opening the connection pool. Previously the embedder mismatch
  surfaced as a confusing SQL error at first insert.
- Postgres `forgetAll` surfaces the deletion count via the observability
  `count` metadata to match the in-memory backend.

### Fixed

- `Memory.id` JSDoc no longer claims the Postgres backend uses a UUID;
  both backends emit `mem_*` prefixed IDs.
- `lifecycle/close.test.mjs` now covers every public method, including
  `findDuplicates`, `listAuditLog`, and `experimental.consolidate`.

### Removed

- `useDatabase` helper from `src/db/index.ts`. It was never re-exported
  from `mnemocyte` and is unused internally.

### Tooling

- New tests: `test/resilience`, `test/prune`, `test/lifecycle`,
  `test/dedup`, `test/audit`, `test/consolidate`. CI runs them all.
- Postgres integration test (`test/integration/postgres.test.mjs`)
  exercises the full happy path: `remember` → `rememberMany` → `recall`
  → `findDuplicates` → `experimental.consolidate` → `buildContext`
  → `listAuditLog` → `prune` → `forgetAll`, plus observability event
  coverage assertions.
- `pnpm pack:check` replaces the unsupported `pnpm pack --dry-run`.

### Docs

- `README.md`: new sections for provider resilience, pruning, finding
  duplicates, audit log, and consolidating duplicates. Postgres section
  documents the 1536-d embedder constraint.
- `ARCHITECTURE.md`: refreshed module structure, public surface map for
  0.1.0, refreshed error-code list, new "Known limitations" section.

## [0.0.8] — 2026-05-13

- Pre-Phase-6 audit fixes: stale checklist flipped, `Memory.id` JSDoc
  corrected, Postgres `forgetAll` symmetry, lifecycle test for
  `assertOpen` after `close()`.

## [0.0.7] — 2026-05-13

- Provider retries, timeouts, and `AbortSignal` cancellation plumbed
  through `remember` / `recall` / `buildContext`. New error codes
  `"TIMEOUT"` and `"ABORTED"`. CI matrix raised to Node 22.18 / 24.

## [0.0.6] — 2026-05-13

- Observability hooks: `MnemocyteConfig.observability.onEvent` + public
  `MnemocyteObservation` types.

## [0.0.5] — earlier

- Package export smoke tests + `test:exports`.

## [0.0.4] — earlier

- Context builder (`buildContext`) with markdown / plain / xml formats,
  XML escaping, and a pluggable `TokenCounter`.

## [0.0.3] — earlier

- Retrieval scoring improvements and quality fixtures.

## [0.0.2] — earlier

- MVP public API (`remember`, `recall`, `forget`, `forgetAll`, `stats`)
  with in-memory and Postgres + pgvector backends.

## [0.0.1] — earlier

- Initial project setup.

[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/Meenic/mnemocyte/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/Meenic/mnemocyte/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/Meenic/mnemocyte/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Meenic/mnemocyte/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Meenic/mnemocyte/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Meenic/mnemocyte/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Meenic/mnemocyte/compare/v1.0.0-rc.2...v1.0.0
[1.0.0-rc.2]: https://github.com/Meenic/mnemocyte/compare/v1.0.0-rc.1...v1.0.0-rc.2
[1.0.0-rc.1]: https://github.com/Meenic/mnemocyte/compare/v0.8.0...v1.0.0-rc.1
[0.8.0]: https://github.com/Meenic/mnemocyte/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/Meenic/mnemocyte/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Meenic/mnemocyte/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/Meenic/mnemocyte/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Meenic/mnemocyte/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Meenic/mnemocyte/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Meenic/mnemocyte/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Meenic/mnemocyte/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/Meenic/mnemocyte/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Meenic/mnemocyte/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Meenic/mnemocyte/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Meenic/mnemocyte/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Meenic/mnemocyte/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Meenic/mnemocyte/compare/v0.0.8...v0.1.0
[0.0.8]: https://github.com/Meenic/mnemocyte/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/Meenic/mnemocyte/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/Meenic/mnemocyte/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/Meenic/mnemocyte/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/Meenic/mnemocyte/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Meenic/mnemocyte/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Meenic/mnemocyte/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Meenic/mnemocyte/releases/tag/v0.0.1
