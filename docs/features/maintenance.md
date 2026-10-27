# Maintenance: delete, prune, duplicates, consolidation, audit

## Deleting

- `forget({ entityId, memoryId })` deletes one memory owned by the entity;
  `"NOT_FOUND"` otherwise.
- `forgetAll({ entityId })` deletes every memory of the entity.
- Both reject with `"CONFLICT"` and delete nothing while any memory's
  `superseded_by` points at a selected memory, **including when that
  dependent is selected too**. After any consolidation, an entity can only be
  fully erased by deleting the superseded memories first (for example
  `prune({ entityId, superseded: true })`).

On Postgres the check and delete are one statement (a CTE that finds
candidates and dependents, then deletes only if there are none); the
`superseded_by` foreign key is the backstop for races.

## `prune`

Selectors (AND-combined): `entityId`, `expired`, `superseded`,
`createdBefore`, `notAccessedSince` (also matches never-accessed rows),
`types`, `tags` (all must match), `maxImportance` (at or below). At least one
effective selector is required; `false` flags and empty arrays do not count.
`dryRun: true` only counts.

Without `entityId` a prune runs across **every entity**: `prune({ types:
["fact"] })` deletes all facts in the installation.

A non-dry prune that would delete a consolidation survivor rejects with
`"CONFLICT"` and deletes nothing. With audit enabled, each affected entity
gets one `memory.pruned` event.

## `findDuplicates`

Returns memory pairs of one entity whose cosine similarity is at least
`threshold` (default 0.95), best first, up to `limit` (default 100). Filters:
`types`, `tags`, `includeSuperseded`, `includeExpired`. Postgres runs a
pairwise self-join; in-memory compares every pair. Both are O(n²) per entity.

## `experimental.consolidate`

`consolidate({ entityId, survivorId, supersededIds, mergeTags = true })`
marks each loser `superseded_by = survivorId`:

1. Shared validation: non-empty, distinct `supersededIds`, survivor not in
   the list.
2. Preflight: survivor exists and is not superseded (`"NOT_FOUND"` /
   `"VALIDATION"`), every loser exists (`"NOT_FOUND"`), none points to a
   different survivor (`"CONFLICT"`). Losers already pointing to this survivor
   are skipped, so retries are no-ops.
3. Store mutation. On Postgres it is one statement: a `WITH` query whose
   first step is `SELECT … FOR UPDATE` on survivor and losers in id order (a
   fixed lock order prevents deadlocks between concurrent consolidations).
   Later steps re-check the survivor and losers from those locked rows,
   update the losers, merge loser tags into the survivor's current tags
   (survivor tags first, then each loser's in request order), and insert
   `memory.superseded` audit events when audit is on. On a conflict no step
   writes anything and the store throws `"CONFLICT"`. No transaction stays
   open across round trips, and an abort cancels the statement even while it
   waits for a lock.

Superseded memories are excluded from recall, duplicates and context unless
`includeSuperseded` is set.

## Audit log

With `audit: { enabled: true }`, Mnemocyte records `memory.created`,
`memory.deleted`, `entity.cleared`, `memory.pruned` and `memory.superseded`.
Writes are best-effort: a failed audit insert does not fail the operation,
except consolidation, where the same statement writes the events.

`listAuditLog({ entityId, limit = 50 })` returns events newest first by
`(timestamp, id)`. Use `beforeCursor` / `afterCursor` (`{ timestamp, id }`)
for complete pagination; `before` / `after` are strict timestamp filters that
skip events sharing the boundary timestamp. Events are never pruned.

## `stats`

`stats({ entityId })` returns `memoryCount`, `activeMemoryCount` (neither
expired nor superseded), `expiredMemoryCount` and `supersededMemoryCount`.
Without `entityId` it returns the same counts for the whole installation plus
`entityCount`. The return type is a union, so callers narrow it themselves.
