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
import { createMnemocyte } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const client = createMnemocyte({
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

await client.remember({
  entityId: "user_123",
  content: "Prefers short, direct answers.",
  type: "preference",
});

const memories = await client.recall({
  entityId: "user_123",
  query: "How should I respond?",
});

const context = await client.buildContext({
  entityId: "user_123",
  query: "How should I respond?",
  maxTokens: 500,
});
```

`openaiEmbedder` reads `OPENAI_API_KEY`. Without a `store`, memories live in
process memory, which suits tests and prototypes.

## Postgres

Install the driver and enable pgvector:

```bash
pnpm add postgres
```

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

Pass your own postgres.js client, and create or upgrade the schema with
`migrate`:

```ts
import { createMnemocyte, migrate } from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const store = postgresStore({ client: postgresJs(sql) });

await migrate({ store, dimensions: 1536 });

const client = createMnemocyte({ store, embedder });
```

`dimensions` must match your embedder and is fixed when the schema is
created. `migrate` applies only what is missing, so it is safe in every
deploy. Applying the SQL files with `psql` instead, upgrades, Drizzle and
connection details are in the
[Postgres guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md).

## API at a glance

- `migrate`: create or upgrade the Postgres schema.
- `remember`, `rememberMany`: store memories for an entity.
- `recall`: rank an entity's memories against a query.
- `buildContext`: render recalled memories as Markdown, plain text or XML
  within a token budget.
- `forget`, `forgetAll`: delete one memory or all of an entity's memories.
- `prune`: delete memories by expiry, age, access, type, tags or importance.
- `findDuplicates`: list pairs of near-identical memories.
- `experimental.consolidate`: mark duplicates as replaced by one memory.
- `listAuditLog`: read the optional audit log.
- `stats`: count memories per entity or installation.
- `close`: stop the client.

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
