# Mnemocyte

Infrastructure-native memory for TypeScript AI applications.

Mnemocyte stores what your app learns about users, agents and sessions in
the database you already run, finds the relevant memories with hybrid
vector and keyword search, and turns them into prompt-ready context.

> Pre-1.0: APIs may change in minor releases.

## Install

```bash
pnpm add mnemocyte
```

Node.js 22.18 or newer. ES modules; CommonJS can `require()` it.

### Databases

- [postgres.js](https://github.com/porsager/postgres): `pnpm add postgres`
- [node-postgres](https://node-postgres.com): `pnpm add pg`
- [PGlite](https://pglite.dev): `pnpm add @electric-sql/pglite`
- [Drizzle](https://orm.drizzle.team) over any of them

Postgres needs pgvector 0.8.0 or later. Without a database, memories live
in process memory.

### Embedders

- OpenAI, Voyage, Cohere, Gemini: `mnemocyte/embedders`
- Ollama, LM Studio, vLLM, Mistral: `openaiCompatibleEmbedder`
- Any AI SDK model: `aiSdkEmbedder`
- Your own: `{ model, dimensions, embed() }`

## Get started

### Create a client

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const memory = createMemory({
  namespace: "my-app",
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

### Remember

```ts
const user = memory.for({ entityId: "user_123" });

await user.add({ content: "Prefers short, direct answers." });
```

### Recall

```ts
const context = await user.context({ query: "How should I reply?" });
```

`context` returns the relevant memories as prompt-ready text. See
[Getting started](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/getting-started.md)
for the full walkthrough on Postgres.

## Postgres

```ts
// memory.ts
import { createMemory } from "mnemocyte";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
export const memory = createMemory({ store: sql, embedder });
```

```bash
npx mnemocyte migrate
```

`migrate` reads `memory.ts` and creates or upgrades the schema. Run it in
every deploy; it applies only what is missing. See the
[Postgres guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md)
and the [CLI guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/cli.md).

## AI SDK

Give a model tools to search, save and forget:

```ts
const tools = memoryTools({ memory: user });
```

Or put relevant memories in every prompt:

```ts
const model = withMemory({ model: openai("gpt-6.1-sol"), memory: user });
```

Both come from `mnemocyte/ai-sdk`. See the
[AI SDK guide](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/ai-sdk.md).

## Scopes

Every memory belongs to a `namespace` and an `entityId`, plus an optional
`agentId` and `sessionId`. `memory.for(scope)` binds a client to one.

## API

- **Write:** `add`, `addMany`, `update`, `delete`, `deleteScope`
- **Read:** `search`, `context`, `get`, `list`
- **Maintain:** `prune`, `findDuplicates`, `consolidate`, `stats`,
  `listAuditLog`, `pruneAuditLog`
- **Setup:** `migrate`, `for`, and the `mnemocyte` command (`migrate`,
  `check`, `sql`)

Errors are `MnemocyteError` with a stable `code`. See the
[API reference](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md).

## Documentation

- [Getting started](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/getting-started.md)
- [API reference](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md)
- [Postgres](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/postgres.md)
- [CLI](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/cli.md)
- [Embedders](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/embedders.md)
- [AI SDK](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/ai-sdk.md)
- [Limitations](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/limitations.md)
- [Roadmap](https://github.com/Meenic/mnemocyte/blob/main/docs/ROADMAP.md) · [Changelog](https://github.com/Meenic/mnemocyte/blob/main/CHANGELOG.md)

## Contributing

See [DEVELOPMENT.md](https://github.com/Meenic/mnemocyte/blob/main/docs/DEVELOPMENT.md)
and [AGENTS.md](https://github.com/Meenic/mnemocyte/blob/main/AGENTS.md).
