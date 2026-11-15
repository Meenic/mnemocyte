# Mnemocyte

Memory for TypeScript AI apps.

Mnemocyte (*nee-mo-site*, "memory cell") helps your AI app remember. Save
what it learns about users, agents and sessions, then pull back what matters
when you build a prompt.

Your memories live with the rest of your data, in the Postgres you already
run.

## Install

```bash
pnpm add mnemocyte
```

Needs Node.js 22.18 or newer.

## Usage

Create a memory with an embedder:

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const memory = createMemory({
  namespace: "my-app",
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

Pick whose memories you work with, here one user:

```ts
const user = memory.for({ entityId: "user_123" });
```

Save what your app learns about them:

```ts
await user.add({ content: "Prefers short, direct answers." });
```

Then get the relevant ones back as Markdown, ready for a system prompt:

```ts
const context = await user.context({ query: "How should I reply?" });
```

This example keeps memories in process memory. The
[getting started guide](docs/guide/getting-started.md)
moves them to Postgres in a few steps.

## Works with

- **[Postgres](docs/guide/postgres.md)**
  with pgvector, through postgres.js, node-postgres, PGlite or Drizzle
- **[The AI SDK](docs/guide/ai-sdk.md)**,
  as memory tools for a model or memory added to every prompt
- **[Embedders](docs/guide/embedders.md)**
  from OpenAI, Voyage, Cohere and Gemini, any OpenAI-compatible server such
  as Ollama, or your own

## Documentation

[Getting started](docs/guide/getting-started.md) ·
[API](docs/guide/api.md) ·
[Postgres](docs/guide/postgres.md) ·
[CLI](docs/guide/cli.md) ·
[Embedders](docs/guide/embedders.md) ·
[AI SDK](docs/guide/ai-sdk.md) ·
[Limitations](docs/guide/limitations.md) ·
[Upgrading from 0.x](docs/guide/upgrading.md) ·
[Changelog](CHANGELOG.md)

Want to help? Start with
[DEVELOPMENT.md](docs/DEVELOPMENT.md)
and the [roadmap](docs/ROADMAP.md).

## License

[MIT](LICENSE)
