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
- Provider timeouts, retries, and `AbortSignal` cancellation.
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

For persistent storage, apply the bundled migration to a Postgres database with
pgvector enabled, then pass `databaseUrl`.

```ts
const client = createMnemocyte({
  databaseUrl: process.env.DATABASE_URL!,
  embedder,
});
```

The package includes:

```txt
migrations/0000_initial.sql
```

The current Postgres schema uses `embedding vector(1536)`, so the Postgres
backend currently requires a 1536-dimensional embedder.

If dimensions do not match, `createMnemocyte` throws a `MnemocyteError` with
code `"CONFIG"` before opening the connection pool.

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

Configurable embedding dimensions are planned for `0.2.0`.

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

- configurable embedding dimensions with `mnemocyte_meta`
- `MemoryStore` abstraction
- `drizzleStore(db)` for caller-owned Drizzle clients
- `@mnemocyte/mcp`

See [ROADMAP.md](./ROADMAP.md).

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
