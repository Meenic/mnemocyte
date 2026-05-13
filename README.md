# Mnemocyte

Persistent memory for TypeScript AI apps.

> Warning
>
> Mnemocyte is in active early development. APIs may change significantly before v1.0.

## Current status

Mnemocyte currently provides an MVP API with two backends:

- **In-memory backend** when `databaseUrl` is omitted.
- **Postgres + pgvector backend** when `databaseUrl` is provided.

The package is ESM-only. Use `import` rather than CommonJS `require`.

## Install

```bash
pnpm add mnemocyte
```

## Basic usage

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

## Postgres usage

Run the included migration against a Postgres database with pgvector enabled, then pass `databaseUrl`:

```ts
const client = createMnemocyte({
databaseUrl: process.env.DATABASE_URL,
embedder,
});
```

The published package includes `migrations/0000_initial.sql`.

## Provider resilience

Mnemocyte applies an optional timeout and retry policy to every outbound
embedder call, and forwards `AbortSignal` cancellation to in-flight
attempts. Defaults disable both retries and timeouts so existing setups
are unaffected.

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

Failures surface as `MnemocyteError` with stable `code`s:

- `"TIMEOUT"` — a single provider attempt exceeded `timeoutMs`.
- `"ABORTED"` — the operation was cancelled via `signal` (never retried).
- `"EMBEDDING"` — the embedder failed after all retries are exhausted.

## Pruning memories

`prune` bulk-deletes memories matching a filter. At least one selector
is required; `prune({})` is rejected to avoid accidental full deletion.

```ts
// Drop expired memories for one entity.
await client.prune({ entityId: "user_123", expired: true });

// Evict memories not accessed in the last 30 days, but never drop
// "high" or "critical" memories.
await client.prune({
notAccessedSince: new Date(Date.now() - 30 * 24 * 3600 * 1000),
maxImportance: "normal",
});

// Count what would be deleted without touching the store.
const preview = await client.prune({
entityId: "user_123",
superseded: true,
dryRun: true,
});
console.log(preview.matchedCount);
```

Available selectors: `entityId`, `expired`, `superseded`, `createdBefore`,
`notAccessedSince`, `types`, `tags`, `maxImportance`. They AND together.

## Finding duplicates (experimental)

`findDuplicates` is a **read-only** scan that surfaces near-identical
memories for one entity using pairwise cosine similarity. It is
intentionally passive — nothing is deleted or modified — so callers can
decide their own consolidation policy.

```ts
const pairs = await client.findDuplicates({
entityId: "user_123",
threshold: 0.95, // default 0.95
limit: 50, // default 100, ordered by similarity desc
});

for (const { a, b, similarity } of pairs) {
console.log(similarity.toFixed(3), a.content, "<>", b.content);
}
```

Optional selectors: `types`, `tags` (both required on each pair member),
`includeSuperseded`, `includeExpired`. Superseded and expired memories
are excluded by default.

> Part of Phase 6 (consolidation tooling). The API surface may change in
> follow-up releases as conflict detection and active dedup land.

## Retrieval tuning

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

## Development checks

```bash
pnpm checktypes
pnpm lint
pnpm run test:retrieval
pnpm run test:integration
pnpm run pack:check
```

`test:integration` skips cleanly when `DATABASE_URL` is not set.

## Architecture

See `ARCHITECTURE.md` for the canonical architecture, roadmap, and production plan.
