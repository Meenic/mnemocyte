# Mnemocyte

Infrastructure-native memory for TypeScript AI applications.

Mnemocyte stores memories for users, agents and sessions in your own
database, recalls the relevant ones with hybrid vector and keyword search,
and renders them as prompt-ready context. You bring the embedder and the
database; there is no service and no provider SDK.

> Mnemocyte is pre-1.0. APIs may change in minor releases.

## Install

```bash
pnpm add mnemocyte
```

Requires Node.js 22.18 or newer. Mnemocyte ships as ES modules; CommonJS code
can load it with `require()`.

## Quickstart

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const memory = createMemory({
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

const scope = { namespace: "my-app", entityId: "user_123" };

await memory.add({
  scope,
  content: "Prefers short, direct answers.",
  kind: "preference",
});

const results = await memory.search({ scope, query: "How should I respond?" });

const context = await memory.context({
  scope,
  query: "How should I respond?",
  maxTokens: 500,
});
```

Every call names a scope: a `namespace` (your tenant or app) and an
`entityId` (who the memory is about), plus an optional `agentId` and
`sessionId`. `openaiEmbedder` reads `OPENAI_API_KEY`. Without a `store`,
memories live in process memory, which suits tests and prototypes.

## Postgres

Install your driver (`postgres`, `pg`, or PGlite) and enable pgvector
(0.8.0 or later):

```bash
pnpm add postgres
```

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Pass the client you already have (a postgres.js `sql`, a `pg` Pool, a
PGlite instance or a Drizzle instance), and create or upgrade the schema
with `migrate`:

```ts
import { createMemory, migrate } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const store = postgresStore({ client: sql });

await migrate({ store, dimensions: 1536 });

const memory = createMemory({ store, embedder });
```

`dimensions` must match your embedder and is fixed when the schema is
created. `migrate` applies only what is missing, so it is safe in every
deploy. Each driver, applying the SQL files with `psql` instead, and
upgrades are in the
[Postgres guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md).

## API at a glance

- `migrate`: create or upgrade the Postgres schema.
- `add`, `addMany`: store memories; a `key` makes the add update in place.
- `search`: rank a scope's memories against a query.
- `get`, `list`: read one memory by id or key, or page through a scope.
- `update`, `delete`: change or delete one memory.
- `deleteScope`: erase everything about an entity, or one agent or session.
- `context`: render search results as Markdown, plain text or XML within a
  token budget.
- `prune`: delete memories in a scope by expiry, age, access, kind, tags or
  importance.
- `findDuplicates`: list pairs of near-identical memories.
- `experimental.consolidate`: mark duplicates as replaced by one memory.
- `listAuditLog`: read the optional audit log.
- `stats`: count memories in a scope or the whole installation.

The client holds no connections, so there is nothing to close; your database
client stays yours.

Errors are `MnemocyteError` with a stable `code`. Every option is in the
[API reference](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md).

## Embedders

Any object with `model`, `dimensions` and `embed(texts)` works:

```ts
const embedder = {
  model: "my-model",
  dimensions: 768,
  async embed(texts, options) {
    return embedWithYourProvider(texts, { signal: options?.signal });
  },
};
```

`openaiEmbedder` from `mnemocyte/embedders` calls OpenAI or any compatible
endpoint with `fetch`. Retries, timeouts and cancellation are in the
[embedders guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/embedders.md).

## Documentation

- [API reference](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md)
- [Postgres](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md)
- [Embedders](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/embedders.md)
- [Limitations](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/limitations.md)
- [Roadmap](https://github.com/Meenic/mnemocyte/blob/main/docs/ROADMAP.md)
- [Changelog](https://github.com/Meenic/mnemocyte/blob/main/CHANGELOG.md)

## Contributing

See [DEVELOPMENT.md](https://github.com/Meenic/mnemocyte/blob/main/docs/DEVELOPMENT.md)
and [AGENTS.md](https://github.com/Meenic/mnemocyte/blob/main/AGENTS.md).
