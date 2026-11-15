# Mnemocyte

Memory for TypeScript AI apps that lives in your app's own database.

Mnemocyte stores what your app learns about its users, agents and sessions
in the Postgres database you already run. It finds the relevant memories
with vector and keyword search and turns them into text for your prompt.

## Install

```bash
pnpm add mnemocyte
```

Mnemocyte needs Node.js 22.18 or newer. It is an ES module package, and
CommonJS can `require()` it.

1.0 is in release candidate: `pnpm add mnemocyte@next` installs the version
these docs describe.

## Quickstart

Every memory belongs to a scope: a `namespace` for your app or tenant, an
`entityId` for the user it is about, and optionally an `agentId` and a
`sessionId`. `memory.for(scope)` returns a client bound to one scope, so its
calls need no scope of their own.

This example keeps memories in process memory and embeds with OpenAI, so it
only needs `OPENAI_API_KEY`:

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const memory = createMemory({
  namespace: "my-app",
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

const user = memory.for({ entityId: "user_123" });

await user.add({ content: "Prefers short, direct answers." });
await user.add({ key: "timezone", content: "Lives in Berlin." });

const context = await user.context({ query: "How should I reply?" });
console.log(context);
```

`context` returns the best matches as Markdown, ready for a system prompt.
An `add` with a `key` updates the memory that has that key instead of
adding a copy.

## Postgres

Install a driver and start Postgres with pgvector:

```bash
pnpm add postgres
docker run -d --name mnemocyte-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:0.8.7-pg18
```

Pass your database client as `store` in a `memory.ts`:

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL!);

export const memory = createMemory({
  namespace: "my-app",
  store: sql,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

With `DATABASE_URL` and `OPENAI_API_KEY` in `.env`, create the schema:

```bash
npx mnemocyte migrate
```

`migrate` reads `memory.ts` and applies only what is missing, so run it on
every deploy. `npx mnemocyte init` writes `memory.ts` for the driver in
your `package.json`: postgres.js, node-postgres, PGlite or Drizzle.
Postgres needs pgvector 0.8.0 or later. See the
[getting started guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/getting-started.md)
for the full walkthrough and the
[Postgres guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md)
for drivers, upgrades and indexes.

## AI SDK

Give a model tools to search, save and forget memories:

```ts
import { memoryTools } from "mnemocyte/ai-sdk";

const tools = memoryTools({ memory: user });
```

Or add the relevant memories to every prompt:

```ts
import { openai } from "@ai-sdk/openai";
import { withMemory } from "mnemocyte/ai-sdk";

const model = withMemory({ model: openai("gpt-6.1-sol"), memory: user });
```

See the
[AI SDK guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/ai-sdk.md).

## Embedders

- OpenAI, Voyage, Cohere and Gemini: `mnemocyte/embedders`
- Ollama, LM Studio, vLLM, Mistral and other OpenAI-compatible servers:
  `openaiCompatibleEmbedder`
- Any AI SDK embedding model: `aiSdkEmbedder` from `mnemocyte/ai-sdk`
- Your own: an object with `model`, `dimensions` and `embed()`

See the
[embedders guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/embedders.md).

## API

- **Write:** `add`, `addMany`, `update`, `delete`, `deleteScope`
- **Read:** `search`, `context`, `get`, `list`
- **Maintain:** `prune`, `findDuplicates`, `consolidate`, `stats`,
  `listAuditLog`, `pruneAuditLog`
- **Setup:** `createMemory`, `for`, `migrate`, and the `mnemocyte` command
  (`init`, `migrate`, `check`, `sql`)

Errors are `MnemocyteError` with a stable `code` and, for `CONFIG`,
`CONFLICT` and `MIGRATION`, a `reason`. Mnemocyte follows semantic
versioning; `experimental.*` is outside it. See
[stability](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md#stability).

## Documentation

- [Getting started](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/getting-started.md)
- [API reference](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md)
- [Postgres](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md)
- [CLI](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/cli.md)
- [Embedders](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/embedders.md)
- [AI SDK](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/ai-sdk.md)
- [Limitations](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/limitations.md)
- [Upgrading from 0.x](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/upgrading.md)
- [Changelog](https://github.com/Meenic/mnemocyte/blob/main/CHANGELOG.md)
  and [roadmap](https://github.com/Meenic/mnemocyte/blob/main/docs/ROADMAP.md)
- Contributing: [DEVELOPMENT.md](https://github.com/Meenic/mnemocyte/blob/main/docs/DEVELOPMENT.md)
  and [AGENTS.md](https://github.com/Meenic/mnemocyte/blob/main/AGENTS.md)
