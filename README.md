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
- Provider retries, operation timeouts, and caller `AbortSignal` cancellation.
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
supported for consumers that prefer provider-specific imports.

## Postgres

For persistent storage, enable pgvector in your Postgres database, apply the
bundled migrations, then pass `databaseUrl`.

```ts
const client = createMnemocyte({
  databaseUrl: process.env.DATABASE_URL!,
  embedder,
});
```

The package includes:

```txt
migrations/0000_initial.sql
migrations/0001_add_mnemocyte_meta.sql
migrations/0000_initial.sql.template
migrations/render-initial.mjs
```

For the default 1536-dimensional schema on a fresh install, apply these in
order:

```txt
migrations/0000_initial.sql
migrations/0001_add_mnemocyte_meta.sql
```

For an existing 0.1.x Postgres install, apply
`migrations/0001_add_mnemocyte_meta.sql` to record the current 1536-dimensional
installation metadata.

For a different embedding dimension on a fresh installation, render an explicit
initial migration from the template and apply that rendered file instead of the
default `0000_initial.sql`. The rendered initial migration includes the
matching `mnemocyte_meta` row.

```bash
node node_modules/mnemocyte/migrations/render-initial.mjs --dimensions 768 --out migrations/0000_initial.768.sql
```

Inside this repository, the equivalent development shortcut is:

```bash
pnpm migration:render -- --dimensions 768 --out migrations/0000_initial.768.sql
```

The Postgres backend supports one embedding dimension per installation. On the
first Postgres operation, Mnemocyte reads `mnemocyte_meta` and validates it
against `embedder.dimensions` before calling the embedder. A mismatch throws a
`MnemocyteError` with code `"CONFIG"`; missing v0.2.0 metadata throws code
`"MIGRATION"`.

Use the embedding dimension documented for your chosen model, render or apply a
matching schema, and keep one dimension per Mnemocyte installation.

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

### `recall`

```ts
const memories = await client.recall({
  entityId: "user_123",
  query: "How should I respond to this user?",
  limit: 5,
  explain: true,
});
```

### `buildContext`

```ts
const context = await client.buildContext({
  entityId: "user_123",
  query: "User communication preferences",
  format: "markdown",
  maxTokens: 500,
});
```

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
```

### `experimental.consolidate`

```ts
await client.experimental.consolidate({
  entityId: "user_123",
  survivorId: "mem_survivor",
  supersededIds: ["mem_duplicate"],
});
```

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

Pass `signal` to cancel an operation:

```ts
const controller = new AbortController();

await client.remember({
  entityId: "user_123",
  content: "Prefers short answers.",
  signal: controller.signal,
});
```

Common `MnemocyteError` codes:

```txt
TIMEOUT
ABORTED
EMBEDDING
VALIDATION
CONFIG
DB
NOT_FOUND
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

## Roadmap

Planned larger milestones:

- `MemoryStore` abstraction
- `drizzleStore(db)` for caller-owned Drizzle clients
- `@mnemocyte/mcp`

See [ROADMAP.md](./ROADMAP.md).

## Pre-v1 Notes

Current behavior:

- `createMnemocyte()` selects either the in-memory backend or the
  Postgres/pgvector backend.
- Postgres schema setup is explicit; the client does not create tables or
  indexes for you.
- `findDuplicates`, audit-log workflows, and `experimental.consolidate` are
  available before v1 but still subject to API refinement.

Known limitations before v1:

- The two current backends share behavior by convention rather than through a
  formal `MemoryStore` adapter boundary.
- Configured provider timeouts fail the Mnemocyte operation with `"TIMEOUT"`;
  actively aborting the underlying provider request on timeout remains a
  pre-v1 hardening follow-up.
- Postgres dimension metadata is installation-wide. Mixed embedding dimensions
  in one database are intentionally out of scope for now.

Planned v1 direction:

- Extract a `MemoryStore` boundary so storage adapters own persistence while
  shared core code owns validation, embedding, scoring, observability,
  resilience, and context building.
- Keep root `mnemocyte` imports provider-SDK-free.
- Keep migrations, dimensions, and production index choices explicit.

## Development

```bash
pnpm checktypes
pnpm lint
pnpm test
pnpm run test:integration
pnpm run pack:check
```

`test:integration` skips when `DATABASE_URL` is not set.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md).
