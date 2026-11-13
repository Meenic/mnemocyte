# Getting started

From an empty folder to memories in a prompt: install Mnemocyte, start
Postgres, write a `memory.ts`, create the schema, then store memories for a
user and render them with `context()`.

You need Node.js 22.18 or newer, pnpm (npm works the same), Docker for a
local Postgres, and an OpenAI API key (or [Ollama](#use-ollama-instead-of-openai)).
To try Mnemocyte without a database, see [Prototype without a
database](#prototype-without-a-database).

## 1. Create the project

```bash
mkdir my-agent
cd my-agent
pnpm init
pnpm pkg set type=module
pnpm add mnemocyte postgres
pnpm add -D typescript @types/node
```

`"type": "module"` makes Node load the `.ts` files below as ES modules.
Node 22.18 and later run TypeScript files directly by stripping the types,
so there is no build step; TypeScript is only for type checking in your
editor and with `tsc`. Add a `tsconfig.json` for that:

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
recommend: imports name the `.ts` file (`./memory.ts`), and syntax Node
cannot strip, such as `enum`, is a type error. `skipLibCheck` skips type
errors inside some drivers' own declaration files.

## 2. Start Postgres

Run Postgres 18 with pgvector 0.8.7, the image Mnemocyte's CI uses:

```bash
docker run -d --name mnemocyte-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 pgvector/pgvector:0.8.7-pg18
```

If port 5432 is taken, use another host port (`-p 5433:5432`) and change it
in `DATABASE_URL` below. Any Postgres with pgvector 0.8.0 or later works,
including Neon, Supabase and RDS; see the
[Postgres guide](./postgres.md#requirements).

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

The scripts below load it with Node's `--env-file` flag; nothing else reads
it.

## 4. Write `memory.ts`

`memory.ts` builds the memory client once and exports it as `memory`, for
your app and your scripts to share:

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

export const memory = createMemory({
  namespace: "my-agent",
  store: sql,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

export async function closeDatabase() {
  await sql.end();
}
```

- `namespace` is the default for every call: your app, or your tenant in a
  multi-tenant app. A call can still name another one.
- `store` is the database client your app already has; here a
  [postgres.js](https://github.com/porsager/postgres) `sql`. Mnemocyte
  recognises the driver by its shape and loads its Postgres code on the
  first call. Using `pg`, Drizzle or PGlite instead? See
  [other drivers](#other-drivers).
- `openaiEmbedder` reads `OPENAI_API_KEY` and calls OpenAI with `fetch`.
  `text-embedding-3-small` returns 1536-dimension vectors.
- The client holds no connections of its own and has no `close()`. Your
  database client stays yours, so `closeDatabase()` ends it when a script
  is done.

### Use Ollama instead of OpenAI

`openaiEmbedder` calls any OpenAI-compatible endpoint. For a local
[Ollama](https://ollama.com) with `ollama pull nomic-embed-text`:

```ts
embedder: openaiEmbedder({
  model: "nomic-embed-text",
  dimensions: 768,
  baseUrl: "http://localhost:11434/v1",
  apiKey: "ollama", // Ollama ignores the key, but one is required
}),
```

Choose the embedder before step 5: the schema is created for its
dimensions, and an installation keeps one embedding model. Other providers
are in the [embedders guide](./embedders.md).

## 5. Create the schema

Mnemocyte never creates tables on its own. Create them with `migrate`, from
a script of its own, `migrate.ts`:

```ts
import { migrate } from "mnemocyte";
import { closeDatabase, memory } from "./memory.ts";

try {
  const result = await migrate({ memory, createExtension: true });
  console.log(result);
} finally {
  await closeDatabase();
}
```

Add it and the app to `package.json`:

```json
"scripts": {
  "db:migrate": "node --env-file=.env migrate.ts",
  "start": "node --env-file=.env index.ts"
}
```

```bash
pnpm db:migrate
```

```txt
{
  applied: [
    '0000_initial',
    '0001_add_mnemocyte_meta',
    '0002_add_embedding_model',
    '0003_schema_v2'
  ],
  adopted: [],
  extensionCreated: true
}
```

`migrate` takes the embedding size from your embedder and applies only what
is missing, so a second run applies nothing; run it on every deploy, before
the app starts. `createExtension: true` enables pgvector in the database,
which needs a superuser (the Docker image's `postgres` user is one). On a
managed database whose app role may not create extensions, have an admin
run `CREATE EXTENSION vector;` once and drop the option. The
[Postgres guide](./postgres.md#install-the-schema) covers `dryRun`, upgrades
and applying the SQL files with `psql` instead.

## 6. Store memories and build context

`memory.for(scope)` returns a client bound to one scope, so its calls take
no `scope`. Here the scope is a user (`entityId`) in the default namespace.
Write `index.ts`:

```ts
import { closeDatabase, memory } from "./memory.ts";

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
  await closeDatabase();
}
```

```bash
pnpm start
```

`context()` searches the user's memories with the query and renders the
best matches as Markdown that fits in `maxTokens`, ready to put in a system
prompt:

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

The order and scores depend on your embedder. Each `add` has a `key`, so
running the script again updates the three memories in place instead of
adding copies; an `add` without a key always inserts a new memory.

In an app, bind a client per request from the signed-in user, and add
`agentId` or `sessionId` to narrow the scope:

```ts
const user = memory.for({ entityId: session.userId });
const context = await user.context({ query: message, maxTokens: 800 });
```

Scopes, `search`, `list`, `deleteScope` and the other methods are in the
[API reference](./api.md).

## Other drivers

Replace `memory.ts` with one of these; `migrate.ts` and `index.ts` stay the
same.

### node-postgres

```bash
pnpm add pg
pnpm add -D @types/pg
```

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const memory = createMemory({
  namespace: "my-agent",
  store: pool,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

export async function closeDatabase() {
  await pool.end();
}
```

Pass a `Pool`, not a `pg.Client`, which throws `"CONFIG"`.

### Drizzle

```bash
pnpm add drizzle-orm
```

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
export const db = drizzle({ client: sql });

export const memory = createMemory({
  namespace: "my-agent",
  store: db,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

export async function closeDatabase() {
  await sql.end();
}
```

Mnemocyte runs its own SQL on the Drizzle instance's client, so your Drizzle
schema does not need its tables. `drizzle-orm/node-postgres` (over a `Pool`)
and `drizzle-orm/pglite` work the same way.

### PGlite

[PGlite](https://pglite.dev) runs Postgres inside your process, so it needs
no Docker, no `DATABASE_URL` and no `postgres` package:

```bash
pnpm add @electric-sql/pglite @electric-sql/pglite-pgvector
echo "memory-data" >> .gitignore
```

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const db = await PGlite.create({
  dataDir: "./memory-data",
  extensions: { vector },
});

export const memory = createMemory({
  namespace: "my-agent",
  store: db,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

export async function closeDatabase() {
  await db.close();
}
```

A data folder can be open in one process at a time, so run
`pnpm db:migrate` while the app is stopped, or call
`migrate({ memory, createExtension: true })` when your app starts.

## Prototype without a database

Leave out `store` and memories live in process memory: no Docker, no
driver, no `migrate`. They are gone when the process exits. Do step 1
without the `postgres` package, put only `OPENAI_API_KEY` in `.env`, and
use this `memory.ts`:

```ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

export const memory = createMemory({
  namespace: "my-agent",
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});

export async function closeDatabase() {}
```

`index.ts` from step 6 runs unchanged. Moving to Postgres later is steps 2
to 5 with the same calls.

## Next

- [API reference](./api.md): every method, scopes and errors.
- [Postgres](./postgres.md): drivers, poolers, `migrate`, upgrades and
  indexes.
- [Embedders](./embedders.md): custom embedders, timeouts and retries.
- [Limitations](./limitations.md): what does not work yet.
