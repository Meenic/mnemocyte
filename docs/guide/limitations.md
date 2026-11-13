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
- **Access writes can be lost.** With `trackAccess` on, search does not wait
  for the access write. On platforms that freeze the process once the
  response is sent (serverless functions), some writes may never run, so
  `accessCount` can undercount.
- **Queries and documents are embedded the same way.** The embedder is not
  told which one it is embedding, so providers with separate query and
  document modes cannot use them. Planned: `feat/embedder-purpose`.

## Deleting

- **Consolidation blocks deletes.** After a consolidation, `delete` and
  `prune` throw `"CONFLICT"` for the survivor until the superseded memories
  are deleted first (`prune({ scope, superseded: true })`). `deleteScope`
  is not blocked when the survivor and its dependents are deleted together.
  Planned: survivor-aware deletes (`feat/consolidate-stable`).
- **Reads cannot span agents.** A read at an entity scope without `agentId`
  sees only shared memories, never those an agent holds; there is no way to
  list every agent's memories of an entity in one call. `stats`,
  `listAuditLog` and `deleteScope` do cover all agents.
- **Moving a memory between scopes takes two calls.** `update` cannot change
  the scope; delete the memory and add it in the new scope.
- **Duplicate search compares every pair.** `findDuplicates` cost grows with
  the square of the scope's memory count. Planned: nearest-neighbor based
  search (`feat/consolidate-stable`).
- **The audit log grows forever.** Only `deleteScope` deletes audit events.
  Planned: a retention option (`feat/audit-retention`).

## AI SDK tools

- **Saved memories are not deduplicated.** `saveMemory` has no `key`, so a
  model that saves the same fact twice stores two memories. Planned:
  `feat/ai-sdk-extraction` decides how existing facts are matched.
- **The model decides what is saved.** Content from the conversation,
  including a prompt injection, can be stored and come back in later
  searches and `context()` output for the same user. Memories it writes
  carry `source: "saveMemory"`; leave `saveMemory` out of the tool set, or
  require approval for it, where that matters.
- **`forgetMemory` reaches shared memories.** On a client bound to an
  `agentId` or `sessionId`, it can also delete the entity's memories shared
  by every agent or session, as `delete` can.

## Providers

- **Timeouts need the embedder's help.** A timeout aborts the attempt's
  signal; the request stops only if your embedder forwards that signal.
- **`maxBatch` counts texts, not tokens.** `addMany` sends up to
  `maxBatch` (default 100) texts per request; long contents can pass a
  provider's per-request token limit (OpenAI: 300,000) and fail with a 400.
  Lower `maxBatch` when memories are long.
- **Purpose hints are not part of the installation check.** Postgres checks
  the embedder's `model` and `dimensions`, not its `purposes`; changing the
  prefixes or body fields after memories are stored makes old and new
  vectors compare poorly, without an error.
- **The observability hook is awaited.** A slow `onEvent` slows every
  operation. Planned: `fix/observability-non-blocking`.
