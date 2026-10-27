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
migrations. pgvector's HNSW index holds at most 2,000 dimensions of `vector`,
so above 2,000 the renderer switches the column to `halfvec` (16-bit floats,
half the storage) and indexes it with `halfvec_cosine_ops`. `halfvec` indexes
stop at 4,000 dimensions, and the renderer refuses anything larger. The
choice is recorded in `mnemocyte_meta.vector_type` and fixed for the
installation.

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

| Installed version | Apply, in order |
|---|---|
| 0.1.x | `0001_add_mnemocyte_meta.sql`, `0002_add_embedding_model.sql`, `0003_schema_v2.sql` |
| 0.2.x, 0.3.x | `0002_add_embedding_model.sql`, `0003_schema_v2.sql` |
| 0.4.x, 0.5.x | `0003_schema_v2.sql` |

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/0003_schema_v2.sql
```

Installations from 0.1.x stay at 1536 dimensions. Changing the dimension of
an existing table is a migration you plan and run yourself.

### Upgrading to 0.6 (`0003_schema_v2.sql`)

- **Ids become UUIDs.** `id` and `superseded_by` change from `text` to
  `uuid`, and so do audit event ids. New ids are UUIDv7: time-ordered, so new
  rows land at the end of the primary-key index instead of on a random page.
  An existing id that is already a UUID keeps its value; any other id, such
  as `mem_lx2…`, becomes `md5(id)::uuid`. The `memoryId` and `supersededBy`
  values in audit event metadata are converted the same way. If your
  application stores memory ids, convert them with the same rule:

  ```sql
  SELECT md5('mem_lx2abc_k3j9d0q1')::uuid;
  ```

  ```ts
  import { createHash } from "node:crypto";

  const hex = createHash("md5").update(oldId).digest("hex");
  const newId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  ```

- **The tables are rewritten.** Changing the id type and adding the stored
  full-text column rewrite `mnemocyte_memories` and `mnemocyte_events` and
  rebuild every index on them, including HNSW. The migration holds an
  `ACCESS EXCLUSIVE` lock on each table while it runs, which blocks reads and
  writes. Plan a maintenance window for large tables.
- **Scope columns.** Memories and audit events gain `namespace`, `agent_id`
  and `session_id`; existing rows get the namespace `default` and no agent or
  session. Memories also gain `key` (unique per scope when set), and `type` is
  renamed to `kind`. The public API is unchanged in this release: it reads
  and writes the `default` namespace.
- **Full text is precomputed.** `content_tsv` is a stored generated column
  (`to_tsvector('english', content)`) with a GIN index, so keyword search no
  longer parses every row on each query.

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

The schema creates:

- a btree on the scope, `(namespace, entity_id, agent_id, session_id)`, for
  memories, and `(namespace, entity_id, timestamp, id)` for audit events;
- a unique btree on the scope plus `key`, only for rows with a key;
- a partial btree on `superseded_by`, so deleting a memory does not scan the
  table to check that nothing was consolidated into it;
- a GIN index on `content_tsv` for full-text search;
- an HNSW index on the embedding for cosine search.

HNSW (hierarchical navigable small world) is an approximate nearest-neighbor
index: fast, but it can miss close matches, it uses memory to build and it
adds cost to every write. Filters such as `entityId`, `types` and `tags` are
applied after the index scan, so very selective filters can return fewer
results than exist (see [limitations](./limitations.md)).

There is no tag index. Benchmark against representative data before adding
indexes of your own. IVFFlat can suit large, steady-state tables, but needs
tuning once the table holds representative vectors.
