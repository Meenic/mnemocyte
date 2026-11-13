# API reference

Every client method, its options and the rules it enforces. Each method takes
one object parameter, and every method that can run long accepts
`signal: AbortSignal`. Failures are `MnemocyteError` with a stable `code`
(see [errors](#errors)). Upgrading from 0.5? See
[upgrading from 0.5](#upgrading-from-05).

## `createMemory`

```ts
import { createMemory } from "mnemocyte";

const memory = createMemory({
  embedder,                          // required, see embedders.md
  namespace: "my-app",               // optional; see Scopes
  store: sql,                        // optional; your database client, in-memory when omitted
  defaults: { limit: 10, minScore: 0 },
  retrieval: { /* see Retrieval tuning */ },
  provider: { /* see embedders.md */ },
  observability: { onEvent(event) {} },
  audit: { enabled: true },
});
```

Configuration is validated synchronously; invalid values throw `"CONFIG"`.
`store` is the database client your app already has (a postgres.js `sql`,
a `pg` Pool, a PGlite instance, a Drizzle instance over one of them, or a
`SqlExecutor`), recognised by its shape, or a store from `postgresStore()`.
A value that is none of these throws `"CONFIG"` right away. The Postgres
code loads on the first call that needs it. Without `store` the client
keeps memories in process memory, which suits tests and prototypes. For
persistent storage see [postgres.md](./postgres.md).

The client holds no connections or timers, so there is no `close()`: with
Postgres, the database client you passed in is yours to end, and the
in-memory store is garbage-collected with the client.

## `migrate`

```ts
import { migrate } from "mnemocyte";

const { applied, adopted, extensionCreated } = await migrate({
  memory,                 // the client from createMemory()
  createExtension: true,  // optional; enable pgvector if it is missing
  dryRun: false,          // optional; report what would happen, change nothing
  signal,                 // optional
});

// Without a memory client at hand, pass the database client and the
// dimensions instead:
await migrate({ store: sql, dimensions: 1536 });
```

Creates or upgrades the Postgres schema and records each migration in
`mnemocyte_migrations`. `applied` lists the migrations this call ran;
`adopted` lists those it found already applied in a schema installed without
`migrate` (with `psql` or drizzle-kit) and recorded without running;
`extensionCreated` says whether it ran `CREATE EXTENSION vector`. Calling
it again applies nothing. Each migration runs in its own transaction behind
an advisory lock, so concurrent calls from several app instances wait for
each other and apply every migration once. See
[postgres.md](./postgres.md#install-the-schema) for what each case does.

- Pass exactly one of `memory` and `store` (`"VALIDATION"` otherwise).
  With `memory`, the client's store is migrated and `embedder.dimensions`
  is the dimensions; a `dimensions` that differs from it throws `"CONFIG"`.
  With an in-memory client there is nothing to migrate.
- `dimensions` is an integer from 1 to 4,000. It is required when the
  database has no Mnemocyte tables (`"VALIDATION"` otherwise) and fixes the
  embedding column: `vector` up to 2,000, `halfvec` above. On an existing
  installation a different value throws `"CONFIG"` before anything runs.
- pgvector must be enabled before a fresh install. With
  `createExtension: true`, `migrate` runs `CREATE EXTENSION IF NOT EXISTS
  vector` when it is missing, in the same transaction as the schema. That
  needs a superuser or the provider's admin role; without it, or when the
  server does not have pgvector installed, it throws `"MIGRATION"` with a
  message naming the step, and nothing is created. Without the option a
  missing pgvector throws `"MIGRATION"`.
- `dryRun: true` reads the database in one read-only transaction and returns
  what a run would return, changing nothing (the extension included). It
  throws what a real run would throw before its first change; a migration
  that would fail partway through is only found by running it.
- A failing migration rolls back and throws `"MIGRATION"` with the driver
  error as `cause`; migrations that committed before it stay applied.
- A schema that matches no migration (for example a half-applied file run
  with plain `psql -f`) throws `"MIGRATION"` without changing anything.
- An abort cancels the running statement and rolls back the current
  migration.

## Scopes

Every read and write names a scope:

```ts
const scope = {
  namespace: "my-app",   // tenant or app; required
  entityId: "user_123",  // who or what the memory is about; required
  agentId: "support",    // who holds it; optional
  sessionId: "chat_42",  // short-lived context; optional
};
```

Each field is a non-empty string of at most 256 bytes in UTF-8; anything
else throws `"VALIDATION"`.

**Writes** (`add`, `addMany`) store the memory in exactly that scope. Leaving
out `agentId` makes the memory shared by every agent; leaving out
`sessionId` keeps it outside any session.

**Reads** (`search`, `get`, `list`, `context`, `findDuplicates`) and changes
by id (`update`, `delete`, `experimental.consolidate`) see the scope plus
shared memories:

| Scope of the call | Sees memories with |
|---|---|
| `{ namespace, entityId }` | no agent and no session |
| `+ agentId: "a"` | agent `a` or no agent; no session |
| `+ agentId: "a", sessionId: "s"` | agent `a` or none, and session `s` or none |

`exactAgent: true` drops the memories with no agent, and `exactSession: true`
those with no session. Another entity, another namespace or another agent is
never visible.

**Bulk operations** (`deleteScope`, `prune`, `stats`, `listAuditLog`) select
instead: a field that is set must match exactly, and an omitted `agentId` or
`sessionId` matches any value. So `deleteScope({ scope: { namespace,
entityId } })` erases the entity across every agent and session.

### Default namespace

`createMemory({ namespace })` sets a namespace for every call whose scope
leaves it out. A scope that names its own namespace wins, so a multi-tenant
app can still pass one per call:

```ts
const memory = createMemory({ namespace: "my-app", store, embedder });

await memory.add({ scope: { entityId: "user_123" }, content: "…" });
await memory.search({ scope: { namespace: "tenant_7", entityId: "u1" }, query: "…" });
await memory.stats({ scope: {} }); // the whole "my-app" namespace
```

The namespace follows the scope rules above; a malformed one throws
`"CONFIG"` from `createMemory`. With it set, `createMemory` returns a
`MemoryClient<true>`, whose scopes take an optional `namespace`. Without
it, TypeScript keeps `namespace` required, and a scope without one throws
`"VALIDATION"`. `allNamespaces: true` still reaches every namespace.

### Bound scopes

`memory.for(scope)` returns a client bound to one scope. Its methods are
the client's, without the `scope` field:

```ts
const user = memory.for({ entityId: user.id });            // namespace from the default
const agent = memory.for({ entityId: user.id, agentId: "support" });

await user.add({ content: "Prefers short, direct answers." });
const context = await agent.context({ query: message });
const { memories } = await user.list();
await user.deleteScope();                                  // erase the user
```

- Reads and changes by id follow the visibility rules above: `agent` sees
  the support agent's memories plus shared ones.
- `deleteScope`, `prune`, `stats` and `listAuditLog` select within the
  bound scope, where an omitted `agentId` or `sessionId` matches any
  value: `user.deleteScope()` erases the user across every agent and
  session.
- Methods whose options are all optional (`list`, `deleteScope`,
  `findDuplicates`, `listAuditLog`) can be called without an argument.
  `stats()` takes none.
- A bound client has no `allNamespaces` and no `for`. A `scope` or
  `allNamespaces` field passed from untyped code throws `"VALIDATION"`
  instead of being ignored, so a call cannot leave the bound scope.
- `for()` validates and copies the scope when it is called: a malformed
  scope, or one without a namespace on a client without a default, throws
  `"VALIDATION"` at once. `bound.scope` is the frozen copy.
- The bound client shares the parent's store, embedder and configuration,
  and `migrate({ memory })` accepts it. Creating one is cheap, so binding
  per request is fine.

## Memories

A memory has:

| Field | Type | Default |
|---|---|---|
| `content` | non-empty string | required |
| `key` | non-empty string, unique within the exact scope | `null` |
| `kind` | `"fact"`, `"preference"`, `"instruction"`, `"backstory"`, `"episode"`, `"session"` | `"fact"` |
| `importance` | `"low"`, `"normal"`, `"high"`, `"critical"` | `"normal"` |
| `tags` | `string[]` | `[]` |
| `source` | string | `null` |
| `metadata` | `JsonObject` | `{}` |
| `confidence` | number in `[0, 1]` | `1` |
| `expiresAt` | `Date` | none |

Stored records also carry `id`, `scope` (`{ namespace, entityId, agentId,
sessionId }`, with `null` for an omitted agent or session), `createdAt`,
`updatedAt`, `accessCount`, `lastAccessedAt`, `supersededBy`,
`supersededAt`, `embeddingModel` and `embeddingDimensions`. Ids are UUIDv7
strings.

`metadata` must be JSON data (`JsonObject` / `JsonValue` are exported).
`undefined`, functions, bigints, non-finite numbers, class instances and
cyclic objects throw `"VALIDATION"`. Tags, metadata and dates are copied when
you call a method, and returned records are copies, so later mutations on
either side change nothing.

## Input limits

Inputs past these sizes throw `"VALIDATION"` before the embedder or the
database is called, on every backend:

| Input | Limit |
|---|---|
| `content`, search and context `query` | 32,000 characters (`string.length`) |
| `key` | 512 bytes in UTF-8 |
| each scope field | 256 bytes in UTF-8 |
| `tags` (on a memory or in a filter) | 64 tags of at most 128 characters |
| `metadata` | 64 KiB as JSON (UTF-8), nested at most 32 levels |
| `limit` (`search`, `context`, `list`, `findDuplicates`, `listAuditLog`) | 1 to 1,000 |
| `addMany` | 1,000 memories per call |

32,000 characters is about 8,000 tokens, the input limit of common embedding
models. The key and scope limits keep the scope + key index entry within what
a Postgres btree index accepts.

## `add` and `addMany`

```ts
const preference = await memory.add({
  scope,
  content: "Likes concise answers.",
  kind: "preference",
  importance: "high",
  tags: ["communication"],
});

const added = await memory.addMany({
  scope,
  memories: [
    { content: "Likes concise answers." },
    { key: "language", content: "Writes TypeScript." },
  ],
  signal,
});
```

Input is validated before the embedder is called. `addMany` stores up to
1,000 memories in one scope and returns the records in input order. It calls
the embedder with at most `maxBatch` texts at a time (100 unless the
embedder sets it), one call after another, then
writes every memory in one transaction: when an embedder call or a write
fails, nothing is stored. Its `signal` covers the whole batch.

**Keys.** With a `key` that already exists in the exact scope, `add` updates
that memory instead of inserting one: content, kind, importance, tags,
source, metadata, confidence, expiry and the embedding are replaced (omitted
fields go back to their defaults), and `id`, `createdAt`, the access counts
and any consolidation link are kept. Use it to store facts that change, such
as a user's timezone, without duplicates:

```ts
await memory.add({ scope, key: "timezone", content: "Timezone is Europe/Berlin." });
await memory.add({ scope, key: "timezone", content: "Timezone is Asia/Tokyo." });
// one memory, same id, new content
```

Keys are unique per exact scope: the same key under another agent, session
or entity is a different memory. Concurrent adds with one key end in one
memory. A key may appear only once per `addMany` call (`"VALIDATION"`). With
audit enabled, an add that updated a memory is recorded as `memory.updated`.

## `search`

```ts
const results = await memory.search({
  scope,
  query: "How should I respond?",
  limit: 5,
  explain: true,
});
```

| Option | Default | Meaning |
|---|---|---|
| `limit` | `defaults.limit` or 10 | Maximum results; 1 to 1,000. |
| `minScore` | `defaults.minScore` or 0 | Drop results below this score; `[0, 1]`. |
| `kinds` | all | Only these kinds. |
| `tags` | none | Memories must have every listed tag. |
| `before`, `after` | none | Filter on `createdAt`. |
| `includeSuperseded` | `false` | Include memories replaced by consolidation. |
| `includeExpired` | `false` | Include memories past `expiresAt`. |
| `exactAgent`, `exactSession` | `false` | Leave out shared memories; see [scopes](#scopes). |
| `explain` | `false` | Attach a score breakdown to each result. |
| `trackAccess` | `retrieval.trackAccess` or `false` | Record access for this call's results. |

Search runs a vector search and a lexical (keyword) search, fuses the two
rankings and applies small recency and importance boosts (see
[retrieval tuning](#retrieval-tuning)). Each result carries `score` (0 to 1)
and `scores`, plus `explanation` when `explain` is set.

With access tracking on (`retrieval.trackAccess: true`, or `trackAccess` on
the call), search increments `accessCount` and sets `lastAccessedAt` on the
returned memories. The write starts as search returns and search does not
wait for it, so the returned records show the values from before this
search. If it fails, search still succeeds and `onEvent` receives a
`"trackAccess"` error event. Memories deleted in the meantime are skipped.
`updatedAt` never changes on search, and access counts do not affect ranking.
With tracking off, `accessCount` stays 0 and `lastAccessedAt` stays null.

## `get`

```ts
const byId = await memory.get({ scope, id: preference.id });
const byKey = await memory.get({ scope, key: "timezone" });
```

Returns the memory or `null`. By `id`, any memory visible at the scope is
found; by `key`, only the exact scope is searched, because that is where keys
are unique. Pass exactly one of `id` and `key` (`"VALIDATION"` otherwise).

## `list`

```ts
let cursor: string | undefined;
do {
  const page = await memory.list({ scope, limit: 50, cursor });
  for (const item of page.memories) {
    // ...
  }
  cursor = page.nextCursor ?? undefined;
} while (cursor);
```

Pages through the memories visible at the scope, newest first by
`createdAt`, then `id`. `limit` defaults to 50. `nextCursor` is an opaque
string, `null` on the last page; pass it back unchanged. A cursor stays
valid while memories are added or deleted, and a malformed one throws
`"VALIDATION"`. `list` accepts `kinds`, `tags`, `includeSuperseded`,
`includeExpired`, `exactAgent` and `exactSession`, and calls no embedder.

## `update`

```ts
await memory.update({
  scope,
  id: preference.id,
  content: "Likes concise answers with code samples.",
  tags: ["communication", "code"],
  expiresAt: null,
});
```

Changes the fields you pass and leaves the others. At least one field is
required. `content` re-embeds the memory; other fields do not call the
embedder. `key`, `source` and `expiresAt` accept `null` to clear them. The
scope cannot change: delete the memory and add it in the new scope.

- `"NOT_FOUND"` when no memory with that id is visible at the scope.
- `"CONFLICT"` when the new `key` is already used in the memory's scope.

The write is one statement, so a concurrent update or delete cannot leave a
half-applied change.

## `context`

```ts
const context = await memory.context({
  scope,
  query: "User communication preferences",
  format: "markdown",
  maxTokens: 500,
});
```

Runs a search and renders the results as a string to put in a prompt, or
returns `""` when no memory matches. It accepts search's `limit`, `minScore`, `kinds`, `tags`, `includeSuperseded`,
`includeExpired`, `exactAgent`, `exactSession` and `trackAccess`, plus:

- `format`: `"markdown"` (default), `"plain"` or `"xml"`. Memory content
  cannot break out of its block: Markdown and plain text use a fence longer
  than any run in the content, and XML escapes it. The query is not echoed
  into the output; it is already in your prompt.
- `maxTokens`: positive integer, default 1200. The result always fits; when
  memories are left out, a line says how many. If nothing fits, the result is
  part of that line or an empty string.
- `tokenCounter`: `{ count(text): number }`. The default estimates one token
  per four characters; pass your model's tokenizer for exact budgets.

## `delete` and `deleteScope`

```ts
await memory.delete({ scope, id: preference.id });

const { deletedCount } = await memory.deleteScope({
  scope: { namespace: "my-app", entityId: "user_123" },
});
```

`delete` removes one memory visible at the scope and throws `"NOT_FOUND"`
when there is none. It throws `"CONFLICT"` and deletes nothing while another
memory's `supersededBy` points at it; delete the superseded memories first.

`deleteScope` deletes every memory the scope selects, and the audit events
recorded for it, in one statement. An omitted `agentId` or `sessionId`
matches any value, so `{ namespace, entityId }` erases the entity across all
agents and sessions, which is what an erasure request needs; add `agentId` or
`sessionId` to clear only that agent's or session's memories (shared ones
stay). Consolidation links between deleted memories do not block it. It
throws `"CONFLICT"` and deletes nothing when a memory outside the selection
still points at one inside it. No audit event is recorded for the erasure;
log it yourself if you need a record.

## `prune`

```ts
const preview = await memory.prune({
  scope: { namespace: "my-app", entityId: "user_123" },
  notAccessedSince: new Date(Date.now() - 30 * 24 * 3600 * 1000),
  maxImportance: "normal",
  dryRun: true,
});
// { matchedCount, deletedCount, dryRun }
```

`prune` needs a scope selector or `allNamespaces: true`, not both:

- `scope: { namespace }` covers every entity in the namespace;
  `entityId`, `agentId` and `sessionId` narrow it, each matching exactly.
- `allNamespaces: true` covers the whole installation.

Then at least one of these selectors, combined with AND:

| Selector | Matches |
|---|---|
| `expired: true` | Past `expiresAt`. |
| `superseded: true` | Replaced by consolidation. |
| `createdBefore` | Created before the date. |
| `notAccessedSince` | Last accessed before the date; never-accessed memories count from `createdAt`. |
| `kinds` | Any of these kinds. |
| `tags` | Every listed tag. |
| `maxImportance` | At or below this importance. |

`false` flags and empty arrays do not count. Input without a scope or without
a selector throws `"VALIDATION"` and deletes nothing; to delete a whole
scope, use `deleteScope`. `dryRun: true` only counts.

A prune that would delete a consolidation survivor throws `"CONFLICT"` and
deletes nothing, including the other matches. A dry run reports such rows
without failing. With audit enabled, each affected entity gets one
`memory.pruned` event.

## `findDuplicates`

```ts
const pairs = await memory.findDuplicates({ scope, threshold: 0.95, limit: 50 });
for (const { a, b, similarity } of pairs) {
  // ...
}
```

Returns pairs of memories visible at the scope whose cosine similarity is at
least `threshold` (default 0.95), most similar first, up to `limit` (default
100). It accepts `kinds`, `tags`, `includeSuperseded`, `includeExpired`,
`exactAgent` and `exactSession`, and modifies nothing. It compares every
pair, so cost grows with the square of the scope's memory count; the
in-memory backend slows down noticeably past a few thousand memories.

## `experimental.consolidate`

```ts
const result = await memory.experimental.consolidate({
  scope,
  survivorId: survivor.id,
  supersededIds: [duplicate.id],
  mergeTags: true,
});
// { survivorId, supersededCount, supersededIds }
```

Marks each memory in `supersededIds` as replaced by the survivor and, by
default, adds their tags to the survivor. Superseded memories are left out of
search, list, context and duplicate search unless `includeSuperseded` is set.

- `supersededIds` must be non-empty and distinct, and must not contain the
  survivor (`"VALIDATION"`). The survivor must not itself be superseded
  (`"VALIDATION"`). Every id must be visible at the scope (`"NOT_FOUND"`).
- Repeating a call is a no-op for memories that already point to this
  survivor. A memory that points to a different survivor makes the whole call
  throw `"CONFLICT"`.
- The call is all-or-nothing: on any conflict no memory, tag or audit event
  changes. Concurrent calls are safe.
- While a memory points to the survivor, `delete` and `prune` cannot delete
  the survivor (see [`delete`](#delete-and-deletescope)).

Anything under `experimental` may change in a minor release.

## `listAuditLog`

Enable the audit log in the config:

```ts
const memory = createMemory({ embedder, audit: { enabled: true } });
```

Mnemocyte then records `memory.created`, `memory.updated`, `memory.deleted`,
`memory.pruned` (one per affected entity) and `memory.superseded`. Each event
carries the `scope` it belongs to.

```ts
const entity = { namespace: "my-app", entityId: "user_123" };
const page = await memory.listAuditLog({ scope: entity, limit: 100 });

const last = page.at(-1);
const next = last
  ? await memory.listAuditLog({
      scope: entity,
      limit: 100,
      beforeCursor: { timestamp: last.timestamp, id: last.id },
    })
  : [];
```

The scope selects like a bulk operation: `{ namespace, entityId }` lists the
whole entity, and `agentId` or `sessionId` narrow it. Events come newest
first; `limit` defaults to 50. Page with `beforeCursor` / `afterCursor`,
which include events that share a timestamp. `before` and `after` are strict
timestamp filters and skip every event at the boundary timestamp, so they can
lose events when used for paging.

Audit writes are best-effort: a failed audit write does not fail the
operation. Consolidation is the exception; its events commit or roll back
with it. Events are deleted only by `deleteScope`.

## `stats`

```ts
const entity = await memory.stats({
  scope: { namespace: "my-app", entityId: "user_123" },
});
const app = await memory.stats({ scope: { namespace: "my-app" } });
const all = await memory.stats({ allNamespaces: true });
// { entityCount, memoryCount, activeMemoryCount, expiredMemoryCount, supersededMemoryCount }
```

Counts the memories a scope selector (or `allNamespaces: true`) selects, with
the same matching as `prune`. Active means neither expired nor superseded.
`entityCount` counts distinct entities per namespace.

## Retrieval tuning

```ts
const memory = createMemory({
  embedder,
  retrieval: {
    fusion: { k: 60, vector: 1, lexical: 1 },
    boosts: { recency: 0.1, importance: 0.1 },
    recencyHalfLifeDays: 90,
    candidateMultiplier: 3,
    trackAccess: false,
  },
});
```

The values above are the defaults. Ranking uses reciprocal rank fusion
(RRF): each search returns a ranked list, and a memory scores
`weight / (k + rank)` in each list it appears in. Positions are compared, not
raw scores, so keyword and vector scores never have to share a scale.

- `fusion.vector`, `fusion.lexical`: how much each list counts. Set one to 0
  to turn that search off.
- `fusion.k`: larger values make rank differences matter less.
- `boosts.recency`, `boosts.importance`: scale the fused score up for newer
  memories (halving every `recencyHalfLifeDays`) and for higher importance
  (low 0, normal 0.5, high 0.8, critical 1). They multiply, so they reorder
  close matches but never lift a poor match. Set to 0 to turn one off.
- `candidateMultiplier`: each search fetches `limit × candidateMultiplier`
  memories before fusion.
- `trackAccess`: record `accessCount` and `lastAccessedAt` on search (see
  [search](#search)). `trackAccess` on a call overrides it.

`score` is between 0 and 1: 1 means first in both searches with full boosts;
a memory found by only one search scores at most 0.5. `confidence` and
`accessCount` do not affect ranking.

`scores` on each result has `vectorRank` and `lexicalRank` (1-based, `null`
when the memory is not in that list), `vector` (cosine similarity) and
`lexical` (the backend's keyword score; `ts_rank` on Postgres), each `null`
when not in that list, and `fused`, `recency` and `importance`, each between
0 and 1. With `explain: true`, `explanation` adds the effective `fusion` and
`boosts`, the `boostFactor` and `finalScore`.

Fusion weights, `k` and boosts must be finite and non-negative, and the two
fusion weights must not both be 0. Invalid values throw `"CONFIG"`.

## Errors

Every method throws `MnemocyteError`. Branch on `code`, never on the message;
`isMnemocyteError(error)` narrows an `unknown`. `cause` holds the underlying
driver or provider error when there is one.

```ts
import { isMnemocyteError } from "mnemocyte";

try {
  await memory.search({ scope, query });
} catch (error) {
  if (isMnemocyteError(error) && error.code === "TIMEOUT") {
    // retry later
  }
  throw error;
}
```

| Code | Thrown when |
|---|---|
| `CONFIG` | Invalid client configuration (including `namespace`), or the embedder (or `migrate`'s `dimensions`) does not match the Postgres installation. |
| `VALIDATION` | Invalid method input, including a missing or malformed scope. Nothing was embedded or stored. |
| `EMBEDDING` | The embedder threw or returned invalid vectors. A provider's error status throws a `ProviderError` with `status` and the response body as `cause` (see [embedders.md](./embedders.md#provider-errors)). |
| `TIMEOUT` | An embedder attempt exceeded `provider.timeoutMs`. |
| `ABORTED` | The caller's `AbortSignal` fired. |
| `NOT_FOUND` | A referenced memory is not visible at the scope. |
| `CONFLICT` | A delete or consolidation conflicts with a consolidation link, or an update's key is already used. |
| `MIGRATION` | Mnemocyte tables or columns are missing, the installation holds mixed models, or `migrate` could not apply a migration. |
| `DB` | Any other database failure. |

## Upgrading from 0.5

0.6 replaces the entity-only client with the scoped one in a single breaking
change. Memories written by 0.5 are in namespace `"default"` with no agent or
session, so pass `namespace: "default"` to keep reading them.

| 0.5 | 0.6 |
|---|---|
| `createMnemocyte(config)` | `createMemory(config)` |
| `MnemocyteClient`, `MnemocyteConfig` | `MemoryClient`, `MemoryConfig` |
| `remember({ entityId, … })` | `add({ scope, … })` |
| `rememberMany({ inputs })` / `rememberMany(inputs)` | `addMany({ scope, memories })`, one scope per call |
| `recall({ entityId, … })` | `search({ scope, … })` |
| `buildContext({ entityId, … })` | `context({ scope, … })`; the query is no longer echoed |
| `forget({ entityId, memoryId })` | `delete({ scope, id })` |
| `forgetAll({ entityId })` | `deleteScope({ scope })`; also deletes the scope's audit events |
| `prune({ entityId?, … })` | `prune({ scope, … })` or `prune({ allNamespaces: true, … })`, plus a selector besides the scope |
| `findDuplicates`, `listAuditLog`, `experimental.consolidate` with `entityId` | the same methods with `scope` |
| `stats({ entityId })` / `stats()` | `stats({ scope })` / `stats({ allNamespaces: true })`, one `MemoryStats` type |
| `type`, `types`, `MemoryType` | `kind`, `kinds`, `MemoryKind` |
| `memory.entityId`, `event.entityId` | `memory.scope.entityId`, `event.scope.entityId` |
| `close()` | removed; end your own database client |
| `"entity.cleared"` audit event | none; `deleteScope` deletes the audit events |
| observability operations `remember`, `recall`, `buildContext`, `forget`, `forgetAll`, `close` | `add`, `search`, `context`, `delete`, `deleteScope`; no `close` |
