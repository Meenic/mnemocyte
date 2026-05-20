# Mnemocyte

Persistent memory for TypeScript AI applications.

Mnemocyte stores small, durable memories for users, agents, sessions, or
other entities. It provides hybrid retrieval, context formatting, lifecycle
operations, audit logging, and duplicate-consolidation tools without requiring
a separate vector database.

> Mnemocyte is early software. APIs may change before v1.0.

## Features

- In-memory backend for tests, demos, and short-lived processes.
- Postgres + pgvector backend for persistent storage.
- Hybrid recall using vector similarity, lexical matching, recency,
  confidence, access count, and importance.
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

await client.close();
```

When `databaseUrl` is omitted, Mnemocyte uses the in-memory backend.

## Postgres

Apply the bundled migration to a Postgres database with pgvector enabled, then
pass `databaseUrl`:

```ts
const client = createMnemocyte({
  databaseUrl: process.env.DATABASE_URL,
  embedder, // embedder.dimensions must be 1536 for the Postgres backend.
});
```

The published package includes `migrations/0000_initial.sql`.

The current Postgres schema uses `embedding vector(1536)`. If
`embedder.dimensions` is anything else, `createMnemocyte` throws a
`MnemocyteError` with code `"CONFIG"` before opening the connection pool. The
in-memory backend does not enforce this constraint.

Database scripts and Postgres integration tests read `DATABASE_URL` from the
process environment and load `.env` when present. Run `pnpm db:migrate` to
apply the bundled migration.

## Provider Resilience

Mnemocyte can apply timeouts and retries to embedder calls, and forwards
`AbortSignal` cancellation to in-flight attempts. Retries and timeouts are
disabled by default.

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

const controller = new AbortController();
setTimeout(() => controller.abort(), 1_000);

await client.remember({
  entityId: "user_123",
  content: "Prefers short answers.",
  signal: controller.signal,
});
```

Provider failures surface as `MnemocyteError` values with stable `code`s:

- `"TIMEOUT"`: a provider attempt exceeded `timeoutMs`.
- `"ABORTED"`: the operation was cancelled via `signal` and is not retried.
- `"EMBEDDING"`: the embedder failed after retries were exhausted.

## Pruning

`prune` deletes memories matching a filter. At least one selector is required;
`prune({})` is rejected to avoid accidental full deletion.

```ts
await client.prune({ entityId: "user_123", expired: true });

await client.prune({
  notAccessedSince: new Date(Date.now() - 30 * 24 * 3600 * 1000),
  maxImportance: "normal",
});

const preview = await client.prune({
  entityId: "user_123",
  superseded: true,
  dryRun: true,
});
console.log(preview.matchedCount);
```

Available selectors: `entityId`, `expired`, `superseded`, `createdBefore`,
`notAccessedSince`, `types`, `tags`, `maxImportance`. Selectors are combined
with AND semantics.

## Duplicate Detection

`findDuplicates` is an experimental, read-only scan that surfaces
near-identical memories for one entity using pairwise cosine similarity.

```ts
const pairs = await client.findDuplicates({
  entityId: "user_123",
  threshold: 0.95,
  limit: 50,
});

for (const { a, b, similarity } of pairs) {
  console.log(similarity.toFixed(3), a.content, "<>", b.content);
}
```

Optional selectors: `types`, `tags`, `includeSuperseded`, `includeExpired`.
`types` and `tags` must match on both memories in each pair. Superseded and
expired memories are excluded by default.

## Audit Log

When `audit.enabled` is `true`, Mnemocyte records an entry for state-changing
operations. Read entries with `client.listAuditLog()`.

```ts
const client = createMnemocyte({
  embedder,
  audit: { enabled: true },
});

await client.remember({ entityId: "user_123", content: "Likes tea." });
await client.prune({ entityId: "user_123", expired: true });

const log = await client.listAuditLog({
  entityId: "user_123",
  limit: 100,
});

for (const event of log) {
  console.log(event.timestamp, event.description, event.metadata);
}
```

Recorded `description` slugs:

- `"memory.created"`: single insert.
- `"memory.deleted"`: single `forget`.
- `"entity.cleared"`: `forgetAll`.
- `"memory.pruned"`: non-dry-run `prune` with an `entityId` selector.
- `"memory.superseded"`: experimental consolidation.

Audit entries are sticky: `forgetAll` does not erase prior log entries. Disable
audit by leaving `audit.enabled` unset.

## Consolidation

`client.experimental.consolidate()` marks likely-duplicate memories as
superseded by a survivor. Superseded memories are excluded from `recall` by
default. Tags are unioned onto the survivor unless `mergeTags: false`.

```ts
const pairs = await client.findDuplicates({
  entityId: "user_123",
  threshold: 0.97,
});

for (const { a, b } of pairs) {
  await client.experimental.consolidate({
    entityId: "user_123",
    survivorId: a.id,
    supersededIds: [b.id],
  });
}
```

The `experimental` namespace is intentionally unstable. Members may change or
move before v1.0.

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

## Development

```bash
pnpm checktypes
pnpm lint
pnpm run test:retrieval
pnpm run test:integration
pnpm run pack:check
```

`test:integration` skips cleanly when `DATABASE_URL` is not set in the process
environment or `.env`.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for implementation details and
[ROADMAP.md](./ROADMAP.md) for planned work.
