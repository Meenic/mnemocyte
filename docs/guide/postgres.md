# Postgres

How to set up, connect and upgrade the Postgres + pgvector backend. The
in-memory backend needs none of this.

## Requirements

- Postgres with the [pgvector](https://github.com/pgvector/pgvector)
  extension available. CI tests Postgres 17 and 18 with pgvector 0.8.
- A database role that can create the extension (once) and the Mnemocyte
  tables.
- The `postgres` (postgres.js) package next to Mnemocyte. It is an optional
  peer dependency; Mnemocyte itself has no runtime dependencies.

Mnemocyte never creates extensions, tables or indexes when a client is
created. You apply the bundled SQL files yourself.

## Fresh install

The commands below use `psql` and assume `DATABASE_URL` points at the target
database. `-v ON_ERROR_STOP=1 --single-transaction` makes `psql` stop at the
first error and roll the whole file back, so a failed run never leaves a
partial schema. Without those flags, `psql -f` keeps going after an error.

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/fresh-install.sql
```

`fresh-install.sql` creates the schema for 1536-dimension embeddings
(OpenAI's `text-embedding-3-small`, for example). Use it only on a database
that has no Mnemocyte tables yet.

### Other dimensions

For a different embedding size, render the initial migration from the
bundled template and apply the rendered file instead of `fresh-install.sql`:

```bash
node node_modules/mnemocyte/migrations/render-initial.mjs --dimensions 768 --out migrations/0000_initial.768.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f migrations/0000_initial.768.sql
```

The rendered file is a complete schema; do not also apply the numbered
migrations. The bundled HNSW index supports at most 2,000 dimensions, so a
rendered file above that fails at `CREATE INDEX` (see
[limitations](./limitations.md)).

## Connect

Create the postgres.js client yourself and wrap it with `postgresJs`:

```ts
import { createMnemocyte } from "mnemocyte";
import { postgresJs, postgresStore } from "mnemocyte/postgres";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 10 });

const client = createMnemocyte({
  store: postgresStore({ client: postgresJs(sql) }),
  embedder,
});

try {
  // ...
} finally {
  await client.close(); // does not end sql
  await sql.end();
}
```

You own the client: TLS, pool size, timeouts and `prepare` are whatever you
configure, and `client.close()` never ends it.

Mnemocyte sends plain parameterized statements and never uses named prepared
statements, so a transaction-mode pooler (PgBouncer, Supavisor) works without
`prepare: false`.

### Bring another driver

`postgresStore` takes any `SqlExecutor`, a two-method interface exported from
`mnemocyte/postgres`:

```ts
interface SqlExecutor {
  query<Row>(sql: string, params: readonly unknown[], options?: { signal?: AbortSignal }): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
```

Statements use `$1…` placeholders. `postgresJs` is the only adapter that
ships today; Drizzle, PGlite and node-postgres adapters are planned.

### Drizzle

If your application already has a postgres.js-backed Drizzle instance, pass
it through `mnemocyte/stores/drizzle`:

```ts
import { createMnemocyte } from "mnemocyte";
import { drizzleStore } from "mnemocyte/stores/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const db = drizzle(sql);

const client = createMnemocyte({ store: drizzleStore(db), embedder });
```

`drizzleStore(db)` runs Mnemocyte's SQL on the postgres.js client behind `db`
and shares its pool. Your Drizzle schema does not need to include Mnemocyte's
tables, but the migrations must already be applied. Only
`drizzle-orm/postgres-js` instances are supported; anything else throws
`MnemocyteError` code `"CONFIG"` when `drizzleStore` is called.

## Upgrade an existing installation

Existing installations use the numbered migrations. Never apply
`fresh-install.sql` over an existing Mnemocyte schema.

| Installed version | Apply |
|---|---|
| 0.1.x | `0001_add_mnemocyte_meta.sql`, then `0002_add_embedding_model.sql` |
| 0.2.x, 0.3.x | `0002_add_embedding_model.sql` |
| 0.4.x and later | nothing |

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/0001_add_mnemocyte_meta.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/0002_add_embedding_model.sql
```

Installations from 0.1.x stay at 1536 dimensions. Changing the dimension of
an existing table is a migration you plan and run yourself.

## One embedding model per installation

The `mnemocyte_meta` table records the embedding model and dimensions for the
whole database. Before `remember`, `rememberMany`, `recall`, `buildContext`
and `findDuplicates`, Mnemocyte checks the configured embedder against it,
before calling the embedder:

- A different `dimensions` throws `"CONFIG"`.
- A different `model` throws `"CONFIG"`.
- An empty installation records the configured model on its first such call.
- If stored rows hold more than one model, the model stays unrecorded and
  these calls throw `"MIGRATION"`.

`forget`, `forgetAll`, `prune`, `listAuditLog` and `stats` skip the check, so
cleanup works on a mismatched installation.

### Repair mixed models

Inspect what is stored:

```sql
SELECT embedding_model, count(*)
FROM mnemocyte_memories
GROUP BY embedding_model;
```

Re-embed or delete the rows that do not belong to the model you want to keep.
Only when every remaining row uses that model, record it:

```sql
UPDATE mnemocyte_meta
SET embedding_model = 'your-model-id'
WHERE key = 'installation';
```

## Indexes

The schema creates btree indexes on `entity_id` and `(entity_id, type)` for
memories, on `(entity_id, timestamp)` for audit events, and an HNSW index on
the embedding for cosine search.

HNSW (hierarchical navigable small world) is an approximate nearest-neighbor
index: fast, but it can miss close matches, it uses memory to build and it
adds cost to every write. Filters such as `entityId`, `types` and `tags` are
applied after the index scan, so very selective filters can return fewer
results than exist (see [limitations](./limitations.md)).

There is no full-text or tag index yet. Benchmark against representative data
before adding indexes of your own, for example an expression index on
`to_tsvector('english', content)`. IVFFlat can suit large, steady-state
tables, but needs tuning once the table holds representative vectors.
