# Limitations

Mnemocyte is pre-1.0. These are the current limits, what happens when you hit
them, and the [roadmap](../ROADMAP.md) item planned for each.

## Storage

- **One embedding model per Postgres installation.** A second model or
  dimension throws `"CONFIG"`, and mixed history throws `"MIGRATION"` until
  repaired ([postgres.md](./postgres.md#repair-mixed-models)).
- **At most 4,000 dimensions on Postgres.** Above 2,000 the schema stores
  embeddings as `halfvec` (16-bit floats), because pgvector's HNSW index on
  `vector` stops at 2,000; `halfvec` indexes stop at 4,000, and `migrate` and
  the renderer refuse larger sizes. Half precision is close to lossless for cosine
  ranking but not bit-for-bit equal to the vectors you sent.
- **Four drivers are built in.** postgres.js, a node-postgres `Pool`,
  PGlite, and Drizzle over one of them. A `pg.Client` and other Drizzle
  drivers throw `"CONFIG"`; anything else needs a hand-written `SqlExecutor`
  ([postgres.md](./postgres.md#bring-another-driver)). postgres.js 3.4.9+
  and 4.x both work; a reserved connection (`sql.reserve()`) throws
  `"CONFIG"`, because it cannot open a transaction.
- **node-postgres and PGlite cannot cancel a running query.** An aborted
  `signal` stops the next statement and the call rejects with `"ABORTED"`,
  but a statement already sent runs to the end. postgres.js cancels it on
  the server.
- **`migrate` needs interactive transactions and the `public` schema.** It
  runs each migration in a transaction, so HTTP drivers without one (Neon's
  HTTP driver) cannot run it; use a regular connection for migrating. The
  consolidation foreign key names `public.mnemocyte_memories`, so the tables
  must live in `public`.
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

## Retrieval

- **Keyword search differs by backend.** Postgres uses English full-text
  search (stemming, stop words); the in-memory store matches query words as
  substrings. Both fuse ranks the same way, but they can find different
  keyword matches, so results for the same data can differ.
- **Very selective filters cost more on Postgres.** The vector search keeps
  scanning the HNSW index until it has enough memories that pass the filters,
  up to pgvector's `hnsw.max_scan_tuples` (20,000 by default). A filter that
  matches fewer memories than requested on a large entity scans that many
  rows, and memories beyond that limit are not returned.
- **Vector search on a large entity is approximate on Postgres.** When the
  HNSW index is used, it can miss some of the nearest memories: on a test
  server with 132,000 memories at 1,536 dimensions, a 30,000-memory entity's
  search returned about 88% of the exact nearest rows, and about 60% with a
  `kinds` filter. Entities of a few hundred memories are searched exactly.
- **Access writes can be lost.** With `trackAccess` on, search does not wait
  for the access write. On platforms that freeze the process once the
  response is sent (serverless functions), some writes may never run, so
  `accessCount` can undercount.

## Deleting

- **Deletes stay inside the scope.** `delete` with `dependents: "restore"`
  or `"delete"` throws `"CONFLICT"` when a memory consolidated into the
  survivor is not visible at the call's scope, and `prune` and
  `deleteScope` throw it when such a memory is outside the selection.
  Delete at a scope that sees every dependent, for example the agent's.
- **Reads cannot span agents.** A read at an entity scope without `agentId`
  sees only shared memories, never those an agent holds; there is no way to
  list every agent's memories of an entity in one call. `stats`,
  `listAuditLog` and `deleteScope` do cover all agents.
- **Moving a memory between scopes takes two calls.** `update` cannot change
  the scope; delete the memory and add it in the new scope.
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
  can be stored again under a new key.
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
