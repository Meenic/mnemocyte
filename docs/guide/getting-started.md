# Getting started

This guide goes from an empty folder to memories in a prompt. You install
Mnemocyte, start Postgres, write a `memory.ts`, create the schema, then
store memories for a user and render them with `context()`.

You need Node.js 22.18 or newer, pnpm, Docker and an OpenAI API key. With
npm, install with `npm install` and run the `mnemocyte` command with
`npx mnemocyte`. To use a local model, see
[Use Ollama instead of OpenAI](#use-ollama-instead-of-openai). To try
Mnemocyte without a database, see
[Prototype without a database](#prototype-without-a-database).

## 1. Create the project

```bash
mkdir my-agent
cd my-agent
pnpm init
pnpm pkg set type=module
pnpm add mnemocyte postgres
pnpm add -D typescript @types/node
```

Node 22.18 and later run `.ts` files directly by stripping the types, so
there is no build step. TypeScript only checks types, in your editor and
with `tsc`. Add a `tsconfig.json` for it:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "types": ["node"],
    "noEmit": true,
    "rewriteRelativeImportExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

These are the settings the
[Node.js TypeScript docs](https://nodejs.org/docs/latest-v22.x/api/typescript.html)
recommend. Imports name the `.ts` file (`./memory.ts`), and syntax Node
cannot strip, such as `enum`, is a type error.

## 2. Start Postgres

Run Postgres 18 with pgvector 0.8.7, the image Mnemocyte's CI uses:

```bash
docker run -d --name mnemocyte-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:0.8.7-pg18
```

If port 5432 is taken, map another one (`-p 5433:5432`) and use it in
`DATABASE_URL`. Any Postgres with pgvector 0.8.0 or later works, including
Neon, Supabase and RDS; see the
[requirements](./postgres.md#requirements).

## 3. Add `.env`

```txt
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
OPENAI_API_KEY=sk-...
```

Keep it out of git:

```bash
echo ".env" >> .gitignore
echo "node_modules" >> .gitignore
```

The app script loads `.env` with Node's `--env-file` flag, and the
`mnemocyte` command reads it from the current folder.

## 4. Write `memory.ts`

`memory.ts` creates the memory client once and exports it, for your app
and your scripts to share:

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL!);

export const memory = createMemory({
  namespace: "my-agent",
  store: sql,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

- `namespace` is the default for every call: your app, or a tenant in a
  multi-tenant app.
- `store` is your own database client, here a
  [postgres.js](https://github.com/porsager/postgres) `sql`. For `pg`,
  Drizzle or PGlite, see [Other drivers](#other-drivers).
- `openaiEmbedder` reads `OPENAI_API_KEY`. `text-embedding-3-small`
  returns 1536-dimension vectors.
- The database client stays yours. A script ends it when it is done, and a
  server keeps it open. The memory client has no `close()`.

`pnpm exec mnemocyte init` can write this file for you. It picks the
version for the driver in your `package.json` and never overwrites a file;
see [`init`](./cli.md#init).

### Use Ollama instead of OpenAI

`openaiCompatibleEmbedder` calls any OpenAI-compatible server. For a local
[Ollama](https://ollama.com) with `ollama pull nomic-embed-text`:

```ts
import { openaiCompatibleEmbedder } from "mnemocyte/embedders";

embedder: openaiCompatibleEmbedder({
  baseURL: "http://localhost:11434/v1",
  model: "nomic-embed-text",
  dimensions: 768,
  // nomic-embed-text expects these prefixes on queries and documents
  purposes: {
    query: { prefix: "search_query: " },
    document: { prefix: "search_document: " },
  },
}),
```

Choose the embedder before step 5, because the schema is created for its
dimensions. For an Ollama chat or extraction model, see
[local models](./ai-sdk.md#local-models). Other providers are in the
[embedders guide](./embedders.md).

## 5. Create the schema

Mnemocyte never creates tables on its own. Create them with the
`mnemocyte` command that comes with the package:

```bash
pnpm exec mnemocyte migrate
```

It loads `memory.ts` for your database client and your embedder's
dimensions, and asks before it enables pgvector:

```txt
Using memory.ts
pgvector is not enabled in this database. Run CREATE EXTENSION vector now? [y/N] y
Enabled pgvector.
Applied: 0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2
```

`migrate` applies only what is missing, so run it on every deploy. Enabling
pgvector needs a superuser, which the Docker image's `postgres` user is; on
a managed database, see [enabling pgvector](./postgres.md#enabling-pgvector).
The [Postgres guide](./postgres.md#install-the-schema) covers upgrades and
`migrate()` from code, and the [CLI guide](./cli.md) every flag.

## 6. Store memories and build context

Add a start script to `package.json`:

```json
"scripts": {
  "start": "node --env-file=.env index.ts"
}
```

Write `index.ts`. `memory.for(scope)` returns a client bound to one scope,
here a user (`entityId`) in the default namespace:

```ts
import { memory, sql } from "./memory.ts";

const user = memory.for({ entityId: "user_123" });

try {
  await user.add({
    key: "style",
    kind: "preference",
    content: "Prefers short, direct answers without small talk.",
  });
  await user.add({
    key: "timezone",
    content: "Lives in Berlin; timezone is Europe/Berlin.",
  });
  await user.add({
    key: "project",
    content: "Is building an invoicing CLI in TypeScript.",
  });

  const context = await user.context({
    query: "When is the invoice due in the user's local time?",
    maxTokens: 500,
  });

  console.log(context);
} finally {
  // Close the pool so the script can exit; a server keeps it open.
  await sql.end();
}
```

Run it:

```bash
pnpm start
```

`context()` searches the user's memories with the query and renders the
best matches as Markdown that fits in `maxTokens`:

````md
# Memory Context

## Relevant Memories

- kind=fact; importance=normal; score=0.479
  ```text
  Is building an invoicing CLI in TypeScript.
  ```

- kind=fact; importance=normal; score=0.471
  ```text
  Lives in Berlin; timezone is Europe/Berlin.
  ```

- kind=preference; importance=normal; score=0.464
  ```text
  Prefers short, direct answers without small talk.
  ```
````

The order and scores depend on your embedder. Each `add` has a `key`, so a
second run updates the three memories in place. An `add` without a key
always inserts a new memory.

The `finally` block ends the database client because its open connections
keep Node running: without `sql.end()`, the script prints the context and
then never exits. A server does not end the client; it uses it until the
process stops.

In an app, bind a client per request from the signed-in user:

```ts
const user = memory.for({ entityId: session.userId });
const context = await user.context({ query: message, maxTokens: 800 });
```

Add `agentId` or `sessionId` to narrow the scope; see
[scopes](./api.md#scopes).

## Other drivers

Replace `memory.ts` with one of these; `pnpm exec mnemocyte migrate` stays the
same. In `index.ts`, import the client the file exports and end it the
driver's way: `pool.end()` for node-postgres, `sql.end()` or `pool.end()`
for Drizzle, and `client.close()` or `db.close()` for PGlite. How
Mnemocyte uses each driver is in [connect](./postgres.md#connect).

### node-postgres

```bash
pnpm add pg
pnpm add -D @types/pg
```

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const memory = createMemory({
  namespace: "my-agent",
  store: pool,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

Pass a `Pool`; a `pg.Client` throws `"CONFIG"`.

### Drizzle

Drizzle over postgres.js:

```bash
pnpm add drizzle-orm
```

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import postgres from "postgres";

export const sql = postgres(process.env.DATABASE_URL!);
export const db = drizzle({ client: sql });

export const memory = createMemory({
  namespace: "my-agent",
  store: db,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

Drizzle over node-postgres:

```bash
pnpm add drizzle-orm pg
```

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import pg from "pg";

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle({ client: pool });

export const memory = createMemory({
  namespace: "my-agent",
  store: db,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

Drizzle over PGlite (see [PGlite](#pglite) below):

```bash
pnpm add drizzle-orm @electric-sql/pglite @electric-sql/pglite-pgvector
```

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { drizzle } from "drizzle-orm/pglite";
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

export const client = await PGlite.create({
  dataDir: "./memory-data",
  extensions: { vector },
});
export const db = drizzle({ client });

export const memory = createMemory({
  namespace: "my-agent",
  store: db,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

Your Drizzle schema does not need Mnemocyte's tables.

### PGlite

[PGlite](https://pglite.dev) runs Postgres inside your process, so it needs
neither Docker nor `DATABASE_URL`:

```bash
pnpm add @electric-sql/pglite @electric-sql/pglite-pgvector
echo "memory-data" >> .gitignore
```

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

export const db = await PGlite.create({
  dataDir: "./memory-data",
  extensions: { vector },
});

export const memory = createMemory({
  namespace: "my-agent",
  store: db,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

A data folder opens in one process at a time, so run
`pnpm exec mnemocyte migrate` while the app is stopped, or call
`migrate({ memory, createExtension: true })` when the app starts.

## Prototype without a database

Leave out `store` and memories live in process memory until it exits. Do
step 1 without the `postgres` package, put only `OPENAI_API_KEY` in `.env`,
skip steps 2 and 5, and use this `memory.ts`:

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

export const memory = createMemory({
  namespace: "my-agent",
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

In `index.ts` from step 6, drop the `sql` import and the `sql.end()` line.
Moving to Postgres later means steps 2 to 5, with the same calls.

## Next

- [API reference](./api.md): every method, scopes and errors.
- [CLI](./cli.md): `mnemocyte init`, `migrate`, `check` and `sql`.
- [Postgres](./postgres.md): drivers, poolers, `migrate`, upgrades and
  indexes.
- [Embedders](./embedders.md): providers, custom embedders, timeouts and
  retries.
- [AI SDK](./ai-sdk.md): memory tools, memory in every prompt and
  extraction.
- [Limitations](./limitations.md): what does not work yet.
