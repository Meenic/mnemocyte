# Maintenance: delete, prune, duplicates, consolidation, audit

## Deleting

- `delete({ scope, id, dependents = "reject" })` deletes one memory visible
  at the scope; `"NOT_FOUND"` otherwise. Its dependents are the memories
  whose `superseded_by` points at it (it is their consolidation survivor),
  and `dependents` says what happens to them:
  - `"reject"`: `"CONFLICT"` when there is any; nothing is deleted.
  - `"restore"`: their `superseded_by` and `superseded_at` are cleared and
    `updated_at` set, so they are active again. Only direct dependents
    change; memories consolidated into a dependent keep pointing at it.
  - `"delete"`: they are deleted too, and transitively whatever was
    consolidated into them (a dependent can itself be a survivor: a
    consolidation does not check whether a loser has dependents).

  With `"restore"`, a direct dependent, and with `"delete"`, any memory in
  the tree that is not visible at the call's scope makes the call throw
  `"CONFLICT"` and change nothing: a delete never touches memories the
  caller cannot see. That happens when a survivor shared by every agent has
  a loser that belongs to one agent.
- `deleteScope({ scope })` deletes every selected memory and the selected
  audit events; see [scopes.md](./scopes.md#deletescope).
- `prune` and `deleteScope` reject with `"CONFLICT"` and delete nothing while
  a memory **outside** the selection points at a selected one. A survivor
  selected together with all its dependents is deleted with them.

On Postgres each of these is one statement. `"reject"`, `prune` and
`deleteScope` use the guarded delete: a CTE finds the candidates and any
dependent outside them, then deletes only if there is none. `"restore"` is
one `WITH` that updates the direct dependents and deletes the memory;
`"delete"` is a `WITH RECURSIVE` that collects the tree and deletes it. The
`superseded_by` foreign key is `NO ACTION`, so Postgres checks it at the end
of the statement, after the update or with the whole tree gone; it is also
the backstop for a consolidation that adds a dependent concurrently, whose
violation becomes `"CONFLICT"`.

## `prune`

`prune` needs a scope selector (`scope: { namespace, entityId?, agentId?,
sessionId? }`, set fields matching exactly) or `allNamespaces: true`, not
both (`validateSelectorInput`). Then selectors, AND-combined: `expired`,
`superseded`, `createdBefore`, `notAccessedSince` (last access before the
date; a never-accessed memory counts from `createdAt`, so a new one is kept),
`kinds`, `tags` (all must match), `maxImportance` (at or below). At least one
of them is required besides the scope; `false` flags and empty arrays do not
count. A prune of a whole scope with no other selector is `deleteScope`'s
job. `dryRun: true` only counts.

A non-dry prune that would delete a consolidation survivor while one of its
dependents stays rejects with `"CONFLICT"` and deletes nothing. With audit enabled, each affected
`(namespace, entityId)` gets one `memory.pruned` event; its agent and session
are the selector's, or null when the selector left them out. Both stores
report per-entity counts ordered by namespace, then entity.

## `findDuplicates`

Returns pairs of memories visible at the scope whose cosine similarity is at
least `threshold` (default 0.95), where one memory is among the other's
`neighbors` nearest (default 10, at most 100), best first, then by ids, up to
`limit` (default 100). Each pair comes once, with the smaller id as `a`.
Filters: `kinds`, `tags`, `includeSuperseded`, `includeExpired`,
`exactAgent`, `exactSession`, applied to both memories of a pair.

The threshold applies after the neighbors are chosen: a pair above it is
missed when both memories have `neighbors` closer memories. A memory with
more near-copies than `neighbors` still pairs with the closest ones, and
consolidating them shrinks the cluster.

On Postgres it is a k-nearest-neighbor join: for each memory `a` that passes
the filters, a `LATERAL` subquery orders the memories `b` that pass them by
`b.embedding <=> a.embedding` and takes `neighbors`. Pairs are keyed by
`LEAST`/`GREATEST` of their ids, merged, cut to `limit`, and joined back to
their rows. It runs after `set_config` of `hnsw.iterative_scan =
strict_order` and `hnsw.ef_search` for `neighbors + 1` rows, in one `batch`
or transaction, like recall. Postgres picks the plan per scope:

- When the scope is a large part of the table, each `a` gets one HNSW index
  scan (`Index Scan using mnemocyte_memories_embedding_hnsw_idx`,
  `Order By: (embedding <=> a.embedding)`). HNSW is approximate, so a pair
  can be missed.
- For a small scope, it reads the scope's rows through the scope btree and
  keeps the nearest with a top-N sort, which is exact.

`EXPLAIN (ANALYZE, BUFFERS)` on a Postgres 18.6 / pgvector 0.8.7 server
with `pnpm bench:postgres` (the dataset and server are in
[postgres.md](./postgres.md#indexes-measured): 132,000 memories, one memory
in ten a near-copy of another, default settings with 128 MB of
`shared_buffers`). "Exact" runs the same statement with index scans off:

| Scope (of 132,000) | Plan | Time | Pairs found (exact) |
|---|---|---|---|
| 100 memories | scope btree + top-N sort per memory | 50 ms | 10 (10) |
| 2,000 memories | scope btree + top-N sort per memory | 29 s, 26M buffer hits | 200 (200) |
| 2,000 memories, scope index dropped | HNSW per memory | 52 s, 8.1M buffers read from disk | 189 (200) |
| 30,000 memories | HNSW per memory | 149 s, 25M buffers read from disk | not measured |
| 2,000 of 42,000 at 3,072 dimensions | scope btree + top-N sort per memory | 29 s | 200 (200) |

Below a few thousand memories the planner reads the scope's rows for every
memory, which is exact and O(n²): at 2,000 memories that is 4 million
distances, each over a vector read from TOAST. Forcing HNSW there was slower
and missed pairs, so the planner's choice is right. For the large scope each
memory gets an HNSW scan; the 1 GB index does not fit in 128 MB of
`shared_buffers`, so most of the 149 s is reads. A server whose cache holds
the index would be faster; on any server `findDuplicates` over a large scope
is a background job of minutes, not a request-time call. On PGlite (WASM,
6,000 memories) the 2,000-memory scope took the HNSW path (7.4 s), which is
why the plan test there forces a large share of the table.
`test/contract/knn-duplicates-plan.test.ts` checks the HNSW plan on PGlite.

In-memory computes the exact `neighbors` nearest for each memory, ties by
id, so both backends follow the same rules; HNSW recall is the only
difference.

## `consolidate`

`consolidate({ scope, survivorId, supersededIds, mergeTags = true })` marks
each loser `superseded_by = survivorId`. It graduated from `experimental` in
0.8 with the same behavior; `experimental.consolidate` on unbound and bound
clients is a deprecated alias of it, removed in 1.0. It runs in three
steps:

1. Shared validation: a valid scope, non-empty, distinct `supersededIds`,
   survivor not in the list.
2. Preflight: survivor visible and not superseded (`"NOT_FOUND"` /
   `"VALIDATION"`), every loser visible (`"NOT_FOUND"`), none points to a
   different survivor (`"CONFLICT"`). Losers already pointing to this
   survivor are skipped, so retries are no-ops.
3. Store mutation. On Postgres it is one statement: a `WITH` query whose
   first step is `SELECT … FOR UPDATE` on survivor and losers in id order (a
   fixed lock order prevents deadlocks between concurrent consolidations).
   Later steps re-check the survivor and losers from those locked rows,
   update the losers, merge loser tags into the survivor's current tags
   (survivor tags first, then each loser's in request order), and insert
   `memory.superseded` audit events, in the caller's scope, when audit is
   on. On a conflict no step writes anything and the store throws
   `"CONFLICT"`. No transaction stays open across round trips, and an abort
   cancels the statement even while it waits for a lock.

Superseded memories are excluded from search, list, duplicates and context
unless `includeSuperseded` is set.

## Audit log

With `audit: { enabled: true }`, Mnemocyte records `memory.created`,
`memory.updated` (a keyed add that updated a memory, or `update`),
`memory.deleted`, `memory.pruned` and `memory.superseded`, each with the
scope it belongs to. `delete` records one `memory.deleted` per deleted
memory: `{ memoryId }` for the one asked for, with `restoredIds` when
`dependents: "restore"` restored any, and `{ memoryId, deletedWith }` for
each dependent deleted with it.

Events are written atomically with the write they record, for every write
path: a failed audit write fails the call (`"DB"` on Postgres) and leaves
no memory changed and no event written. Each event's timestamp is the
write's own time, which for `add`, `addMany` and `update` equals the
memory's `updatedAt`.

- **Postgres.** Each write is one statement whose `WITH` adds an `audit`
  step: an `INSERT INTO mnemocyte_events … SELECT` over the write's
  `RETURNING` (`written`, `updated`, `deleted`, `restored`, `superseded`).
  Steps of one `WITH` share a snapshot and always run to completion, and
  `RETURNING` is how one passes rows to another, so the events describe
  exactly the rows written. A keyed `add` is `memory.created` when the
  returned id is the one generated for the row and `memory.updated` when
  the upsert kept an existing memory's id (Postgres 17 has no
  `RETURNING OLD`). `addMany` writes each chunk's events in that chunk's
  statement, and the chunks commit together. With audit off the
  statements have no `audit` step. See
  [postgres.md](./postgres.md#ids) for event ids.
- **In-memory.** The store builds every event (`src/memory/audit.ts`)
  after its checks and adds them in the same synchronous step as the
  change, with no `await` in between.

The payload builders in `src/memory/audit.ts` and the SQL in
`src/db/queries/memories.ts` must agree; the `atomic-audit` fixture runs
every path on both backends and compares the events, and the Postgres
contract makes audit inserts fail with a trigger to check that every path
rolls back.

`listAuditLog({ scope, limit = 50 })` selects events like a bulk operation
(an omitted agent or session matches any) and returns them newest first by
`(timestamp, id)`. Use `beforeCursor` / `afterCursor` (`{ timestamp, id }`)
for complete pagination; `before` / `after` are strict timestamp filters that
skip events sharing the boundary timestamp. `deleteScope` and
`pruneAuditLog` delete events.

### Retention

`pruneAuditLog({ scope | allNamespaces: true, before, batchSize = 1000,
dryRun })` deletes the selected events strictly before `before`
(`validatePruneAuditLogInput`: a selector as `prune` takes it, a valid
`before`, `batchSize` 1 to 10,000). It is an explicit method that apps
schedule, not a config option applied on writes (ARCHITECTURE decision 32).
It records no event of its own; observability reports the deleted count.
`dryRun` counts with one `count(*)`.

- **Postgres.** A loop of statements (`deleteEventsBatch` in
  `src/db/queries/events.ts`), each committing on its own: a materialized
  CTE selects up to `batchSize` events in `mnemocyte_events_scope_time_idx`
  order, the delete joins on their primary key (`DELETE` has no `LIMIT`),
  and the statement returns the batch's last `(namespace, entity_id,
  timestamp, id)`. The next batch resumes after it with a row comparison
  over the index columns that follow the selector's equalities:
  `(timestamp, id)` in an entity, `(entity_id, timestamp, id)` in a
  namespace, all four across namespaces. The timestamp travels as text
  with microseconds, since a `Date` would cut it to milliseconds. The loop
  ends at a batch that selects fewer than `batchSize` events, and checks
  the signal before each batch, so an abort keeps what earlier batches
  deleted. The primary key is used rather than `ctid`, which the Postgres
  docs call safe in this pattern only because the query re-runs; events
  are never updated, but the id needs no such argument.
- **In-memory.** One synchronous pass over the log, so `batchSize` changes
  nothing.

Batches resume instead of starting over because a deleted row's index
entry stays until vacuum: a batch that starts from the beginning of the
range walks every entry the batches before it deleted, which makes a run
quadratic in its backlog. A row comparison that starts at `namespace` next
to `namespace = $1` did not bound the scan either, hence the narrower row.
Measured with `pnpm bench:postgres` on a Postgres 18.6 server (see
[postgres.md](./postgres.md#indexes-measured)): 1,000,000 events appended
in time order over 180 days across 10 namespaces of 100 entities, `before`
90 days ago, batches of 1,000. The middle batch is measured with
`EXPLAIN (ANALYZE, BUFFERS)` in a rolled-back transaction just before it
runs, so it sees the dead index entries of the batches before it:

| Selection (old events) | Whole run | Middle batch |
|---|---|---|
| all namespaces (500,000) | 7.9 s, 500 batches | 7.9 ms, 7,033 buffers |
| one namespace (50,000) | 1.0 s, 51 batches | 5.7 ms, 7,032 buffers |
| one entity (500) | 0.08 s, 1 batch | 2.8 ms, 3,511 buffers |

Every batch is one `Index Only Scan` of `mnemocyte_events_scope_time_idx`
with `Index Searches: 1`: one descent to the previous batch's last event,
then 1,000 entries in order, with no sort (1.5 ms). Most of a batch is the
delete: 1,000 primary-key lookups and heap deletes (about 5 ms, 6,000 of the
7,033 buffers). The run takes about 16 ms per batch with the round trip and
the commit of each batch. The only sort in the plan picks the batch's last
row out of its 1,000.

The restarting design was measured on PGlite only (Postgres 18 in WASM, so
only the ratios carry over): with all namespaces selected it took 8.4 s
against 3.4 s for keyset batches, and its middle batch read its first row
after 7.9 ms against 0.03 ms, because it walked the dead entries of every
earlier batch. `test/contract/audit-retention.test.ts` checks the plan on
PGlite: each scope's batches read the scope index from the previous
position, with no sort and no sequential scan.

**No `(timestamp)` index.** On the server, with one, the planner still reads
the scope index for keyset batches (the same plan, 6.4 ms for the middle
batch), and the whole all-namespaces run took 8.7 s against 7.9 s without
it, within the noise. On PGlite with 200,000 events it helped only the
restarting design (0.35 s against 0.85 s), and keyset batches read about
12% more buffers per batch than the time index would. The index would cost
4.5 MB per 200,000 events (12% of the heap) and one more btree insert on
every audited write, for a job that runs once a day; a scheduled run that
deletes one day of events is a few batches on any of these plans.

## `stats`

`stats({ scope })` or `stats({ allNamespaces: true })` returns
`entityCount` (distinct `(namespace, entityId)` pairs), `memoryCount`,
`activeMemoryCount` (neither expired nor superseded), `expiredMemoryCount`
and `supersededMemoryCount` for the selected memories, as one `MemoryStats`
type.
