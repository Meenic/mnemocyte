# Postgres

How to set up, connect and upgrade the Postgres + pgvector backend. The
in-memory backend needs none of this.

## Requirements

- Postgres with the [pgvector](https://github.com/pgvector/pgvector)
  extension available, version 0.8.0 or later: search uses its iterative
  index scans and throws `"MIGRATION"` on older versions. CI tests Postgres
  17 and 18 with pgvector 0.8.7.
- A client that can run statements together in one transaction: postgres.js,
  a node-postgres `Pool`, PGlite, a Drizzle instance over one of them, or
  your own `SqlExecutor`. Each search runs its vector search after setting
  pgvector options for that transaction, and `addMany` writes its chunks in
  one transaction.
- A database role that can create the extension (once) and the Mnemocyte
  tables in the `public` schema.
- Your driver next to Mnemocyte: `postgres` 3.4.9+ or 4.x, `pg` 8.23.1+
  or `@electric-sql/pglite` 0.5.16+ (with `@electric-sql/pglite-pgvector`),
  and `drizzle-orm` 0.45.4+ if you use Drizzle. They are optional peer
  dependencies; Mnemocyte itself has no runtime dependencies and imports
  none of them.

Mnemocyte never creates extensions, tables or indexes when a client is
created. You create the schema with the `mnemocyte migrate` command or the
`migrate()` function, which can also enable pgvector when you ask, or by
applying the bundled SQL files yourself.

## Install the schema

Run the command that ships with the package, in your project:

```bash
npx mnemocyte migrate
```

It loads the `memory.ts` where your app creates its client (the root,
`lib/`, `src/` or `src/lib/`, or `--config <path>`), so it migrates the
database your app uses at your embedder's size, and it asks before enabling
pgvector. The same command upgrades an existing installation; run it in
every deploy (`--yes` answers the question in CI). `npx mnemocyte check`
reports the pgvector version, the applied migrations and the dimensions,
and exits 1 when something is wrong. Every flag is in the
[CLI guide](./cli.md).

### Migrate from code

`migrate()` is the function behind the command, for a deploy script of your
own, for PGlite, or for a memory file the command cannot load:

```ts
import { createMemory, migrate } from "mnemocyte";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const memory = createMemory({ store: sql, embedder });

const { applied, adopted, extensionCreated } = await migrate({
  memory,
  createExtension: true,
});
```

`migrate` takes the store and the embedding size (`embedder.dimensions`)
from the client. A deploy script that has no client can pass them itself:
`migrate({ store, dimensions: 1536 })`. The same call upgrades an existing
installation.

Until the schema is installed or upgraded, a call that needs a missing
Mnemocyte table or column throws `"MIGRATION"`. The message repeats the
driver's text (for example `relation "mnemocyte_memories" does not exist`),
says to run `npx mnemocyte migrate` and links here; the driver error is the
`cause`.

### Enabling pgvector

pgvector has to be enabled in each database before the first install. The
command asks first and then does what `createExtension: true` does in
code: `migrate` runs `CREATE EXTENSION IF NOT EXISTS vector` when it is
missing, in the same transaction as the schema, so a
failed install leaves neither behind. pgvector is not a trusted extension,
so this needs a superuser or the admin role your provider gives you
(`rds_superuser` on RDS, `neon_superuser` on Neon, `postgres` on Supabase).
A role without it gets `"MIGRATION"` with a message saying so, and a server
without pgvector installed gets `"MIGRATION"` too.

When the app's role may not create extensions, leave the option off (answer
no to the command) and have an admin enable pgvector once:

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

### Check a deploy with `dryRun`

`npx mnemocyte migrate --dry-run` prints what a run would apply. In code,
`dryRun: true` reads the database in one read-only transaction and returns
the `applied`, `adopted` and `extensionCreated` a real run would return,
without changing anything:

```ts
const plan = await migrate({ memory, createExtension: true, dryRun: true });
// { applied: ["0003_schema_v2"], adopted: [], extensionCreated: false }
```

It throws the errors a real run would throw before its first change (a
missing pgvector, dimensions that do not match, a schema it cannot place).
It cannot tell whether a migration will fail partway through, for example on
data; only running it shows that.

### What `migrate` does

It depends on what the database already has:

- **No Mnemocyte tables:** creates the current schema in one transaction for
  `dimensions` (required here) and records every migration as applied.
- **Tables from `migrate`:** applies the migrations that are not recorded
  yet, in order. When there are none it changes nothing, so running it on
  every deploy is safe.
- **Tables installed with `psql` or drizzle-kit:** works out which migrations
  were applied from the schema itself, records them as `adopted` without
  running them, then applies the rest. A schema that matches no migration,
  such as one left half-applied by `psql -f` without the flags below, throws
  `"MIGRATION"` without changing anything.

Each migration runs in its own transaction, which starts by taking a
transaction-level advisory lock (`pg_advisory_xact_lock`). Two app instances
that migrate at the same time therefore take turns, and the second one finds
the work done. The lock is released when the transaction ends, so it also
works through transaction-mode poolers such as PgBouncer and Supavisor, which
do not support session-level locks. A failing migration rolls back on its
own; the ones before it stay applied.

`dimensions` decides the embedding column. pgvector's HNSW index holds at
most 2,000 dimensions of `vector`, so above 2,000 the column is `halfvec`
(16-bit floats, half the storage), indexed with `halfvec_cosine_ops`.
`halfvec` indexes stop at 4,000 dimensions, and `migrate` refuses anything
larger. The choice is recorded in `mnemocyte_meta.vector_type` and fixed for
the installation; passing a different `dimensions` later throws `"CONFIG"`.

`migrate` needs a driver with interactive transactions. Run it over a regular
TCP connection even if the app itself uses an HTTP driver.

### Apply the SQL files yourself

The same SQL ships in `node_modules/mnemocyte/migrations/` for teams that run
migrations with their own tools. `-v ON_ERROR_STOP=1 --single-transaction`
makes `psql` stop at the first error and roll the whole file back, so a failed
run never leaves a partial schema. Without those flags, `psql -f` keeps going
after an error.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/fresh-install.sql
```

`fresh-install.sql` creates the schema for 1536-dimension embeddings
(OpenAI's `text-embedding-3-small`, for example). Use it only on a database
that has no Mnemocyte tables yet. For a different embedding size, print the
schema with `mnemocyte sql` and apply that file instead:

```bash
npx mnemocyte sql --dimensions 768 --out migrations/0000_initial.768.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f migrations/0000_initial.768.sql
```

`sql` needs no database; without `--dimensions` it takes the size from
your memory file's embedder. The rendered file is a complete schema; do not
also apply the numbered migrations. If you switch to `migrate` later, it adopts a schema installed
this way.

## Connect

Pass the client your app already has as `store`. Mnemocyte recognises it
by its shape, without importing any driver:

```ts
import { createMemory } from "mnemocyte";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 10 });

const memory = createMemory({ store: sql, embedder });

// ... on shutdown, end your own client:
await sql.end();
```

You own the client: TLS, pool size, timeouts and `prepare` are whatever you
configure. The memory client holds no connections and has no `close()`.

Mnemocyte's Postgres code (queries, the migration runner, the driver
adapters) is imported with a dynamic `import()` on the first call that
needs it, `migrate` included, so an app on the in-memory backend never
loads it. `createMemory` stays synchronous.

`postgresStore({ client })` from `mnemocyte/postgres` takes the same
clients and keeps working; `createMemory` recognises the store it returns
before checking for a client. `migrate({ store, dimensions })` accepts
either too, for a deploy step without an embedder.

Checks run in this order, and the first match wins:

1. **postgres.js:** a function with `unsafe` and `begin`, or `unsafe` and
   `savepoint` (the `sql` a `sql.begin` callback receives). A reserved
   connection from `sql.reserve()` has neither and throws `"CONFIG"`.
2. **Drizzle:** an object with `$client`; Mnemocyte uses that client.
3. **PGlite:** an object with `query`, `exec` and `transaction`.
4. **node-postgres `Pool`:** an object with `query`, `connect` and a
   numeric `totalCount`.
5. **`SqlExecutor`:** an object with `query` and `transaction` or `batch`
   (see [below](#bring-another-driver)).

Anything else throws `"CONFIG"` from `createMemory` (or `postgresStore`)
right away, before any query runs.

### node-postgres

```ts
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const memory = createMemory({ store: pool, embedder });
```

Pass a `Pool`, not a `Client`: each transaction checks out one connection
with `pool.connect()`, runs on it and releases it, because consecutive
`pool.query` calls can land on different connections. A `pg.Client` throws
`"CONFIG"`. Pools with the same API, such as `@neondatabase/serverless`'s
`Pool`, are detected the same way.

node-postgres cannot cancel a running query. An aborted `signal` stops the
next statement; the one already sent runs to the end.

### PGlite

[PGlite](https://pglite.dev) runs Postgres inside your process. Load
pgvector through its extension package, then migrate; `createExtension`
enables it in the database:

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";

const db = await PGlite.create({ dataDir: "./memory-data", extensions: { vector } });

const memory = createMemory({ store: db, embedder });
await migrate({ memory, createExtension: true });
```

PGlite 0.5 is Postgres 18 with pgvector 0.8.7. It runs one transaction at
a time: while Mnemocyte holds one, your other PGlite queries wait. Like
node-postgres, it cannot cancel a running query. A data folder can be open
in one process only.

### Drizzle

Pass the Drizzle instance itself:

```ts
import { drizzle } from "drizzle-orm/node-postgres";

const db = drizzle({ client: pool });
const memory = createMemory({ store: db, embedder });
```

Mnemocyte runs its own SQL on `db.$client` and shares its pool. Supported:
`drizzle-orm/postgres-js`, `drizzle-orm/node-postgres` with a `Pool`, and
`drizzle-orm/pglite`; any other Drizzle driver throws `"CONFIG"`. Your
Drizzle schema does not need to include Mnemocyte's tables, but the
migrations must be applied. `drizzleStore(db)` from
`mnemocyte/stores/drizzle` does the same and keeps working. TypeScript
types that omit `$client` (such as an instance annotated as
`PostgresJsDatabase`) are accepted by `drizzleStore`; for `store` and
`postgresStore`, let the type be inferred from `drizzle()`.

### postgres.js 3 and 4

Both majors work with the same code. postgres.js 4 leaves parameter types
to the server unless you set `infer: true`; Mnemocyte sends only strings,
numbers and null, with a cast wherever the query does not decide the type,
so its statements behave the same either way.

On postgres.js 4.1 or later, statements that must run together (the
settings plus vector query of each search, and `addMany`'s chunks) go out
as one `sql.batch`: one round trip that commits or rolls back as a unit,
with no `BEGIN` or `COMMIT` of its own. On 3.x and 4.0 they are pipelined
inside `sql.begin`. An aborted `signal` cancels the running statement on
the server with either major.

### Poolers and prepared statements

Mnemocyte sends plain parameterized statements and never uses named prepared
statements, so a transaction-mode pooler (PgBouncer, Supavisor) works without
`prepare: false`.

### Bring another driver

`store` (and `postgresStore`) also takes any `SqlExecutor`, an interface
exported from `mnemocyte/postgres`:

```ts
interface SqlExecutor {
  query<Row>(sql: string, params: readonly unknown[], options?: { signal?: AbortSignal }): Promise<Row[]>;
  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  batch?(
    statements: readonly { sql: string; params: readonly unknown[] }[],
    options?: { signal?: AbortSignal },
  ): Promise<Record<string, unknown>[][]>;
}
```

Statements use `$1…` placeholders. Implement `query` and at least one of
the other two (`"CONFIG"` otherwise):

- `transaction(fn)` runs `fn` in an interactive transaction, or a savepoint
  when already inside one.
- `batch(statements)` runs the statements in order in one transaction, all
  or nothing, and returns each one's rows in order. A driver without
  interactive transactions maps it to its non-interactive transaction, such
  as Neon's `sql.transaction([...])` over HTTP.

When both exist, Mnemocyte uses `batch`. `migrate` needs `transaction`, so
run it over a regular connection. Drivers are checked first, so an executor
object must not also have PGlite's `exec` or a pool's `connect` and
`totalCount`. `postgresJs(sql)` still wraps a postgres.js client as an
executor, for code written before detection.

## Upgrade an existing installation

Run `npx mnemocyte migrate` (or `migrate({ memory })` in code) after
upgrading the package. It applies the pending
migrations, adopting an installation that was set up with `psql` first.
`npx mnemocyte check` exits 1 while migrations are pending.

With `psql`, apply the numbered migrations yourself. Never apply
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
  renamed to `kind`. From 0.6 every call names its scope; pass
  `namespace: "default"` to reach memories written before it.
- **Full text is precomputed.** `content_tsv` is a stored generated column
  (`to_tsvector('english', content)`) with a GIN index, so keyword search no
  longer parses every row on each query.

## One embedding model per installation

The `mnemocyte_meta` table records the embedding model and dimensions for the
whole database. Before `add`, `addMany`, `search`, `context`,
`findDuplicates` and an `update` that changes content, Mnemocyte checks the configured embedder against it,
before calling the embedder:

- A different `dimensions` throws `"CONFIG"`.
- A different `model` throws `"CONFIG"`.
- An empty installation records the configured model on its first such call.
- If stored rows hold more than one model, the model stays unrecorded and
  these calls throw `"MIGRATION"`.
- If the `installation` row is missing, these calls throw `"MIGRATION"`.
  `migrate` writes the row only when it creates the schema and does not
  restore a deleted one. Insert it again with the installation's dimensions
  and vector type (`halfvec` above 2,000 dimensions); the model is recorded
  on the next such call, as for an empty installation:

  ```sql
  INSERT INTO mnemocyte_meta (key, embedding_dimensions, vector_type)
  VALUES ('installation', 1536, 'vector');
  ```

`get`, `list`, `delete`, `deleteScope`, `prune`, `listAuditLog`, `stats` and
updates that leave the content alone skip the check, so cleanup works on a
mismatched installation.

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
adds cost to every write. The scope and filters such as `kinds` and `tags`
are applied after the index scan; pgvector's iterative scan keeps reading
the index until enough rows pass (see [limitations](./limitations.md)).

For scale, measured on Postgres 18 with 132,000 memories at 1,536
dimensions and default server settings: the HNSW index was about as large
as the table (1 GB each), searching a 30,000-memory user took 2–11 ms
against 320 ms without it, and it made inserts about ten times slower
(roughly 1 ms per memory). Users with a few hundred memories are searched
exactly, without HNSW. `findDuplicates` is slower still (see
[limitations](./limitations.md)).

There is no tag index. Benchmark against representative data before adding
indexes of your own. IVFFlat can suit large, steady-state tables, but needs
tuning once the table holds representative vectors.
