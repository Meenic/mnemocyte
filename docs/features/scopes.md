# Scopes, keys and the client surface

How the scoped client is built: scope matching, the default namespace and
bound clients, keyed upserts, `get`, `list`, `update`, `deleteScope` and
the client lifecycle. The user-facing
rules are in [guide/api.md](../guide/api.md#scopes).

## Scope

A memory belongs to a scope (`MemoryScope` in `src/types.ts`):

```ts
interface MemoryScope {
  namespace: string;   // tenant or app; required
  entityId: string;    // who or what the memory is about; required
  agentId?: string;    // who holds it; omitted = shared by every agent
  sessionId?: string;  // short-lived context; omitted = outside any session
}
```

`entityId` is who a memory is about and `agentId` who holds it (ARCHITECTURE
decision 17). `validateScope` (`memory/validation.ts`) checks each field is a
non-empty string and returns a detached `StoreScope` with `null` for an
omitted agent or session. Records carry that `scope` (`MemoryRecordScope`).

Two matching rules, both in `memory/filters.ts` (in-memory) and
`db/queries/memories.ts` (Postgres):

- **Visibility** (`StoreVisibility`, `visibilityConditions`): reads and writes
  by id match the namespace and entity, and for each optional field the
  scope's value or null (shared). A null field in the scope matches only null
  rows. `exactAgent` / `exactSession` drop the null alternative. Used by
  `search`, `get` by id, `list`, `context`, `findDuplicates`, `update`,
  `delete`, `consolidate` and the access write.
- **Selection** (`StoreSelector`, `selectorConditions`): bulk operations match
  each field that is set exactly and ignore the rest; a null namespace is
  `allNamespaces: true`. Used by `deleteScope`, `prune`, `stats`,
  `listAuditLog` and `pruneAuditLog`. Selecting `{ namespace, entityId }` therefore reaches every
  agent and session, which an erasure needs.

Keys are unique per *exact* scope, so `get` by key and the upsert match with
null fields as `IS NULL`, never shared.

On Postgres every visibility query is `namespace = $ AND entity_id = $ AND
(agent_id = $ OR agent_id IS NULL) AND …`; the scope btree
`(namespace, entity_id, agent_id, session_id)` serves it (an `OR` on the third
column becomes a bitmap or a filter on the entity's rows).

## Default namespace and bound clients

`createMemory` builds two layers (`memory/scope-binding.ts`) over the core
client from `memory/client-core.ts`, which only ever sees full scopes:

- **`createScopedClient`** is what `createMemory` returns. Each method
  fills `createMemory({ namespace })` into the input's `scope` when the
  scope is an object whose `namespace` is `undefined`, then calls the core
  method. The input is copied only when the namespace changes, so the
  caller's objects are never mutated. Anything else (no scope, a
  non-object, `allNamespaces: true`) passes through for the core's
  validation to accept or reject as before. Without a default the layer
  changes nothing.
- **`bindScope`** backs `for(scope)`. It fills the default, runs
  `validateScope` (so a bad scope throws `"VALIDATION"` synchronously from
  `for()`) and keeps a frozen `MemoryScope`, exposed as `bound.scope`.
  Each bound method checks that its input is an object (an omitted optional
  input becomes `{}`) with no `scope` and no `allNamespaces`, then calls the
  core with `{ ...input, scope }`. Selector methods (`deleteScope`,
  `prune`, `stats`, `listAuditLog`, `pruneAuditLog`) get the same scope, which they read as a
  selector: an omitted agent or session matches any value.

A rejected bound input goes through `observe` with the bound scope's
namespace and entity, so it emits the start and error events every other
malformed call emits. Calls that pass the check emit the core's events,
which read the filled-in scope, so `onEvent` always reports the namespace
actually used.

Both layers attach the client internals (store and embedder, under the
`Symbol.for("mnemocyte.memory-client")` key) with
`attachMemoryClientInternals`, which is how `migrate({ memory })` reads a
bound client. A bound client holds nothing else, so `for()` per request
costs one validation and two small objects.

Types: `MemoryClient`, `ExperimentalMemoryClient` (whose only member is the
deprecated `consolidate` alias) and every input with a
scope take `DefaultNamespace extends boolean = false`. `ScopeInput<true>` is
`OptionalNamespaceScope` and `ScopeSelectorInput<true>` is
`OptionalNamespaceSelector`; with `false` they are `MemoryScope` and
`ScopeSelector`. `createMemory` has two overloads: a config with
`namespace: string` returns `MemoryClient<true>`, any other
`MemoryClient`. Bound inputs are `Omit<…, "scope">` aliases, except
`BoundGetInput`, which `GetInput` is built from because `Omit` does not
distribute over its id-or-key union, and `prune`, which takes
`PruneSelectors`. `MigrateInput.memory` is
`MemoryClient<boolean> | BoundMemoryClient`.

## Keyed `add`

`createStoredMemory` copies `key` into the prepared row. The Postgres insert
is one statement:

```sql
INSERT INTO mnemocyte_memories (…) VALUES (…), (…)
ON CONFLICT (namespace, entity_id, agent_id, session_id, key)
  WHERE key IS NOT NULL
  DO UPDATE SET content = EXCLUDED.content, …, updated_at = EXCLUDED.updated_at
RETURNING …
```

- The conflict target repeats the partial index's predicate
  (`WHERE key IS NOT NULL`); Postgres infers a partial unique index as the
  arbiter only when the statement's predicate implies the index's. The index
  is `NULLS NOT DISTINCT`, so two rows with a null `agent_id` and the same key
  collide.
- `ON CONFLICT DO UPDATE` guarantees an insert or an update for each row even
  under concurrency, so parallel adds with one key end in one row. The
  integration test runs five at once.
- One statement may not update the same row twice (a cardinality violation),
  so `assertDistinctKeys` rejects a repeated key in one `addMany` with
  `"VALIDATION"` before the embedder runs.
- The update replaces content, kind, importance, tags, source, metadata,
  confidence, embedding and model, expiry and `updated_at`; it keeps `id`,
  `created_at`, the access counts and `superseded_by`.
- `RETURNING` does not say whether a row was inserted or updated.
  `matchInsertResults` (`memory/client-core.ts`) maps each returned row back to
  its input by id (inserted rows keep the prepared id) or by key (updated rows
  carry the existing id), rejects unknown or missing rows, and reports
  `created`, which picks the audit event: `memory.created` or
  `memory.updated`.

The embedder runs before the statement, outside any transaction, as for every
write. Scope fields are capped at 256 bytes and keys at 512 bytes in UTF-8
(`memory/limits.ts`), so the scope + key btree entry (five text columns)
stays well under the roughly one-third-of-a-page limit Postgres puts on an
index entry; without the caps a long key failed with a `"DB"` error from the
index.

## `get`

By id: the visible row with that id, or `null` (non-UUID ids return `null`
without a query). By key: the exact scope only. Exactly one of the two.

## `list`

Keyset pagination, newest first by `(created_at, id)`:

```sql
SELECT … FROM mnemocyte_memories
WHERE <visibility and filters>
  AND (date_trunc('milliseconds', created_at), id) < ($cursorTime, $cursorId)
ORDER BY date_trunc('milliseconds', created_at) DESC, mnemocyte_memories.id DESC
LIMIT $limit + 1
```

- The client asks for one extra row to know whether a next page exists, so
  an exact last page ends with `nextCursor: null`.
- The cursor (`memory/cursor.ts`) is base64url of
  `[createdAt ISO string, id]`, opaque to callers. Decoding rejects anything
  that is not two strings with a valid date and a UUID (`"VALIDATION"`).
- `created_at` is truncated to milliseconds because the cursor carries a JS
  `Date`. Rows written by the column default `now()` (for example by a
  migration or a manual insert) carry microseconds, and comparing them with a
  millisecond cursor would skip rows in the same millisecond. The integration
  test sets sub-millisecond times and pages one row at a time.
- `id` breaks ties within a millisecond, so the order is total and a cursor
  stays valid while rows are added or deleted. The `ORDER BY` names the
  table's `id`, because the select list's `id::text AS id` would otherwise
  sort by the text.
- Ids converted from 0.x text ids are md5 hashes, not time-ordered, which is
  why the order uses `created_at` first rather than the UUIDv7 id alone.

No index serves the order. Measured with `pnpm bench:postgres` on Postgres
18.6 / pgvector 0.8.7 (dataset in
[postgres.md](./postgres.md#indexes-measured): 132,000 memories, one entity of
30,000, rows of all entities interleaved in the heap), pages of 50:

| Page | Plan | Time |
|---|---|---|
| 100-memory entity, first page | scope index scan, quicksort | 0.26 ms, 102 buffers |
| 30,000-memory entity, first page | bitmap scan on the scope index, top-N heapsort | 37 ms, 8,975 buffers |
| 30,000-memory entity, page at row 15,000 | same, half the rows filtered by the cursor | 29 ms, 8,903 buffers |

The large entity's 30,000 rows lie on about 8,900 heap pages, because an
application writes for every user at once; the bitmap scan reads all of
them. (An earlier measurement found 914 buffers on data loaded one entity
at a time, which kept each entity's rows together.)

No index can serve this order as written: `date_trunc` on a `timestamptz`
depends on the session time zone, so Postgres does not accept it in an
index, and a `(…, created_at, id)` index does not match
`date_trunc('milliseconds', created_at)`. Serving large-entity pages from an
index would mean ordering by the raw `created_at` and a cursor with
microseconds; listing is an administrative read, so that waits until an
application needs faster pages over very large entities.

## `update`

`validateUpdateFields` requires at least one field. A `content` change checks
embedding compatibility and embeds the new text first; the patch then goes
to the store as one `UPDATE … WHERE <visibility> AND id = $ RETURNING …`, so
the content and its embedding always change together. Tags are normalized as
on `add`. A new key that collides fails with SQLSTATE `23505` on
`mnemocyte_memories_scope_key_idx`, mapped to `"CONFLICT"`; the in-memory
store checks the same before writing. No visible row: `null`, then
`"NOT_FOUND"`. The audit event `memory.updated` lists the changed field
names.

## `deleteScope`

One statement on Postgres, the guarded delete (see
[maintenance.md](./maintenance.md#deleting)) with two differences:

- The dependents check counts only memories *outside* the selection, so a
  survivor and its superseded memories are deleted together. The
  `superseded_by` foreign key is `NO ACTION`, checked at the end of the
  statement, when neither row exists.
- A data-modifying CTE deletes the selected audit events in the same
  statement, guarded by the same check, so the memories and their events go
  together or not at all.

It records no audit event: one would bring the erased entity id back.

## Lifecycle

The client has no `close()` (ARCHITECTURE decision 19). Since the
`SqlExecutor` change the caller owns the database client and Mnemocyte holds
no connections or timers, so there is nothing to release; the in-memory
store is garbage-collected with the client. `MemoryStore.close` and the
client's open/closing/closed state machine are gone with it.

Access writes from tracked searches start before `search` resolves (see
[retrieval.md](./retrieval.md#access-tracking)), so a caller that ends its
database client right after a search still gets the write.

## Observability

Every operation's events carry the `namespace` and `entityId` of its scope,
read from the raw input (after the default namespace is filled in, or from
the bound scope) so a malformed call still reports them. Operations
are `add`, `addMany`, `search`, `get`, `list`, `update`, `delete`,
`deleteScope`, `context`, `prune`, `findDuplicates`, `listAuditLog`,
`pruneAuditLog`, `consolidate`, `stats` and `trackAccess`.

## Tests

`test/fixtures/scoped-api.ts` runs on both backends
(`test/memory/scoped-api.test.ts`, `test/integration/scoped-api.test.ts`):
visibility and selection across agents, sessions, entities and namespaces;
keyed adds, including mixed batches and five concurrent adds with one key;
the created/updated audit events; list paging, filters, deletes between
pages and malformed cursors; updates with and without re-embedding and key
collisions; `get` and scope validation on every method. The Postgres file
adds microsecond `created_at` paging and the audit-event deletion of
`deleteScope`.

`test/fixtures/bound-scope.ts` runs on the in-memory backend
(`test/memory/bound-scope.test.ts`) and in the Postgres contract suite: the
default namespace and its override, visibility and isolation between bound
clients, selection for `stats`, `prune`, `listAuditLog` and
`deleteScope`, rejected `scope` and `allNamespaces` fields, `for()`
validation and `migrate({ memory })` with a bound client. The unit file adds
the `"CONFIG"` check on `namespace`, observation events, input snapshots
and `consolidate`; `test/package/exports-types.test-d.ts` checks the
overloads and the bound types.
