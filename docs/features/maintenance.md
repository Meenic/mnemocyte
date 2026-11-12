# Maintenance: delete, prune, duplicates, consolidation, audit

## Deleting

- `delete({ scope, id })` deletes one memory visible at the scope;
  `"NOT_FOUND"` otherwise.
- `deleteScope({ scope })` deletes every selected memory and the selected
  audit events; see [scopes.md](./scopes.md#deletescope).
- `delete` and `prune` reject with `"CONFLICT"` and delete nothing while any
  memory's `superseded_by` points at a selected memory, **including when that
  dependent is selected too**. After a consolidation, a survivor can only be
  deleted by deleting the superseded memories first (for example
  `prune({ scope, superseded: true })`). `deleteScope` is the exception: it
  rejects only when the dependent is outside the selection.

On Postgres the check and delete are one statement (a CTE that finds
candidates and dependents, then deletes only if there are none); the
`superseded_by` foreign key is the backstop for races.

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

A non-dry prune that would delete a consolidation survivor rejects with
`"CONFLICT"` and deletes nothing. With audit enabled, each affected
`(namespace, entityId)` gets one `memory.pruned` event; its agent and session
are the selector's, or null when the selector left them out. Both stores
report per-entity counts ordered by namespace, then entity.

## `findDuplicates`

Returns pairs of memories visible at the scope whose cosine similarity is at
least `threshold` (default 0.95), best first, up to `limit` (default 100).
Filters: `kinds`, `tags`, `includeSuperseded`, `includeExpired`,
`exactAgent`, `exactSession`. Postgres runs a pairwise self-join with the
visibility conditions on both sides; in-memory compares every pair. Both are
O(n²) in the scope's memory count.

## `experimental.consolidate`

`consolidate({ scope, survivorId, supersededIds, mergeTags = true })` marks
each loser `superseded_by = survivorId`:

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
scope it belongs to. Writes are best-effort: a failed audit insert does not
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
