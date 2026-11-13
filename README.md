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
  namespace: "my-app",
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

const user = memory.for({ entityId: "user_123" });

await user.add({ content: "Prefers short, direct answers.", kind: "preference" });

const results = await user.search({ query: "How should I respond?" });

const context = await user.context({
  query: "How should I respond?",
  maxTokens: 500,
});
```

Every memory lives in a scope: a `namespace` (your tenant or app; here the
client's default) and an `entityId` (who the memory is about), plus an
optional `agentId` and `sessionId`. `memory.for(scope)` returns a client
bound to one scope; the unbound `memory` takes a `scope` on every call
instead. `openaiEmbedder` reads `OPENAI_API_KEY`. Without a `store`,
memories live in process memory, which suits tests and prototypes.

[Getting started](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/getting-started.md)
walks from an empty folder to a first `context()` call on Postgres, with
postgres.js, `pg`, Drizzle or PGlite.

## Postgres

Install your driver (`postgres`, `pg`, or PGlite); the database needs
pgvector 0.8.0 or later available:

```bash
pnpm add postgres
```

Pass the client you already have as `store` (a postgres.js `sql`, a `pg`
Pool, a PGlite instance or a Drizzle instance), then create or upgrade the
schema with `migrate`, for example in a deploy step:

```ts
import { createMemory, migrate } from "mnemocyte";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const memory = createMemory({ store: sql, embedder });

await migrate({ memory, createExtension: true });
```

`migrate` takes the embedding size from your embedder and fixes it when the
schema is created. `createExtension: true` enables pgvector first, which
needs a superuser or your provider's admin role; if yours may not, have an
admin run `CREATE EXTENSION vector;` once and drop the option. `migrate`
applies only what is missing, so it is safe in every deploy, and
`dryRun: true` shows what it would do. Each driver, applying the SQL files
with `psql` instead, and upgrades are in the
[Postgres guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md).

## API at a glance

- `migrate`: create or upgrade the Postgres schema.
- `for`: a client bound to one scope, whose methods take no `scope`.
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

Any object with `model`, `dimensions` and `embed(texts, options)` works.
`options.purpose` says whether the texts are queries or documents:

```ts
const embedder = {
  model: "my-model",
  dimensions: 768,
  async embed(texts, options) {
    return embedWithYourProvider(texts, {
      inputType: options.purpose,
      signal: options.signal,
    });
  },
};
```

`mnemocyte/embedders` has two that use `fetch`: `openaiEmbedder` for OpenAI
and `openaiCompatibleEmbedder` for Ollama, LM Studio, vLLM, Mistral and other
servers with an OpenAI-shaped `/embeddings`. With the AI SDK installed,
`mnemocyte/ai-sdk` turns any AI SDK embedding model into an embedder:

```ts
import { aiSdkEmbedder } from "mnemocyte/ai-sdk";

const embedder = aiSdkEmbedder({ model: "openai/text-embedding-3-small" });
```

Failed calls are retried twice with backoff and `Retry-After`. Retries,
timeouts and provider errors are in the
[embedders guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/embedders.md).

## AI SDK tools

`memoryTools` gives a model `searchMemories`, `saveMemory` and
`forgetMemory` tools for one user. The scope is bound on your server, so
the model cannot reach anyone else's memories:

```ts
import { generateText, stepCountIs } from "ai";
import { memoryTools } from "mnemocyte/ai-sdk";

const { text } = await generateText({
  model: "openai/gpt-5",
  tools: memoryTools({ memory: memory.for({ entityId: userId }) }),
  stopWhen: stepCountIs(5),
  prompt,
});
```

Inputs, outputs and approval are in the
[AI SDK guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/ai-sdk.md).

## Documentation

- [Getting started](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/getting-started.md)
- [API reference](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md)
- [Postgres](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md)
- [Embedders](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/embedders.md)
- [AI SDK](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/ai-sdk.md)
- [Limitations](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/limitations.md)
- [Roadmap](https://github.com/Meenic/mnemocyte/blob/main/docs/ROADMAP.md)
- [Changelog](https://github.com/Meenic/mnemocyte/blob/main/CHANGELOG.md)

## Contributing

See [DEVELOPMENT.md](https://github.com/Meenic/mnemocyte/blob/main/docs/DEVELOPMENT.md)
and [AGENTS.md](https://github.com/Meenic/mnemocyte/blob/main/AGENTS.md).
