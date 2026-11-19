# Examples

Small scripts that use Mnemocyte the way an app does, importing
`mnemocyte` by name. Node.js 22.18 and later run `.ts` files directly, so
there is no build step for the examples themselves.

From the repository root, install and build the package once:

```bash
pnpm install
pnpm build
```

Then set the keys an example needs and run it with `node`.

| File | Shows | Needs |
|---|---|---|
| [`in-memory.ts`](in-memory.ts) | Save, update with a `key`, `search` and `context`, with no database | `OPENAI_API_KEY` |
| [`pglite.ts`](pglite.ts) | Memories that survive a restart, in Postgres inside the process (no Docker) | `OPENAI_API_KEY` |
| [`postgres.ts`](postgres.ts) | Your own Postgres with pgvector, through postgres.js, with `migrate()` from code | `OPENAI_API_KEY`, `DATABASE_URL` |
| [`ai-sdk-chat.ts`](ai-sdk-chat.ts) | A terminal chat with `withMemory` that stores facts from each turn | `AI_GATEWAY_API_KEY` |

Run one without a database:

```bash
OPENAI_API_KEY=sk-... node examples/in-memory.ts
```

Save a memory with PGlite, then run it again to see it is still there:

```bash
node examples/pglite.ts "Drinks tea, not coffee."
node examples/pglite.ts
```

Each file starts with what it needs and how to run it. `postgres.ts` has
the `docker run` line for a local Postgres with pgvector. To set up your
own project, follow the [getting started guide](../docs/guide/getting-started.md).
