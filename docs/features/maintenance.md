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

`EXPLAIN (ANALYZE, BUFFERS)` on PGlite (Postgres 18, pgvector 0.8.7, WASM,
so only the ratios carry over), 6,000 memories of 1,536 dimensions, one
memory in ten a near-copy of another:

| Scope | Pairwise self-join (before) | kNN join | Pairs found |
|---|---|---|---|
| 2,000 memories | 32.8 s, 12.0M buffer hits | 7.4 s, 2.6M buffer hits (HNSW) | 200 of 200 |
| 100 memories | 70 ms | 152 ms (btree + top-N sort) | 10 of 10 |

The small scope is slower because every one of its 100 memories reads the
scope's rows again; it stays O(n²) in the scope size, at a size where that
is cheap. `test/contract/knn-duplicates-plan.test.ts` checks the HNSW plan
on PGlite. Numbers on a Postgres server are part of `chore/benchmarks`.

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
each dependent deleted with it. Writes are best-effort: a failed audit insert does not
fail the operation, except consolidation, where the same statement writes the
events.

`listAuditLog({ scope, limit = 50 })` selects events like a bulk operation
(an omitted agent or session matches any) and returns them newest first by
`(timestamp, id)`. Use `beforeCursor` / `afterCursor` (`{ timestamp, id }`)
for complete pagination; `before` / `after` are strict timestamp filters that
skip events sharing the boundary timestamp. Only `deleteScope` deletes events.

## `stats`

`stats({ scope })` or `stats({ allNamespaces: true })` returns
`entityCount` (distinct `(namespace, entityId)` pairs), `memoryCount`,
`activeMemoryCount` (neither expired nor superseded), `expiredMemoryCount`
and `supersededMemoryCount` for the selected memories, as one `MemoryStats`
type.
