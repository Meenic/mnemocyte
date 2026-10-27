# API reference

Every client method, its options and the rules it enforces. Each method takes
one object parameter, and every method that can run long accepts
`signal: AbortSignal`. Failures are `MnemocyteError` with a stable `code`
(see [errors](#errors)).

## `createMnemocyte`

```ts
import { createMnemocyte } from "mnemocyte";

const client = createMnemocyte({
  embedder,                          // required, see embedders.md
  store,                             // optional; in-memory when omitted
  defaults: { limit: 10, minScore: 0 },
  retrieval: { /* see Retrieval tuning */ },
  provider: { /* see embedders.md */ },
  observability: { onEvent(event) {} },
  audit: { enabled: true },
});
```

Configuration is validated synchronously; invalid values throw `"CONFIG"`.
Without `store` the client keeps memories in process memory, which suits
tests and prototypes. For persistent storage see [postgres.md](./postgres.md).

## `migrate`

```ts
import { migrate } from "mnemocyte";

const { applied, adopted } = await migrate({
  store,             // from postgresStore() or drizzleStore()
  dimensions: 1536,  // required on an empty database
  signal,            // optional
});
```

Creates or upgrades the Postgres schema and records each migration in
`mnemocyte_migrations`. `applied` lists the migrations this call ran;
`adopted` lists those it found already applied in a schema installed without
`migrate` (with `psql` or drizzle-kit) and recorded without running. Calling
it again applies nothing. Each migration runs in its own transaction behind
an advisory lock, so concurrent calls from several app instances wait for
each other and apply every migration once. See
[postgres.md](./postgres.md#install-the-schema) for what each case does.

- `dimensions` is an integer from 1 to 4,000. It is required when the
  database has no Mnemocyte tables (`"VALIDATION"` otherwise) and fixes the
  embedding column: `vector` up to 2,000, `halfvec` above. On an existing
  installation a different value throws `"CONFIG"` before anything runs.
- pgvector must already be installed; otherwise a fresh install throws
  `"MIGRATION"`. `migrate` never creates extensions.
- A failing migration rolls back and throws `"MIGRATION"` with the driver
  error as `cause`; migrations that committed before it stay applied.
- A schema that matches no migration (for example a half-applied file run
  with plain `psql -f`) throws `"MIGRATION"` without changing anything.
- An abort cancels the running statement and rolls back the current
  migration.

## Memories

A memory belongs to one `entityId` (a user, agent, session or anything else
you choose) and has:

| Field | Type | Default |
|---|---|---|
| `content` | non-empty string | required |
| `type` | `"fact"`, `"preference"`, `"instruction"`, `"backstory"`, `"episode"`, `"session"` | `"fact"` |
| `importance` | `"low"`, `"normal"`, `"high"`, `"critical"` | `"normal"` |
| `tags` | `string[]` | `[]` |
| `source` | string | `null` |
| `metadata` | `JsonObject` | `{}` |
| `confidence` | number in `[0, 1]` | `1` |
| `expiresAt` | `Date` | none |

Stored records also carry `id`, `createdAt`, `updatedAt`, `accessCount`,
`lastAccessedAt`, `supersededBy`, `supersededAt`, `embeddingModel` and
`embeddingDimensions`.

`metadata` must be JSON data (`JsonObject` / `JsonValue` are exported).
`undefined`, functions, bigints, non-finite numbers, class instances and
cyclic objects throw `"VALIDATION"`. Tags, metadata and dates are copied when
you call a method, and returned records are copies, so later mutations on
either side change nothing.

## `remember` and `rememberMany`

```ts
const memory = await client.remember({
  entityId: "user_123",
  content: "Likes concise answers.",
  type: "preference",
  importance: "high",
  tags: ["communication"],
});

const memories = await client.rememberMany({
  inputs: [
    { entityId: "user_123", content: "Likes concise answers." },
    { entityId: "user_123", content: "Uses TypeScript." },
  ],
  signal,
});
```

Input is validated before the embedder is called. `rememberMany` embeds the
whole batch in one embedder call, writes it in one statement and returns the
records in input order. Its `signal` covers the whole batch.

The positional form `rememberMany(inputs)` is deprecated and will be removed
before 1.0.

## `recall`

```ts
const results = await client.recall({
  entityId: "user_123",
  query: "How should I respond?",
  limit: 5,
  explain: true,
});
```

| Option | Default | Meaning |
|---|---|---|
| `limit` | `defaults.limit` or 10 | Maximum results; positive integer. |
| `minScore` | `defaults.minScore` or 0 | Drop results below this score; `[0, 1]`. |
| `types` | all | Only these memory types. |
| `tags` | none | Memories must have every listed tag. |
| `before`, `after` | none | Filter on `createdAt`. |
| `includeSuperseded` | `false` | Include memories replaced by consolidation. |
| `includeExpired` | `false` | Include memories past `expiresAt`. |
| `explain` | `false` | Attach a score breakdown to each result. |
| `trackAccess` | `retrieval.trackAccess` or `false` | Record access for this call's results. |

Recall runs a vector search and a lexical (keyword) search, fuses the two
rankings and applies small recency and importance boosts (see
[retrieval tuning](#retrieval-tuning)). Each result carries `score` (0 to 1)
and `scores`, plus `explanation` when `explain` is set.

With access tracking on (`retrieval.trackAccess: true`, or `trackAccess` on
the call), recall increments `accessCount` and sets `lastAccessedAt` on the
returned memories. The write starts as recall returns and recall does not wait
for it, so the returned records show the values from before this recall.
If it fails, recall still succeeds and `onEvent` receives a `"trackAccess"`
error event. Memories deleted in the meantime are skipped. `updatedAt` never
changes on recall, and access counts do not affect ranking. With tracking
off, `accessCount` stays 0 and `lastAccessedAt` stays null.

## `buildContext`

```ts
const context = await client.buildContext({
  entityId: "user_123",
  query: "User communication preferences",
  format: "markdown",
  maxTokens: 500,
});
```

Runs a recall and renders the results as a string to put in a prompt. It
accepts recall's `limit`, `minScore`, `types`, `tags`, `includeSuperseded`,
`includeExpired` and `trackAccess`, plus:

- `format`: `"markdown"` (default), `"plain"` or `"xml"`. Memory content
  cannot break out of its block: Markdown and plain text use a fence longer
  than any run in the content, and XML escapes it.
- `maxTokens`: positive integer, default 1200. The result always fits; when
  memories are left out, a line says how many. If nothing fits, the result is
  part of that line or an empty string.
- `tokenCounter`: `{ count(text): number }`. The default estimates one token
  per four characters; pass your model's tokenizer for exact budgets.

## `forget` and `forgetAll`

```ts
await client.forget({ entityId: "user_123", memoryId: memory.id });
await client.forgetAll({ entityId: "user_123" });
```

`forget` throws `"NOT_FOUND"` when the memory does not exist or belongs to
another entity. Memory and audit event ids are UUIDv7 strings.

Both throw `"CONFLICT"` and delete nothing while another memory's
`supersededBy` points at a memory they would delete, even when `forgetAll`
would delete that other memory too. After a consolidation, delete the
superseded memories first:

```ts
await client.prune({ entityId: "user_123", superseded: true });
await client.forgetAll({ entityId: "user_123" });
```

## `prune`

```ts
const preview = await client.prune({
  entityId: "user_123",
  notAccessedSince: new Date(Date.now() - 30 * 24 * 3600 * 1000),
  maxImportance: "normal",
  dryRun: true,
});
// { matchedCount, deletedCount, dryRun }
```

Selectors are combined with AND:

| Selector | Matches |
|---|---|
| `entityId` | One entity. **Omit it and the prune covers every entity.** |
| `expired: true` | Past `expiresAt`. |
| `superseded: true` | Replaced by consolidation. |
| `createdBefore` | Created before the date. |
| `notAccessedSince` | Last accessed before the date; never-accessed memories count from `createdAt`. |
| `types` | Any of these types. |
| `tags` | Every listed tag. |
| `maxImportance` | At or below this importance. |

At least one selector is required; `false` flags and empty arrays do not
count. Input without one throws `"VALIDATION"` and deletes nothing.
`dryRun: true` only counts.

A prune that would delete a consolidation survivor throws `"CONFLICT"` and
deletes nothing, including the other matches. A dry run reports such rows
without failing.

## `findDuplicates`

```ts
const pairs = await client.findDuplicates({
  entityId: "user_123",
  threshold: 0.95,
  limit: 50,
});
for (const { a, b, similarity } of pairs) {
  // ...
}
```

Returns pairs of one entity's memories whose cosine similarity is at least
`threshold` (default 0.95), most similar first, up to `limit` (default 100).
It accepts `types`, `tags`, `includeSuperseded` and `includeExpired`, and
modifies nothing. It compares every pair, so cost grows with the square of
the entity's memory count; the in-memory backend slows down noticeably past a
few thousand memories per entity.

## `experimental.consolidate`

```ts
const result = await client.experimental.consolidate({
  entityId: "user_123",
  survivorId: survivor.id,
  supersededIds: [duplicate.id],
  mergeTags: true,
});
// { survivorId, supersededCount, supersededIds }
```

Marks each memory in `supersededIds` as replaced by the survivor and, by
default, adds their tags to the survivor. Superseded memories are left out of
recall, context and duplicate search unless `includeSuperseded` is set.

- `supersededIds` must be non-empty and distinct, and must not contain the
  survivor (`"VALIDATION"`). The survivor must not itself be superseded
  (`"VALIDATION"`). Every id must belong to the entity (`"NOT_FOUND"`).
- Repeating a call is a no-op for memories that already point to this
  survivor. A memory that points to a different survivor makes the whole call
  throw `"CONFLICT"`.
- The call is all-or-nothing: on any conflict no memory, tag or audit event
  changes. Concurrent calls are safe.
- While a memory points to the survivor, the survivor cannot be deleted (see
  [`forget`](#forget-and-forgetall)).

Anything under `experimental` may change in a minor release.

## `listAuditLog`

Enable the audit log in the config:

```ts
const client = createMnemocyte({ embedder, audit: { enabled: true } });
```

Mnemocyte then records `memory.created`, `memory.deleted`, `entity.cleared`,
`memory.pruned` (one per affected entity) and `memory.superseded`.

```ts
const page = await client.listAuditLog({ entityId: "user_123", limit: 100 });

const last = page.at(-1);
const next = last
  ? await client.listAuditLog({
      entityId: "user_123",
      limit: 100,
      beforeCursor: { timestamp: last.timestamp, id: last.id },
    })
  : [];
```

Events come newest first; `limit` defaults to 50. Page with `beforeCursor` /
`afterCursor`, which include events that share a timestamp. `before` and
`after` are strict timestamp filters and skip every event at the boundary
timestamp, so they can lose events when used for paging.

Audit writes are best-effort: a failed audit write does not fail the
operation. Consolidation is the exception; its events commit or roll back
with it. Events are never deleted by Mnemocyte.

## `stats`

```ts
const stats = await client.stats({ entityId: "user_123" });
// { entityId, memoryCount, activeMemoryCount, expiredMemoryCount, supersededMemoryCount }

const global = await client.stats();
// { entityCount, memoryCount, activeMemoryCount, expiredMemoryCount, supersededMemoryCount }
```

Active means neither expired nor superseded. The return type is
`EntityStats | GlobalStats`; check for `entityId` or `entityCount` to narrow
it.

## `close`

`await client.close()` rejects new operations, waits for running ones, then
closes the store. It never closes a database client you passed in, and it
does not wait for access writes from tracked recalls. Calling it twice is
safe. You only need it for a clean shutdown: with Postgres it closes nothing,
and with the in-memory store it clears the stored memories.

## Retrieval tuning

```ts
const client = createMnemocyte({
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
- `trackAccess`: record `accessCount` and `lastAccessedAt` on recall (see
  [recall](#recall)). `trackAccess` on a call overrides it.

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
  await client.recall({ entityId: "user_123", query });
} catch (error) {
  if (isMnemocyteError(error) && error.code === "TIMEOUT") {
    // retry later
  }
  throw error;
}
```

| Code | Thrown when |
|---|---|
| `CONFIG` | Invalid client configuration, or the embedder (or `migrate`'s `dimensions`) does not match the Postgres installation. |
| `VALIDATION` | Invalid method input. Nothing was embedded or stored. |
| `EMBEDDING` | The embedder threw or returned invalid vectors. |
| `TIMEOUT` | An embedder attempt exceeded `provider.timeoutMs`. |
| `ABORTED` | The caller's `AbortSignal` fired. |
| `NOT_FOUND` | A referenced memory does not exist for that entity. |
| `CONFLICT` | A delete or consolidation conflicts with a consolidation link. |
| `MIGRATION` | Mnemocyte tables or columns are missing, the installation holds mixed models, or `migrate` could not apply a migration. |
| `DB` | Any other database failure, or a call on a closed client. |
