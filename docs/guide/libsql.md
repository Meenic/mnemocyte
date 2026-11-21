# libSQL and Turso

Mnemocyte can keep memories in a libSQL database: a local file, a database
on Turso Cloud, or your own libSQL server. Vector search and keyword search
are built into libSQL, so there is no extension to enable.

## Requirements

- Node.js 22.18 or newer.
- `@libsql/client` 0.18 (`^0.18.0`), the client Turso recommends for remote
  databases and ORMs. Any of its entry points works (`@libsql/client`,
  `/web`, `/http`, `/ws`), and so does Drizzle over it
  (`drizzle-orm/libsql`).
- A libSQL engine: a `file:` URL through `@libsql/client`, Turso Cloud
  (`libsql://…`), or a libSQL server (`sqld`).

Plain SQLite (`better-sqlite3`, `node:sqlite`) does not work: it has no
`vector32` or `vector_distance_cos`. Turso's newer clients,
`@tursodatabase/database` and `@tursodatabase/serverless`, run a rewritten
engine whose docs do not list these functions yet; they are not supported
or tested.

## Connect

Install the client:

```bash
pnpm add mnemocyte @libsql/client
```

Pass the client as `store`, the way you would pass a Postgres client:

```ts
import { createClient } from "@libsql/client";
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";

const client = createClient({ url: "file:memory.db" });

export const memory = createMemory({
  namespace: "my-app",
  store: client,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

On Turso Cloud, use the database URL and a token:

```ts
const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
```

A Drizzle instance works as `store` too; Mnemocyte runs its SQL on
`db.$client`:

```ts
import { drizzle } from "drizzle-orm/libsql";

const db = drizzle({ client });
const memory = createMemory({ store: db, embedder });
```

`libsqlStore({ client })` from `mnemocyte/libsql` builds the same store
when you want it apart from `createMemory`. Mnemocyte never closes the
client.

## Install the schema

Run `migrate` once, from the CLI with your memory file:

```bash
pnpm exec mnemocyte migrate
```

Or from code:

```ts
import { migrate } from "mnemocyte";

await migrate({ memory });
```

It creates the tables, the keyword index and its triggers in one write
transaction and records migration `0000_initial` in
`mnemocyte_migrations`. Calling it again applies nothing. `dryRun: true`
reports what it would do and changes nothing.

- The embedding size is fixed at install: `embedder.dimensions`, or
  `dimensions` when you pass `store` instead of `memory`. libSQL takes 1 to
  65,536 dimensions. The CLI's `--dimensions` flag still stops at 4,000;
  for a larger embedder, let the memory file set it.
- `createExtension` has no effect: there is nothing to enable.
- Tables that `migrate` did not create (no rows in `mnemocyte_migrations`)
  throw `"MIGRATION"`. A libSQL installation is always created by
  `migrate`.

`mnemocyte check` reports what is installed, and `mnemocyte text-search`
changes the keyword search language. The CLI reaches libSQL only through a
memory file; without one it connects to `DATABASE_URL` with postgres.js.

## Keyword search language

Keyword search uses SQLite's FTS5 with `bm25` ranking. Pick its tokenizer
at install with `textSearchConfig`:

| Name | What it does |
|---|---|
| `porter` (default) | Folds case, removes accents and stems English words, so "runs" finds "running". |
| `unicode61` | Folds case and removes accents, no stemming. Better for memories in other languages. |

```ts
await migrate({ memory, textSearchConfig: "unicode61" });
```

To change it later:

```bash
pnpm exec mnemocyte text-search unicode61
```

This rebuilds the keyword index from every memory's content in one write
transaction. Memory rows are not rewritten. FTS5 tokenizes queries with
the index's own tokenizer, so other running processes keep working.

How a query is matched:

- Each word of the query is searched on its own, and a memory matches when
  it contains any of them. `bm25` ranks memories that contain more of the
  words, and rarer ones, higher. FTS5 has no stop words, so requiring every
  word, as Postgres does, would miss memories over words like "the".
- Words are matched literally. `NOT`, `NEAR`, `*`, quotes and `column:` in
  a query are words, not FTS5 operators.
- Up to 64 distinct words of a query are used.

## How search works

Vector search compares the query with every memory in the scope: an exact
cosine scan over the rows the scope index selects. Filters (`kinds`, tags,
dates) apply before the ranking, so a search never returns fewer results
than exist. There is no vector index yet.

The cost grows with the size of one scope, not of the table. Measured on a
local file with 1,536-dimension embeddings (`pnpm bench:libsql`):

| Memories in the scope | `search` | `search`, no keyword match | same, with `kinds` keeping a tenth |
|---|---|---|---|
| 1,000 | 80 ms | 53 ms | 21 ms |
| 10,000 | 0.73 s | 0.47 s | 0.14 s |
| 50,000 | 3.2 s | 1.8 s | 0.64 s |

`findDuplicates` took 1.2 s at 1,000 memories and 121 s at 10,000; one
`findDuplicatesPage` of 100 took 0.38 s and 3.3 s.

`findDuplicates` compares every pair of memories in the scope, so its time
grows with the square of the scope. Use
[`experimental.findDuplicatesPage`](./api.md#in-pages-experimental) for
large scopes.

On Turso Cloud each search counts every memory of its scope as a row
read, which Turso's plans meter.

## One embedding model per database

The `mnemocyte_meta` row records the embedding dimensions and, after the
first write, the model. A client with another model or size throws
`"CONFIG"`, as on Postgres. If the row was deleted, put it back with the
dimensions you installed:

```sql
INSERT INTO mnemocyte_meta (key, embedding_dimensions, vector_type)
VALUES ('installation', 1536, 'F32_BLOB');
```

## Writes

Writes run one at a time: every write that needs several statements is one
libSQL batch in a `BEGIN IMMEDIATE` transaction. On a local file, writes
through one client queue up behind each other. When another process holds
the write lock on that file, a write fails with `"DB"` (`SQLITE_BUSY`);
retry it.

The client takes no `AbortSignal`: an aborted signal stops the next call
before it is sent, and a statement already sent runs to the end.

See [limitations](./limitations.md#libsql) for the rest.
