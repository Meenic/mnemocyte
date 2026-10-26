# Mnemocyte

Infrastructure-native memory for TypeScript AI applications.

Mnemocyte stores durable memories for users, agents, sessions, and other
entities. It gives your app hybrid recall, prompt-ready context, pruning, audit
logs, and duplicate-consolidation tools on top of your existing infrastructure.

> Mnemocyte is early software. APIs may change before v1.0.

## Features

- In-memory backend for tests and demos.
- Postgres + pgvector backend for persistent storage.
- Caller-owned postgres.js Drizzle instances through
  `mnemocyte/stores/drizzle`.
- User-supplied `Embedder` interface.
- Hybrid recall with vector similarity, lexical matching, recency, confidence,
  access count, and importance.
- Prompt-ready context output in Markdown, plain text, or XML.
- Provider retries, per-attempt timeouts, and caller `AbortSignal` cancellation.
- Pruning, duplicate detection, audit logs, and experimental consolidation.

Mnemocyte ships as ES modules. CommonJS code can load it with `require()` on
the supported Node versions (22.18 and newer); `require()` returns the
module's named exports.

## Install

```bash
pnpm add mnemocyte
```

## Quick Start

```ts
import { createMnemocyte } from "mnemocyte";

const client = createMnemocyte({
  embedder: {
    model: "demo",
    dimensions: 3,
    async embed(texts) {
      return texts.map((text) => [text.length, 1, 0]);
    },
  },
});

await client.remember({
  entityId: "user_123",
  content: "Prefers short, direct answers.",
  type: "preference",
});

const memories = await client.recall({
  entityId: "user_123",
  query: "How should I respond?",
  limit: 5,
  explain: true,
});

const context = await client.buildContext({
  entityId: "user_123",
  query: "How should I respond?",
  format: "markdown",
  maxTokens: 500,
});

await client.close();
```

When both `databaseUrl` and `store` are omitted, Mnemocyte uses the in-memory
backend. That backend is intended for development, tests, and prototyping. For
persistent or larger workloads, use Postgres.

## Embedder

Mnemocyte accepts any embedder that returns one vector per input text.
Each vector must match `embedder.dimensions`, contain only finite numbers, and
have at least one nonzero component. Invalid provider output, including an
exact zero-norm vector, fails with `MnemocyteError` code `"EMBEDDING"` before
storage or vector comparison. Tiny nonzero vectors remain valid.

```ts
const client = createMnemocyte({
  embedder: {
    model: "text-embedding-3-small",
    dimensions: 1536,
    async embed(texts, options) {
      return embedWithYourProvider(texts, {
        signal: options?.signal,
      });
    },
  },
});
```

You can also use the optional OpenAI helper:

```ts
import { openaiEmbedder } from "mnemocyte/embedders";

const embedder = openaiEmbedder({
  model: "text-embedding-3-small",
});
```

`openaiEmbedder()` reads `OPENAI_API_KEY` by default. Pass `apiKey`
explicitly when you use a different key source. The helper uses `fetch`
directly and does not depend on the OpenAI SDK; plain `import "mnemocyte"` also
stays provider-free. The direct subpath `mnemocyte/embedders/openai` is also
supported for consumers that prefer provider-specific imports. Provider
responses must contain exactly one uniquely indexed array embedding per input;
malformed response shapes fail with `MnemocyteError` code `"EMBEDDING"`.
Dimension and numeric-component validation remains at the shared embedder
boundary.

## Postgres

For persistent storage, enable pgvector in your Postgres database, apply the
appropriate bundled schema file, then pass `databaseUrl`. The commands below
use `psql` and assume `DATABASE_URL` points at the target database.
`-v ON_ERROR_STOP=1 --single-transaction` makes `psql` stop at the first error
and roll the whole file back, so a failed migration never leaves a partial
schema.

Enable pgvector before applying any Mnemocyte schema file:

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

The database role running that command must be allowed to install the
extension. Mnemocyte does not create extensions, tables, or indexes from the
client constructor.

```ts
const client = createMnemocyte({
  databaseUrl: process.env.DATABASE_URL!,
  embedder,
});
```

Applications that already own a postgres.js Drizzle instance can pass it
through the `mnemocyte/stores/drizzle` subpath:

```ts
import { createMnemocyte } from "mnemocyte";
import { drizzleStore } from "mnemocyte/stores/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as applicationSchema from "./db/schema.js";

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql, { schema: applicationSchema });

const client = createMnemocyte({
  store: drizzleStore(db),
  embedder,
});

try {
  await client.remember({
    entityId: "user_123",
    content: "Uses the application's existing Drizzle connection.",
  });
} finally {
  await client.close(); // does not close db or sql
  await sql.end(); // the caller retains connection ownership
}
```

`drizzleStore(db)` v1 accepts only Drizzle instances backed by postgres.js. It
uses Mnemocyte's fixed tables in the `public` schema; the bundled migrations
must already have been applied, and the adapter does not create or migrate
tables. The caller's Drizzle schema map does not need to include Mnemocyte's
tables. Supplying both `databaseUrl` and `store` is ambiguous and throws
synchronously with `MnemocyteError` code `"CONFIG"`.

`databaseUrl` must use the `postgres:` or `postgresql:` protocol. Other URL
protocols reject synchronously with `MnemocyteError` code `"CONFIG"`; detailed
host, database, and credential validation remains the driver's responsibility.

The package includes:

```txt
migrations/fresh-install.sql
migrations/0000_initial.sql
migrations/0001_add_mnemocyte_meta.sql
migrations/0002_add_embedding_model.sql
migrations/0000_initial.sql.template
migrations/render-initial.mjs
```

For a brand-new installation using the default 1536 dimensions, apply the
consolidated fresh-install file:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/fresh-install.sql
```

`fresh-install.sql` is generated from `0000_initial.sql.template` and combines
the final empty-database effects of `0000`, `0001`, and `0002`. It is only for
a brand-new installation and is not part of the Drizzle migration journal.

Existing installations must continue to use the numbered migration series.
The `0000` / `0001` / `0002` files remain the correct upgrade source; do not
apply `fresh-install.sql` over an existing Mnemocyte schema.

For an existing 0.1.x Postgres installation, apply `0001` and then `0002` in
the same order as before:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/0001_add_mnemocyte_meta.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/0002_add_embedding_model.sql
```

For an existing 0.2.x or 0.3.x installation, apply only `0002`:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/0002_add_embedding_model.sql
```

For a different embedding dimension on a fresh installation, render an explicit
initial migration from the template, then apply that rendered file instead of
`fresh-install.sql` or any numbered migration. The rendered initial migration
includes the matching `mnemocyte_meta` dimensions and the installation-model
column, so it does not also need `0000`, `0001`, or `0002`.

```bash
node node_modules/mnemocyte/migrations/render-initial.mjs --dimensions 768 --out migrations/0000_initial.768.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f migrations/0000_initial.768.sql
```

Inside this repository, the equivalent development shortcut is:

```bash
pnpm migration:render -- --dimensions 768 --out migrations/0000_initial.768.sql
```

The Postgres backend supports one embedding model and dimension per
installation. Before writes, recall, or duplicate scans, Mnemocyte reads
`mnemocyte_meta` and validates both values before calling the embedder or
comparing vectors. An empty installation atomically records the configured
model on its first embedding-dependent operation. Migration `0002` records the
single model already present in historical rows when that value is
unambiguous.

A configured model or dimension mismatch throws `MnemocyteError` code
`"CONFIG"`. If historical rows contain multiple model values, the installation
model remains unset and embedding-dependent operations throw `"MIGRATION"`
until an operator re-embeds or removes the mixed rows and explicitly records
the intended installation model. Non-embedding recovery operations such as
`stats`, `forget`, and pruning remain available.

Inspect mixed history before repairing it:

```sql
SELECT embedding_model, count(*)
FROM mnemocyte_memories
GROUP BY embedding_model;
```

Only after every retained row belongs to the intended vector space, record that
model explicitly:

```sql
UPDATE mnemocyte_meta
SET embedding_model = 'your-model-id'
WHERE key = 'installation';
```

Use the model identifier and embedding dimension documented for your embedder,
render or apply a matching schema, and keep one vector space per Mnemocyte
installation.

The migration creates the bundled HNSW pgvector index
`mnemocyte_memories_embedding_hnsw_idx` for cosine search. HNSW is approximate:
it is fast for nearest-neighbor recall, but recall quality, index build memory,
and write overhead should be benchmarked against your data volume and write
rate. Postgres still applies ordinary filters such as `entity_id`, `type`, and
tags around vector search, so highly selective filters may need query tuning or
a workload-specific index strategy.

Large production tables should benchmark alternate indexes or custom
migrations with representative data before changing the default. IVFFlat can be
a good fit for some large, steady-state tables, but it needs tuning after the
table has representative vectors. The bundled migration intentionally does not
add full-text or tag-specific GIN indexes yet; add and benchmark expression
indexes such as `to_tsvector('english', content)` or tag-oriented indexes only
when your workload needs them.

Existing 0.1.x deployments remain on 1536 unless you plan and run your own
Postgres migration to a different pgvector dimension.

## API

### `remember`

```ts
await client.remember({
  entityId: "user_123",
  content: "Likes concise answers.",
  type: "preference",
  importance: "high",
  tags: ["communication"],
});
```

Memory metadata is persisted JSON value data. Use the exported `JsonObject`
and `JsonValue` types; unsupported values such as `undefined`, functions,
bigints, non-finite numbers, class instances, or cyclic objects are rejected
with `MnemocyteError` code `"VALIDATION"`. Mnemocyte deep-clones metadata when
writing and reading, so later mutations do not change stored state.

JavaScript callers receive the same runtime domain checks as TypeScript
callers: `type` and `importance` must be known values, tags must be an array of
strings, `source` must be a string when supplied, and `expiresAt` must be a
valid `Date`. Invalid values reject with `"VALIDATION"` before embedding or
storage. Mutable tags, metadata, and expiration dates are snapshotted when
`remember` or `rememberMany` is invoked, so later caller mutations cannot
change the pending write.

When observability is configured, snapshot and validation failures follow the
same operation lifecycle as provider or storage failures: one `"start"` event
and one `"error"` event carrying the thrown value. Snapshotting remains
synchronous before any awaited `onEvent` hook.

For batches, cancellation belongs to the whole operation:

```ts
const abortController = new AbortController();

const memories = await client.rememberMany({
  inputs: [
    { entityId: "user_123", content: "Likes concise answers." },
    { entityId: "user_123", content: "Uses TypeScript." },
  ],
  signal: abortController.signal,
});
```

The positional `rememberMany(inputs)` form remains as a deprecated pre-v1
compatibility overload and treats its first item's signal as the batch signal.
New code should use `{ inputs, signal }`; individual items in the object form do
not have cancellation signals.

### `recall`

```ts
const memories = await client.recall({
  entityId: "user_123",
  query: "How should I respond to this user?",
  limit: 5,
  explain: true,
});
```

Successful recall results include the access metadata written by that call:
`accessCount`, `lastAccessedAt`, and `updatedAt` match stored state when the
promise resolves. Ranking and score explanations use the count from before the
current recall so the access update cannot change its own ordering.

### `buildContext`

```ts
const context = await client.buildContext({
  entityId: "user_123",
  query: "User communication preferences",
  format: "markdown",
  maxTokens: 500,
});
```

Plain-text context uses a deterministic `=` fence longer than any `=` run in
the query, rendered metadata, or included memory content. The resulting
`MEMORY N START/END` boundaries cannot be reproduced by untrusted content.
Markdown continues to choose a content-safe backtick fence, and XML continues
to escape content.

When supplied, `maxTokens` must be a positive integer or `buildContext` rejects
with `"VALIDATION"`. Omitting it keeps the default token-budget path. Returned
context always fits the supplied counter and budget; when an extremely small
budget cannot fit the full truncation marker, the result is the longest marker
fragment that fits or an empty string.

### `forget` and `forgetAll`

```ts
await client.forget({
  entityId: "user_123",
  memoryId: "mem_old",
});

await client.forgetAll({ entityId: "user_123" });
```

A memory cannot be deleted while another memory's `supersededBy` still points
to it as a consolidation survivor. `forget` and `forgetAll` reject with
`"CONFLICT"` before deleting anything in that case. This also applies when
`forgetAll` selects both the survivor and its superseded dependent. Delete the
superseded memories first; deleting a loser, or any memory with no dependents,
continues to work normally.

### `prune`

```ts
const preview = await client.prune({
  entityId: "user_123",
  superseded: true,
  dryRun: true,
});

await client.prune({
  entityId: "user_123",
  expired: true,
});
```

Prune selectors are validated and normalized before either backend is called.
Dates must be valid `Date` instances, enum values must be known, arrays must
contain valid values, and boolean fields must be actual booleans. `false`
selector flags and empty selector arrays do not count toward the required
selector; malformed or selector-free input rejects with `"VALIDATION"` without
deleting anything. Tag selectors are trimmed and deduplicated.

A dry run may preview a survivor among its matches. A non-dry-run prune rejects
with `"CONFLICT"` if any matching memory still has consolidation dependents,
and the entire prune batch remains unchanged; unrelated matching rows are not
partially deleted.

When audit logging is enabled, every successful non-dry prune writes one
best-effort `"memory.pruned"` event per affected entity, including global
prunes without an `entityId`. Dry runs and zero-deletion runs do not write prune
events.

### `findDuplicates`

```ts
const pairs = await client.findDuplicates({
  entityId: "user_123",
  threshold: 0.95,
  limit: 50,
});
```

The in-memory implementation compares memory pairs quadratically. It degrades
noticeably once an entity grows beyond roughly a few thousand memories, so use
the Postgres backend for duplicate detection beyond that scale.

### `listAuditLog`

```ts
const client = createMnemocyte({
  embedder,
  audit: { enabled: true },
});

const events = await client.listAuditLog({
  entityId: "user_123",
  limit: 100,
});

const last = events.at(-1);
const nextPage = last
  ? await client.listAuditLog({
      entityId: "user_123",
      limit: 100,
      beforeCursor: { timestamp: last.timestamp, id: last.id },
    })
  : [];
```

Audit entries are ordered newest first by timestamp and event ID. The
experimental composite `beforeCursor` / `afterCursor` fields provide stable
pagination when multiple events share a timestamp. The existing `before` and
`after` fields remain strict timestamp filters; they exclude all events at the
boundary timestamp and should not be used as the sole cursor when complete
tie-safe pagination is required.

Ordinary audit writes are best-effort: an audit storage failure does not fail
the primary client operation, so `listAuditLog` returns only events that were
successfully persisted. Postgres consolidation is the exception; its
`"memory.superseded"` events share the consolidation transaction and commit or
roll back with it.

### `experimental.consolidate`

```ts
await client.experimental.consolidate({
  entityId: "user_123",
  survivorId: "mem_survivor",
  supersededIds: ["mem_duplicate"],
});
```

Consolidation records each loser's `supersededBy` reference to the survivor.
Retrying the same loser with that same survivor is an idempotent no-op. If any
requested loser already points to a different survivor, the call rejects with
`"CONFLICT"`. Mixed batches are atomic: no newly eligible loser is changed, no
tags are merged, and no consolidation audit event is written when any item
conflicts. Concurrent calls follow the same target-specific rule in both
backends. `supersededIds` must contain distinct IDs; duplicates reject with
`"VALIDATION"` before either store is accessed.

The store re-reads and protects the survivor in the same atomic boundary as
the loser updates, tag merge, and enabled audit events. If the survivor is
deleted or becomes superseded after initial validation but before that
boundary, the call rejects with `"CONFLICT"` without a partial mutation. Tag
merges start from the survivor's state inside that boundary, so concurrent
successful consolidations preserve every committed tag.

The survivor cannot later be deleted while any such reference remains:
`forget`, `forgetAll`, and matching non-dry-run `prune` calls reject with
`"CONFLICT"`. Deleting a superseded loser remains allowed.

The `experimental` namespace may change before v1.0.

## Provider Resilience

```ts
const client = createMnemocyte({
  embedder,
  provider: {
    timeoutMs: 5_000,
    retries: 2,
    baseDelayMs: 200,
    maxDelayMs: 2_000,
  },
});
```

Provider resilience values are validated synchronously when the client is
created. Timeouts and delays must be finite non-negative numbers, retries must
be a non-negative integer, and `shouldRetry` must be a function when supplied;
invalid values throw `"CONFIG"`. A `maxDelayMs` below `baseDelayMs` remains
valid and is normalized up to the base delay.

Pass `signal` to cancel an operation:

```ts
const controller = new AbortController();

await client.remember({
  entityId: "user_123",
  content: "Prefers short answers.",
  signal: controller.signal,
});
```

Pre-aborted signals reject with `"ABORTED"` before storage work begins.
In-memory maintenance scans check cancellation cooperatively. For Postgres,
standalone prune, duplicate-search, and audit-log queries request postgres.js
query cancellation while they are in flight.

Postgres consolidation has a transaction-specific boundary: cancellation is
checked between mutation steps and immediately before the transaction callback
returns. If a statement is already in flight, it may finish before the next
check throws and rolls the transaction back. An abort after the final check,
including while commit is in flight, may still leave the mutation committed.

Common `MnemocyteError` codes:

```txt
TIMEOUT
ABORTED
EMBEDDING
VALIDATION
CONFIG
DB
NOT_FOUND
CONFLICT
MIGRATION
```

## Retrieval Tuning

```ts
const client = createMnemocyte({
  embedder,
  retrieval: {
    weights: {
      vector: 0.55,
      lexical: 0.2,
      recency: 0.1,
      confidence: 0.05,
      access: 0.05,
      importance: 0.05,
    },
    recencyHalfLifeDays: 90,
    accessSaturation: 10,
    candidateMultiplier: 3,
  },
});
```

Retrieval weights must be finite and non-negative, with a non-zero effective
total after defaults are applied. `recencyHalfLifeDays` and `accessSaturation`
must be positive finite numbers, and `candidateMultiplier` must be an integer
of at least 1. Invalid tuning is rejected at client construction with
`MnemocyteError` code `"CONFIG"`.

## Limitations

Mnemocyte is pre-1.0. Today:

- Postgres stores one embedding model and dimension per installation; mixed
  vector spaces in one database are not supported.
- The bundled HNSW index supports at most 2,000 dimensions. Rendering a
  larger dimension produces a migration that fails at `CREATE INDEX`.
- `drizzleStore(db)` supports only postgres.js-backed Drizzle instances, the
  `public` schema and pre-applied migrations.
- Without `entityId`, `prune` applies to every entity in the database.
- `forgetAll` rejects with `"CONFLICT"` after a consolidation until the
  superseded memories are pruned first (`prune({ entityId, superseded: true
  })`).
- Provider timeouts abort the attempt's `AbortSignal`; the request stops
  promptly only if the embedder forwards that signal.

The planned 0.6 release changes the API; see the
[roadmap](./docs/ROADMAP.md).

## Contributing

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) for setup, structure,
testing and releases, and [AGENTS.md](./AGENTS.md) for repository rules.
