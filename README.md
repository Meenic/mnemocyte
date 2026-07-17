# Mnemocyte

Infrastructure-native memory for TypeScript AI applications.

Mnemocyte stores durable memories for users, agents, sessions, and other
entities. It gives your app hybrid recall, prompt-ready context, pruning, audit
logs, and duplicate-consolidation tools on top of your existing infrastructure.

> Mnemocyte is early software. APIs may change before v1.0.

## Features

- In-memory backend for tests and demos.
- Postgres + pgvector backend for persistent storage.
- User-supplied `Embedder` interface.
- Hybrid recall with vector similarity, lexical matching, recency, confidence,
  access count, and importance.
- Prompt-ready context output in Markdown, plain text, or XML.
- Provider retries, per-attempt timeouts, and caller `AbortSignal` cancellation.
- Pruning, duplicate detection, audit logs, and experimental consolidation.

Mnemocyte is ESM-only. Use `import`, not CommonJS `require`.

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

When `databaseUrl` is omitted, Mnemocyte uses the in-memory backend.

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
bundled migrations, then pass `databaseUrl`.

```ts
const client = createMnemocyte({
  databaseUrl: process.env.DATABASE_URL!,
  embedder,
});
```

`databaseUrl` must use the `postgres:` or `postgresql:` protocol. Other URL
protocols reject synchronously with `MnemocyteError` code `"CONFIG"`; detailed
host, database, and credential validation remains the driver's responsibility.

The package includes:

```txt
migrations/0000_initial.sql
migrations/0001_add_mnemocyte_meta.sql
migrations/0002_add_embedding_model.sql
migrations/0000_initial.sql.template
migrations/render-initial.mjs
```

For the default 1536-dimensional schema on a fresh install, apply these in
order:

```txt
migrations/0000_initial.sql
migrations/0001_add_mnemocyte_meta.sql
migrations/0002_add_embedding_model.sql
```

For an existing 0.1.x Postgres install, apply
`migrations/0001_add_mnemocyte_meta.sql` and then
`migrations/0002_add_embedding_model.sql`. Existing 0.2.x or 0.3.x installs
only need `0002_add_embedding_model.sql`.

For a different embedding dimension on a fresh installation, render an explicit
initial migration from the template and apply that rendered file instead of the
default `0000_initial.sql`. The rendered initial migration includes the
matching `mnemocyte_meta` dimensions and the installation-model column, so it
does not also need `0001` or `0002`.

```bash
node node_modules/mnemocyte/migrations/render-initial.mjs --dimensions 768 --out migrations/0000_initial.768.sql
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

## Roadmap

Planned larger milestones:

- public `MemoryStore` adapter surface
- `drizzleStore(db)` for caller-owned Drizzle clients
- `@mnemocyte/mcp`

See [ROADMAP.md](./docs/ROADMAP.md).

## Pre-v1 Notes

Current behavior:

- `createMnemocyte()` selects either the in-memory backend or the
  Postgres/pgvector backend.
- Both backends run through an internal `MemoryStore` boundary and shared
  client orchestration; `MemoryStore` is not exported as a public adapter API
  yet.
- Postgres schema setup is explicit; the client does not create tables or
  indexes for you.
- `findDuplicates`, audit-log workflows, and `experimental.consolidate` are
  available before v1 but still subject to API refinement.

Known limitations before v1:

- The internal `MemoryStore` boundary is not a public adapter API yet.
  `drizzleStore(db)` is the planned first public store adapter.
- Configured provider timeouts abort the per-attempt `AbortSignal`; the
  underlying provider request only stops promptly when the embedder honors that
  signal.
- Postgres model and dimension metadata are installation-wide. Mixed embedding
  vector spaces in one database are intentionally unsupported.

Planned v1 direction:

- Keep storage adapters behind `MemoryStore` while shared core code owns
  validation, embedding, scoring, observability, resilience, and context
  building.
- Keep root `mnemocyte` imports provider-SDK-free.
- Keep migrations, dimensions, and production index choices explicit.

## Development

### Prerequisites

- Node.js 22.18 or newer. CI tests the minimum 22.18 release and Node 24.
- pnpm 11.1.1, matching the `packageManager` field in `package.json`.
- Postgres with pgvector only when you want to run the integration suite.

Clone the repository and install its locked dependencies:

```bash
git clone https://github.com/Meenic/mnemocyte.git
cd mnemocyte
pnpm install --frozen-lockfile
```

Mnemocyte is a library, not a standalone server. Use the quick-start example
from a consuming TypeScript project, or run the repository build in watch mode
while developing:

```bash
pnpm dev
```

Create the publishable ESM artifacts in `dist/` with:

```bash
pnpm build
```

### Validation

Run the same main gates used by CI before committing:

```bash
pnpm checktypes
pnpm lint
pnpm test
pnpm run pack:check
```

`pnpm test` builds the package, runs unit behavior, verifies package exports,
and type-checks the public declarations. `pnpm lint` is a read-only formatting,
lint, and import-order check; use `pnpm lint:fix` to apply its safe fixes. The
Postgres suite is separate:

```bash
DATABASE_URL=postgres://... pnpm run test:integration
```

On PowerShell, set the environment variable for the current process first:

```powershell
$env:DATABASE_URL = "postgres://..."
pnpm run test:integration
```

`test:integration` skips when `DATABASE_URL` is not set. The database must have
pgvector available; the test applies the bundled migrations.

### Where changes belong

- Public exports and types: `src/index.ts`, `src/types.ts`, and `src/errors.ts`.
- Shared client behavior: `src/memory/client-core.ts`; backend mechanics stay
  in `src/memory/in-memory.ts` or `src/memory/postgres.ts`.
- Postgres schema and SQL: `src/db/schema.ts` and `src/db/queries/`. Schema
  changes require an explicit file under `migrations/`.
- Provider helpers: `src/embedders/`; keep the root package provider-SDK-free.
- Retrieval and context rendering: `src/retrieval/` and `src/context/`.
- Tests: mirror the affected responsibility under `test/`; package boundary
  checks live under `test/package/`, and real Postgres coverage under
  `test/integration/`.

See [AGENTS.md](./AGENTS.md) for repository rules and the validation/release
policy. Read [ARCHITECTURE.md](./docs/ARCHITECTURE.md) before changing module
boundaries or the public surface.

## Architecture

See [ARCHITECTURE.md](./docs/ARCHITECTURE.md).
