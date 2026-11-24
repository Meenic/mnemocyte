# Limitations

These are the current limits of Mnemocyte, what happens when you hit them,
and, where one exists, the [roadmap](../ROADMAP.md) item that addresses
them.

## Storage

- **One embedding model per Postgres installation.** A second model or
  dimension throws `"CONFIG"`, and mixed history throws `"MIGRATION"` until
  repaired ([postgres.md](./postgres.md#repair-mixed-models)).
- **Switching embedding models has no supported path.** `migrate` never
  changes an installation's model or dimensions, and no method re-embeds
  stored memories. For a model with the same dimensions, re-embed the rows
  or delete the old model's rows by hand, then record the new model as
  [repair mixed models](./postgres.md#repair-mixed-models) shows. For
  other dimensions, install in a fresh database and add the memories
  again.
- **At most 4,000 dimensions on Postgres.** Above 2,000 the schema stores
  embeddings as `halfvec` (16-bit floats), because pgvector's HNSW index on
  `vector` stops at 2,000; `halfvec` indexes stop at 4,000, and `migrate` and
  `mnemocyte sql` refuse larger sizes. Half precision is close to lossless for cosine
  ranking but not bit-for-bit equal to the vectors you sent.
- **Five drivers are built in.** postgres.js, a node-postgres `Pool`,
  PGlite, Neon's HTTP driver (`neon()`, `@neondatabase/serverless` 1.x),
  and Drizzle over one of them. A `pg.Client` and other Drizzle drivers
  throw `"CONFIG"`; anything else needs a hand-written `SqlExecutor`
  ([postgres.md](./postgres.md#bring-another-driver)). postgres.js 3.4.9+
  and 4.x both work; a reserved connection (`sql.reserve()`) throws
  `"CONFIG"`, because it cannot open a transaction.
- **node-postgres and PGlite cannot cancel a running query.** An aborted
  `signal` stops the next statement and the call rejects with `"ABORTED"`,
  but a statement already sent runs to the end. postgres.js cancels it on
  the server.
- **An abort over Neon's HTTP driver may still commit.** The call rejects
  with `"ABORTED"` as soon as the signal fires, but Neon does not say
  whether the statement stops on the server. Assume it runs to the end:
  an aborted `addMany` may still have saved its memories.
- **`migrate` needs interactive transactions.** It runs each migration in
  a transaction, so HTTP drivers without one (Neon's HTTP driver) throw
  `"CONFIG"`, and so does `setTextSearchConfig`. Run both over a
  connection with transactions, such as Neon's `Pool`
  ([postgres.md](./postgres.md#neon)). The CLI does not open one for you
  yet.
- **`migrate` does not move an installation between schemas.** With
  `schemaName` set, a fresh install throws `"CONFIG"`
  (`INSTALLATION_ELSEWHERE`) while `search_path` finds Mnemocyte tables in
  another schema. Move them with `ALTER TABLE … SET SCHEMA`, or install a
  second one from `mnemocyte sql --schema`
  ([postgres.md](./postgres.md#move-an-existing-installation)).
- **drizzle-kit needs two custom migrations, and no `push`.** The schema
  file from `mnemocyte generate --adapter drizzle` leaves out the pgvector
  extension, the unique key index and the installation row, because
  drizzle-orm cannot express them; the command prints their SQL.
  `drizzle-kit push` drops that index, after which every `add` with a
  `key` fails. The file is written for drizzle-orm 0.45, not yet 1.0
  ([postgres.md](./postgres.md#manage-the-tables-with-drizzle-kit)).
- **Schema names are lower case.** `schemaName` takes letters `a`–`z`,
  digits and underscores only, so a schema created as `"Memory"` (quoted,
  mixed case) cannot be used.
- **Recall needs pgvector 0.8.** The vector search uses iterative index
  scans; pgvector before 0.8.0 throws `"MIGRATION"`.
- **`addMany` takes at most 1,000 memories.** Larger calls throw
  `"VALIDATION"`; split them into several calls, each all or nothing. The
  memories are written in one transaction, so a large call holds it while
  every row and its HNSW index entry are written.
- **Input sizes are capped.** Content and queries stop at 32,000
  characters, metadata at 64 KiB, keys at 512 bytes and scope fields at 256
  bytes, among others; see [input limits](./api.md#input-limits). The caps
  are fixed.
- **One HTTP request per batch.** A `SqlExecutor.batch` over an HTTP driver
  sends a whole `addMany` in one request, so the driver's request limit
  applies (64 MB on Neon). At 1,536 dimensions 1,000 memories take about
  20 MB of vector text plus their content.

## libSQL

- **Vector search scans the scope.** There is no vector index yet: every
  search compares the query with each memory of its scope, so its time
  grows with the scope ([libsql.md](./libsql.md#how-search-works) has
  the numbers). A libSQL vector index (DiskANN) would rank the whole table
  before the scope filter and return nothing for most users of a shared
  table; it is on the roadmap's later list.
- **`findDuplicates` compares every pair.** Its time grows with the square
  of the scope; use `experimental.findDuplicatesPage` on large scopes.
- **libSQL engines only.** `@libsql/client` on a `file:` URL, Turso Cloud
  or a libSQL server. Plain SQLite, `@tursodatabase/database` and
  `@tursodatabase/serverless` are not supported.
- **The CLI needs a memory file.** Without one it connects to
  `DATABASE_URL` with postgres.js. `sql` and `generate --adapter drizzle`
  are Postgres only, `init` writes a libSQL file only around an existing
  Drizzle libSQL client, and `--dimensions` stops at 4,000.
- **Concurrent writers on one file.** Writes run one at a time; a write
  that meets another process's lock fails with `"DB"` (`SQLITE_BUSY`)
  instead of waiting.
- **Two keyword languages.** `textSearchConfig` takes `porter` (English
  stemming, the default) or `unicode61`. Query syntax such as quoted
  phrases or `-word` is matched as plain words, and only the first 64
  distinct words count.
- **No cancellation.** An aborted `signal` stops the next statement; one
  already sent runs to the end.

## Custom stores

- **No installation report.** `mnemocyte check` says a store from
  `defineMemoryStore` reports no installation, and `setTextSearchConfig()`
  and `mnemocyte text-search` change nothing for it.
- **No embedder check unless the store has one.** Without
  `ensureEmbeddingCompatibility`, a client with another embedding model
  writes and searches the same memories without an error.
- **The contract suite runs on Vitest 5 only.** It needs `vitest` installed
  and writes 1,536-dimension embeddings.
- **No JavaScript helpers.** Building audit events, visibility filters and
  duplicate pairs is up to the store; see
  [custom-stores.md](./custom-stores.md#what-a-custom-store-does-not-get).

## Retrieval

- **Keyword search uses one language per installation on Postgres.** It
  follows the [text search configuration](./postgres.md#keyword-search-language)
  picked at install time, `english` by default, for every memory. Memories
  in other languages get that language's stemming and stop words, so their
  keyword matches are weaker and vector search carries more of the
  ranking; `simple`, with no stemming, treats every language alike.
  Changing it later rewrites the memories table and rebuilds its indexes
  while the app waits, and app processes that are already running keep the
  old configuration for their queries until they restart.
- **Keyword search differs by backend.** Postgres uses full-text search
  (stemming and stop words, unless the configuration is `simple`), and
  requires every word of the query; libSQL uses FTS5 with `bm25`, matches
  any word and has no stop words; the in-memory store matches query words
  as substrings. All of them fuse ranks the same way, but they can find
  different keyword matches, so results for the same data can differ.
- **Very selective filters cost more on Postgres.** The vector search keeps
  scanning the HNSW index until it has enough memories that pass the filters,
  up to pgvector's `hnsw.max_scan_tuples` (20,000 by default). A filter that
  matches fewer memories than requested on a large entity scans that many
  rows, and memories beyond that limit are not returned.
- **Vector search on a large entity is approximate on Postgres.** When the
  HNSW index is used, it can miss some of the nearest memories: on a test
  server with 132,000 memories at 1,536 dimensions, a 30,000-memory entity's
  search returned about 96% of the exact nearest rows, and about 81% with a
  `kinds` filter. Recall varies between index builds, so the same data can
  score a few points higher or lower after a rebuild. Entities of a few
  hundred memories are searched exactly.
- **Access writes can be lost.** With `trackAccess` on, search and context
  do not wait for the access write. On platforms that freeze the process once the
  response is sent (serverless functions), some writes may never run, so
  `accessCount` can undercount.

<a id="deleting"></a>

## Scopes

- **Reads cannot span agents.** A read at an entity scope without
  `agentId` sees only shared memories, never those an agent holds, so one
  call cannot list every agent's memories of an entity. `stats`,
  `listAuditLog` and `deleteScope` do cover all agents.
- **Deletes stay inside the scope.** `delete` with `dependents: "restore"`
  or `"delete"` throws `"CONFLICT"` when a memory consolidated into the
  survivor is not visible at the call's scope, and `prune` and
  `deleteScope` throw it when such a memory is outside the selection.
  Delete at a scope that sees every dependent, for example the agent's.
- **Moving a memory between scopes takes two calls.** `update` cannot
  change the scope; delete the memory and add it in the new scope.

## Maintenance

- **Duplicate search is approximate on large scopes.** On Postgres,
  `findDuplicates` takes each memory's nearest neighbors from the HNSW
  index when the scope is a large part of the table, and HNSW can miss a
  neighbor. For a small scope it reads the scope's rows for every memory,
  so its cost still grows with the square of the scope's size: on a test
  server, a 2,000-memory scope took 29 s and a 30,000-memory scope 149 s,
  in one statement that cannot be resumed. Run it from a background job,
  or page through it with `experimental.findDuplicatesPage`, which bounds
  each call and resumes from a cursor
  ([in pages](./api.md#in-pages-experimental)); on the same server the
  30,000-memory scope took 52 pages of about 1.3 s each.
  The in-memory backend is exact but compares every pair.
- **Audit pages across entities sort.** On Postgres, `listAuditLog` over a
  namespace or `allNamespaces` sorts every selected event for each page,
  because no index serves that order. Over 1,000,000 events a page took
  66 ms for a 100,000-event namespace and 330 ms for all namespaces,
  against 0.13 ms for one entity, which reads an index. Narrow a large log
  with `before` / `after`. A page filtered by `memoryId` reads its own
  index at any scope: under 0.2 ms for a few events, and 1–2 ms for a
  memory with 500, which a scoped page sorts.
- **Audit events stay until you prune them.** Nothing expires them on its
  own; schedule `pruneAuditLog` (see
  [retention](./api.md#retention)). On Postgres it deletes in batches that
  commit one by one, so an aborted or failed run leaves the earlier batches
  deleted and the rest in place.

## AI SDK tools

- **Saved memories are not deduplicated.** `saveMemory` has no `key`, so a
  model that saves the same fact twice stores two memories. Extraction
  (`save: { model }`) avoids this with keys; see
  [extraction](#extraction).
- **The model decides what is saved.** Content from the conversation,
  including a prompt injection, can be stored and come back in later
  searches and `context()` output for the same user. Memories it writes
  carry `source: "saveMemory"`; leave `saveMemory` out of the tool set, or
  require approval for it, where that matters.
- **`forgetMemory` reaches shared memories.** On a client bound to an
  `agentId` or `sessionId`, it can also delete the entity's memories shared
  by every agent or session, as `delete` can.

## Extraction

- **Only its own memories are updated.** Extraction upserts keys prefixed
  `extracted:`. A memory your app or `saveMemory` wrote is shown to the
  extraction model, so the fact is not stored again, but it is never
  changed: when that fact changes, the new version is stored next to the
  old one.
- **Matching depends on the model.** A changed fact updates in place only
  when the model reuses the key it sees. It sees up to 20 memories from a
  search for the user's message; a stored fact the search does not return
  can be stored again under a new key. A model that writes the value into
  the key (`lives_in_berlin`) makes a new key when the value changes;
  content that is only the key is skipped, but such a key with a real
  sentence is stored.
- **The model decides what is saved.** The extraction prompt tells it to
  save only what the user stated and never secrets, but a model can still
  get this wrong, and what the user writes, including a prompt injection,
  can be stored. Tool results and system messages are never shown to it.
- **It can be cut off.** Extraction runs after the response; on serverless
  platforms pass `waitUntil`, or the function may stop before it finishes.
  It costs one model call per response, plus an embedder call for the
  search and, when something is stored, one for the new memories.

## Providers

- **Timeouts need the embedder's help.** A timeout aborts the attempt's
  signal; the request stops only if your embedder forwards that signal.
- **`maxBatch` counts texts, not tokens.** `addMany` sends up to
  `maxBatch` (default 100) texts per request; long contents can pass a
  provider's per-request token limit (OpenAI: 300,000) and fail with a 400.
  Lower `maxBatch` when memories are long.
- **Long texts are cut by default.** `voyageEmbedder`, `cohereEmbedder` and
  `googleEmbedder` send `truncate: true` unless you set it to `false`, so a
  memory longer than the model's context (512 tokens for Cohere's v3
  models, 2,048 for `gemini-embedding-001`) is embedded from its start
  only, and search cannot match the rest. With `truncate: false` the
  request fails with a 400 instead.
- **No Vertex AI.** `googleEmbedder` calls the Gemini API with an API key.
  Vertex AI needs OAuth access tokens and another request shape; use
  `aiSdkEmbedder` with `@ai-sdk/google-vertex` for it.
- **Voyage, Cohere and Gemini waits are not read.** None of them documents
  a `Retry-After` header, so a 429 waits for the client's backoff, not for
  the provider's quota window.
- **Purpose hints are not part of the installation check.** Postgres checks
  the embedder's `model` and `dimensions`, not its `purposes`; changing the
  prefixes or body fields after memories are stored makes old and new
  vectors compare poorly, without an error.
- **Observability hooks are not awaited.** A slow async `onEvent` never
  delays a call, but a synchronous one still blocks while it runs, async
  work from consecutive events can overlap, and on serverless platforms it
  can be cut off when the function ends. Failures reach `onError` only if
  you set it.

## CommonJS

- **TypeScript needs `module: "node20"` or `"nodenext"`.** `require()`
  loads every entry on Node 22.18+, but Mnemocyte ships ES module types
  only. A CommonJS TypeScript project set to `node16` or `node18` fails
  to compile its `import` of `mnemocyte` with TS1479; `node20` and
  `nodenext` accept it.
- **`mnemocyte/ai-sdk` needs `ai` installed.** Without it, `require()`
  throws `ERR_MODULE_NOT_FOUND`, as `import` does. So does
  `mnemocyte/store/test` without `vitest`.
