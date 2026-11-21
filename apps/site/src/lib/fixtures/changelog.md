# Changelog

All notable changes to `mnemocyte` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) from
1.0; before it, minor versions (`0.x.0`) could contain breaking changes,
marked **Breaking** in their entries. What semver covers is in
[docs/guide/api.md](docs/guide/api.md#stability).

## [Unreleased]

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

- **`mnemocyte check` on a schema installed without `migrate`** now says
  that drizzle-kit installations keep upgrading through
  `mnemocyte generate --adapter drizzle`, instead of only suggesting
  `mnemocyte migrate`.

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
