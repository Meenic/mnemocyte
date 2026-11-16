# Postgres

How to set up, connect and upgrade the Postgres + pgvector backend. The
in-memory backend needs none of this.

## Requirements

- Postgres with the [pgvector](https://github.com/pgvector/pgvector)
  extension, version 0.8.0 or later. Search uses its iterative index scans
  and throws `"MIGRATION"` on older versions. CI tests Postgres 17 and 18
  with pgvector 0.8.7.
- A client that can run statements together in one transaction:
  postgres.js, a node-postgres `Pool`, PGlite, a Drizzle instance over one
  of them, or your own `SqlExecutor` (see [Connect](#connect)).
- A database role that can create the Mnemocyte tables in the `public`
  schema (or in [a schema of their own](#keep-the-tables-in-their-own-schema)),
  and once, the extension.
- Your driver installed next to Mnemocyte: `postgres` 3.4.9+ or 4.x, `pg`
  8.23.1+, or `@electric-sql/pglite` 0.5.16+ with
  `@electric-sql/pglite-pgvector`, plus `drizzle-orm` 0.45.4+ if you use
  Drizzle. They are optional peer dependencies. Mnemocyte itself has no
  runtime dependencies and imports none of them.

Mnemocyte never creates extensions, tables or indexes when a client is
created. You create the schema with the `mnemocyte migrate` command, with
the `migrate()` function, by applying the bundled SQL files yourself, or
[with drizzle-kit](#manage-the-tables-with-drizzle-kit).

## Install the schema

Run the command that ships with the package, in your project:

```bash
pnpm exec mnemocyte migrate
```

It loads the `memory.ts` where your app creates its client, so it migrates
the database your app uses at your embedder's dimensions. The same command
upgrades an existing installation, so run it on every deploy. It asks
before it enables pgvector; `--yes` answers the question in CI.

Keyword search uses English rules unless you pick another
[language](#keyword-search-language) on this first run.

`pnpm exec mnemocyte check` reports the pgvector version, the applied
migrations, the dimensions and the keyword search language, and exits 1
when something is wrong. Where
the command looks for `memory.ts`, and every flag, are in the
[CLI guide](./cli.md).

Until the schema is installed or upgraded, a call that needs a missing
Mnemocyte table or column throws `"MIGRATION"`. The message repeats the
driver's text (for example `relation "mnemocyte_memories" does not exist`),
says to run `mnemocyte migrate` (with your package manager's runner, such
as `pnpm exec`) and links here; the driver error is the
`cause`.

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

`migrate` takes the store and the dimensions (`embedder.dimensions`) from
the client. A deploy script without a client can pass them itself:
`migrate({ store, dimensions: 1536 })`. Its options and results are in the
[API reference](./api.md#migrate).

### Enabling pgvector

pgvector has to be enabled in each database before the first install. When
it is missing, the command asks to run `CREATE EXTENSION IF NOT EXISTS
vector`, and `migrate({ createExtension: true })` runs it. Either way it
runs in the same transaction as the schema, so a failed install leaves
neither behind.

pgvector is not a trusted extension, so this needs a superuser or the admin
role your provider gives you (`rds_superuser` on RDS, `neon_superuser` on
Neon, `postgres` on Supabase). A role without it gets `"MIGRATION"` with a
message saying so, and so does a server that does not have pgvector
installed.

When the app's role may not create extensions, answer no (or leave the
option off) and have an admin enable pgvector once:

```bash
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector;'
```

### Check a deploy with `dryRun`

`pnpm exec mnemocyte migrate --dry-run` prints what a run would apply. In
code, `dryRun: true` reads the database in one read-only transaction and
returns the `applied`, `adopted` and `extensionCreated` a real run would
return, and changes nothing:

```ts
const plan = await migrate({ memory, createExtension: true, dryRun: true });
// { applied: ["0004_audit_memory_id"], adopted: [], extensionCreated: false }
```

It throws the errors a real run would throw before its first change: a
missing pgvector, dimensions that do not match, a schema it cannot place.
It cannot tell whether a migration will fail partway through, for example
on data; only running it shows that.

### What `migrate` does

It depends on what the database already has:

- **No Mnemocyte tables:** creates the current schema in one transaction
  for `dimensions` (required here) and records every migration as applied.
- **Tables from `migrate`:** applies the migrations that are not recorded
  yet, in order. When there are none it changes nothing.
- **Tables installed with `psql` or drizzle-kit:** works out which
  migrations were applied from the schema itself, records them as
  `adopted` without running them, then applies the rest. A schema that
  matches no migration, such as one left half-applied by `psql -f` without
  the flags below, throws `"MIGRATION"` and changes nothing.

Each migration runs in its own transaction, which starts by taking a
transaction-level advisory lock (`pg_advisory_xact_lock`). Two app
instances that migrate at the same time take turns, and the second one
finds the work done. The lock ends with the transaction, so it also works
through transaction-mode poolers such as PgBouncer and Supavisor, which do
not support session-level locks. A failing migration rolls back; the ones
before it stay applied.

`dimensions` decides the embedding column. pgvector's HNSW index holds at
most 2,000 dimensions of `vector`, so above 2,000 the column is `halfvec`
(16-bit floats, half the storage), indexed with `halfvec_cosine_ops`.
`halfvec` indexes stop at 4,000 dimensions, and `migrate` refuses anything
larger. The choice is recorded in `mnemocyte_meta.vector_type` and fixed
for the installation; a different `dimensions` later throws `"CONFIG"`.

`migrate` needs a driver with interactive transactions. Run it over a
regular TCP connection, even if the app itself uses an HTTP driver.

### Apply the SQL files yourself

The same SQL ships in `node_modules/mnemocyte/migrations/` for teams that
run migrations with their own tools. `-v ON_ERROR_STOP=1
--single-transaction` makes `psql` stop at the first error and roll the
whole file back, so a failed run never leaves a partial schema. Without
those flags, `psql -f` keeps going after an error.

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/fresh-install.sql
```

`fresh-install.sql` creates the schema for 1536-dimension embeddings, such
as OpenAI's `text-embedding-3-small`. Use it only on a database that has
no Mnemocyte tables yet. For another size, render the schema with
`mnemocyte sql` and apply that file instead:

```bash
pnpm exec mnemocyte sql --dimensions 768 --out migrations/0000_initial.768.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f migrations/0000_initial.768.sql
```

`sql` needs no database; without `--dimensions` it takes the size from
your memory file's embedder. The rendered file is a complete schema, so do
not also apply the numbered migrations. If you switch to `migrate` later,
it adopts a schema installed this way.

## Keep the tables in their own schema

By default the tables go wherever your connection's `search_path` points,
which is `public` on a standard setup. To keep them in a schema of their
own, such as `memory`, pass `schemaName` to `postgresStore`:

```ts
import { createMemory } from "mnemocyte";
import { postgresStore } from "mnemocyte/postgres";

export const memory = createMemory({
  store: postgresStore({ client: sql, schemaName: "memory" }),
  embedder,
});
```

Then run `mnemocyte migrate` as usual. On a fresh install it creates the
schema when it is missing and puts every Mnemocyte table there, the
`mnemocyte_migrations` tracking table too. Every query names the schema,
so the app finds the tables whatever `search_path` says.

- The name is lower case letters, digits and underscores, up to 63
  characters, and cannot start with a digit or `pg_`. Anything else throws
  `"CONFIG"` when `postgresStore` is called.
- Creating a schema needs the `CREATE` privilege on the database. Without
  it, `migrate` fails with `"MIGRATION"` and changes nothing; have an admin
  run `CREATE SCHEMA memory AUTHORIZATION your_role;` once, and `migrate`
  uses that schema.
- pgvector stays where it is. Its `vector` type must still be on
  `search_path`, as it is when pgvector lives in `public`.
- `createMemory({ store: sql })` always uses `search_path`. Wrap the client
  in `postgresStore` to pick a schema.
- Without a memory file, the CLI takes `--schema memory`, and
  `mnemocyte sql --schema memory` prints SQL that creates the schema and
  puts it first on `search_path` before the tables.
- Each schema holds its own installation, with its own embedding size and
  keyword search language.

### Move an existing installation

`migrate` never moves tables. If your app already keeps its memories in
`public` and you add `schemaName`, `migrate` stops with `"CONFIG"`
(`INSTALLATION_ELSEWHERE`) instead of installing an empty copy next to
them. Move the tables yourself, in one transaction:

```sql
BEGIN;
-- Waits for a migrate that is running right now.
SELECT pg_advisory_xact_lock(7885351518266947956);
CREATE SCHEMA memory;
ALTER TABLE public.mnemocyte_memories SET SCHEMA memory;
ALTER TABLE public.mnemocyte_events SET SCHEMA memory;
ALTER TABLE public.mnemocyte_meta SET SCHEMA memory;
ALTER TABLE public.mnemocyte_migrations SET SCHEMA memory;
COMMIT;
```

Indexes and constraints move with their tables, and the consolidation
link between memories keeps working. No rows are copied, so it is quick,
but each `ALTER TABLE` waits for the queries running on its table. Skip the
last `ALTER TABLE` if you installed with `psql` and have no
`mnemocyte_migrations`.

An app without `schemaName` stops finding the tables as soon as this
commits and throws `"MIGRATION"`, so stop the app for the move, or deploy
the `schemaName` change right after it. `mnemocyte check --schema memory`
then reports the moved installation.

The same check means `migrate` will not make a fresh install in a schema
while `search_path` finds Mnemocyte tables somewhere else. To keep a
second installation next to the one in `public`, apply the output of
`mnemocyte sql --schema <name>` with `psql`; `migrate` adopts it after
that.

## Manage the tables with drizzle-kit

If drizzle-kit already runs your app's migrations, it can run Mnemocyte's
too. `mnemocyte generate` writes the tables as a Drizzle schema file:

```bash
pnpm exec mnemocyte generate --adapter drizzle
```

It writes `mnemocyte-schema.ts` (`--out` picks another path) for your
memory file's embedding size, or for `--dimensions`. Like `sql`, it takes
`--text-search-config` and `--schema` (or your store's `schemaName`) and
never connects to a database. The file is written for drizzle-orm 0.45
and exports `mnemocyteMemories`, `mnemocyteEvents` and `mnemocyteMeta`.

Add it to your `drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/db/schema.ts", "./mnemocyte-schema.ts"],
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
```

drizzle-kit cannot write three parts of the schema: the pgvector
extension, the unique index that makes keyed `add` calls update in place
(it needs `NULLS NOT DISTINCT`, which drizzle-orm only has on constraints)
and the row in `mnemocyte_meta` that records the embedding size. They go
in custom migrations, which `drizzle-kit generate --custom` creates empty
for you to fill. `generate` prints the steps with the SQL for your setup:

1. Unless pgvector is enabled already,
   `pnpm exec drizzle-kit generate --custom --name=pgvector`, and put
   `CREATE EXTENSION IF NOT EXISTS vector;` in the new file.
2. `pnpm exec drizzle-kit generate` for the tables.
3. `pnpm exec drizzle-kit generate --custom --name=mnemocyte`, and put
   the SQL `generate` printed in the new file. For 1536 dimensions in
   `public` it is:

   ```sql
   CREATE UNIQUE INDEX "mnemocyte_memories_scope_key_idx" ON "mnemocyte_memories" USING btree ("namespace","entity_id","agent_id","session_id","key") NULLS NOT DISTINCT WHERE "key" IS NOT NULL;
   --> statement-breakpoint
   INSERT INTO "mnemocyte_meta" ("key", "embedding_dimensions", "vector_type") VALUES ('installation', 1536, 'vector');
   ```

4. `pnpm exec drizzle-kit migrate`, then `pnpm exec mnemocyte check`.

`check` says the migrations are "not recorded". That is expected:
drizzle-kit keeps its own history, so Mnemocyte's `mnemocyte_migrations`
table does not exist.

From then on, drizzle-kit manages these tables:

- **Don't run `mnemocyte migrate` on them.** It would record Mnemocyte's
  migrations and later apply new ones that drizzle-kit applies too.
- **Don't use `drizzle-kit push` on them.** Push compares the database
  with your schema files, finds the unique index that is not in them, and
  drops it. Every `add` with a `key` fails after that.
- **After a Mnemocyte upgrade,** run `generate` again. It replaces its own
  file, never one it did not write. Then run `drizzle-kit generate`, read
  the migration, and `drizzle-kit migrate`. When nothing changed, `generate`
  says the file is up to date.
- **To change the [keyword search language](#keyword-search-language),**
  run `generate` with the new `--text-search-config`, then
  `drizzle-kit generate`. drizzle-kit drops the keyword column and adds it
  back, which drops its index too, so `generate` prints a `CREATE INDEX`
  and an `ANALYZE` to add to the end of that migration before you apply it.
  The rewrite takes as long as described there.
- **The embedding size and the schema stay.** `generate` refuses to
  change either in an existing file, as `migrate` does for an
  installation; `--out` writes a file for a new installation instead.

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

Mnemocyte's Postgres code loads with a dynamic `import()` on the first call
that needs it, `migrate` included, so an app on the in-memory backend never
loads it. `createMemory` stays synchronous.

`postgresStore({ client })` from `mnemocyte/postgres` takes the same
clients and keeps working; `createMemory` recognises the store it returns
before checking for a client. `migrate({ store, dimensions })` accepts
either, for a deploy step without an embedder.

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

Pass a `Pool`, not a `Client`. Consecutive `pool.query` calls can land on
different connections, so each transaction checks out one connection with
`pool.connect()`, runs on it and releases it. A `pg.Client` throws
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
migrations must be applied. To let drizzle-kit apply them, see
[Manage the tables with drizzle-kit](#manage-the-tables-with-drizzle-kit).

Let the type be inferred from `drizzle()`. drizzle-orm's
`PostgresJsDatabase` type does not declare `$client`, so an instance
annotated with it does not type-check as `store`. Pass `db.$client`
instead, which is the same postgres.js client.

### postgres.js 3 and 4

Both majors work with the same code. postgres.js 4 leaves parameter types
to the server unless you set `infer: true`. Mnemocyte sends only strings,
numbers and null, with a cast wherever the query does not decide the type,
so its statements behave the same either way.

On postgres.js 4.1 or later, statements that must run together (the
settings plus vector query of each search, and `addMany`'s chunks) go out
as one `sql.batch`: one round trip that commits or rolls back as a unit,
without a `BEGIN` or `COMMIT` of its own. On 3.x and 4.0 they are
pipelined inside `sql.begin`. An aborted `signal` cancels the running
statement on the server with either major.

### Poolers and prepared statements

Mnemocyte sends plain parameterized statements and never uses named
prepared statements, so a transaction-mode pooler (PgBouncer, Supavisor)
works without `prepare: false`.

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

- `transaction(fn)` runs `fn` in an interactive transaction, or a
  savepoint when already inside one.
- `batch(statements)` runs the statements in order in one transaction, all
  or nothing, and returns each one's rows in order. A driver without
  interactive transactions maps it to its non-interactive transaction,
  such as Neon's `sql.transaction([...])` over HTTP.

When both exist, Mnemocyte uses `batch`. `migrate` needs `transaction`, so
run it over a regular connection. Drivers are checked first, so an
executor object must not also have PGlite's `exec` or a pool's `connect`
and `totalCount`.

## Upgrade an existing installation

Run `pnpm exec mnemocyte migrate` (or `migrate({ memory })` in code) after
upgrading the package. It applies the pending migrations, and adopts an
installation that was set up with `psql` first. `pnpm exec mnemocyte check`
exits 1 while migrations are pending. The code changes between releases
are in [upgrading.md](./upgrading.md).

With `psql`, apply the numbered migrations yourself. Never apply
`fresh-install.sql` over an existing Mnemocyte schema. With drizzle-kit,
see [after a Mnemocyte upgrade](#manage-the-tables-with-drizzle-kit).

| Installed version | Apply, in order |
|---|---|
| 0.1.x | `0001_add_mnemocyte_meta.sql`, `0002_add_embedding_model.sql`, `0003_schema_v2.sql`, `0004_audit_memory_id.sql` |
| 0.2.x, 0.3.x | `0002_add_embedding_model.sql`, `0003_schema_v2.sql`, `0004_audit_memory_id.sql` |
| 0.4.x, 0.5.x | `0003_schema_v2.sql`, `0004_audit_memory_id.sql` |
| 0.6.x to 1.0.x | `0004_audit_memory_id.sql` |

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f node_modules/mnemocyte/migrations/0004_audit_memory_id.sql
```

Installations from 0.1.x stay at 1536 dimensions. Changing the dimension of
an existing table is a migration you plan and run yourself.

<a id="upgrading-to-06-0003_schema_v2sql"></a>
`0003_schema_v2.sql` (0.6) rewrites both tables under an `ACCESS EXCLUSIVE`
lock and turns ids into UUIDs. Plan a maintenance window for large tables,
and see [schema migration 0003](./upgrading.md#schema-migration-0003_schema_v2sql)
for what changes and how to convert ids your app stores.

`0004_audit_memory_id.sql` (1.1) rewrites `mnemocyte_events` under an
`ACCESS EXCLUSIVE` lock to add its `memory_id` column, then builds an
index on it. Audit reads and audited writes wait for both:
on 1,000,000 events (150 MB) it took 9.6 s on a laptop, 8.5 s for the rewrite and 1.1 s for the index. Memory reads, and writes with the audit log off,
do not wait; `deleteScope` does, since it also deletes the scope's events.
Run it at a quiet time if your audit log is large, or trim it
first with `pruneAuditLog`. The app keeps working before and after it, in
either deploy order (see [upgrading](./upgrading.md#10--11)).

## One embedding model per installation

The `mnemocyte_meta` table records the embedding model and dimensions for
the whole database. Before `add`, `addMany`, `search`, `context`,
`findDuplicates` and an `update` that changes content, Mnemocyte checks the
configured embedder against it, before calling the embedder:

- A different `dimensions` throws `"CONFIG"` with reason
  `"DIMENSIONS_MISMATCH"`. Configure an embedder with the installation's
  dimensions (many models take a `dimensions` option), or install in a
  fresh database; `migrate` does not change an existing installation's
  dimensions.
- A different `model` throws `"CONFIG"` with reason `"MODEL_MISMATCH"`.
- An empty installation records the configured model on its first such
  call.
- If stored rows hold more than one model, the model stays unrecorded and
  these calls throw `"MIGRATION"` with reason `"MIXED_MODELS"`.
- If the `installation` row is missing, these calls throw `"MIGRATION"`
  with reason `"INSTALLATION_INVALID"`. `migrate` writes the row only when
  it creates the schema and does not restore a deleted one. Insert it again
  with the installation's dimensions and vector type (`halfvec` above 2,000
  dimensions); the model is recorded on the next such call, as for an
  empty installation:

  ```sql
  INSERT INTO mnemocyte_meta (key, embedding_dimensions, vector_type)
  VALUES ('installation', 1536, 'vector');
  ```

`get`, `list`, `delete`, `deleteScope`, `prune`, `listAuditLog`, `stats`
and updates that leave the content alone skip the check, so cleanup works
on a mismatched installation.

### Repair mixed models

Inspect what is stored:

```sql
SELECT embedding_model, count(*)
FROM mnemocyte_memories
GROUP BY embedding_model;
```

Re-embed or delete the rows that do not belong to the model you want to
keep. Only when every remaining row uses that model, record it:

```sql
UPDATE mnemocyte_meta
SET embedding_model = 'your-model-id'
WHERE key = 'installation';
```

## Keyword search language

Search finds memories two ways: by meaning (the embeddings) and by words.
The word search uses Postgres full-text search, which needs to know the
language: it turns "running" and "runs" into "run" (stemming) and skips
common words such as "the" (stop words). Postgres calls these rules a
*text search configuration*. Mnemocyte uses `english` unless you pick
another one when you install.

Pick one with `--text-search-config` the first time you migrate:

```bash
pnpm exec mnemocyte migrate --text-search-config simple
```

or `migrate({ memory, textSearchConfig: "simple" })` from code, or
`mnemocyte sql --text-search-config simple` for the SQL files. Postgres
lists the ones it has:

```sql
SELECT cfgname FROM pg_ts_config;
```

- `simple` lowercases words and nothing else: no stemming, no stop words.
  It suits memories in several languages, or names and codes that stemming
  would mangle. "run" no longer finds "running".
- `english`, `german`, `french`, `spanish`, `turkish` and 24 more (on
  Postgres 18) stem one language and skip its stop words.
- A configuration you create with `CREATE TEXT SEARCH CONFIGURATION` works
  too; name it as Postgres would, schema-qualified if its schema is not on
  `search_path`.

The choice is stored in the keyword column itself
(`to_tsvector('simple'::regconfig, content)`), and search reads it from
there, so there is nothing to configure in the app. Later runs of
`migrate` can leave the flag out. When they pass a different one, they
fail with `"CONFIG"` rather than change it. `mnemocyte check` shows the
configuration, and `check --text-search-config <name>` fails when it is
not the one you expect.

### Change it later

```bash
pnpm exec mnemocyte text-search simple
```

or `setTextSearchConfig({ memory, textSearchConfig: "simple" })`. Postgres
has to recompute the keyword column for every memory, so it rewrites the
memories table and rebuilds every index on it, the HNSW index included.
Reads and writes of memories wait until it finishes. The command shows
what it will do and asks first; `--yes` skips the question and `--dry-run`
changes nothing.

For scale: on Postgres 18 with 132,000 memories at 1,536 dimensions (a
1 GB table and a 1 GB HNSW index), on a laptop, the change took 4 minutes
20 seconds with the default `maintenance_work_mem` of 64 MB, and about a
minute with 1 GB. Most of that time goes into rebuilding the HNSW index.
Pick a quiet moment, and raise the setting for the role that runs the
change if you can (`ALTER ROLE … SET maintenance_work_mem = '1GB'`, or
`SET maintenance_work_mem = '1GB'` in your `psql` session).

App processes that were already running keep using the old configuration
for the words of a query until they restart, so their keyword matches get
weaker (an `english` query stems "running" to "run", which a `simple`
column does not contain). Restart them after the change.

To make the change with `psql` instead, run it in one transaction. On
Postgres 17 and later:

```sql
BEGIN;
ALTER TABLE mnemocyte_memories
  ALTER COLUMN content_tsv SET EXPRESSION AS (to_tsvector('simple'::regconfig, content));
ANALYZE mnemocyte_memories (content_tsv);
COMMIT;
```

Postgres 15 and 16 have no `SET EXPRESSION`, so drop the column and add it
back, then index it again:

```sql
BEGIN;
ALTER TABLE mnemocyte_memories
  DROP COLUMN content_tsv,
  ADD COLUMN content_tsv tsvector
    GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, content)) STORED;
CREATE INDEX mnemocyte_memories_content_tsv_idx
  ON mnemocyte_memories USING gin (content_tsv);
ANALYZE mnemocyte_memories (content_tsv);
COMMIT;
```

Keep the expression exactly in this shape. Mnemocyte reads the
configuration from it, and an expression of another shape makes search
and `check` fail with `"MIGRATION"`.

## Indexes

The schema creates:

- a btree on the scope, `(namespace, entity_id, agent_id, session_id)`, for
  memories, and `(namespace, entity_id, timestamp, id)` for audit events;
- a btree on `(memory_id, timestamp, id)` for audit events, so one
  memory's history (`listAuditLog({ memoryId })`) is found without reading
  the log;
- a unique btree on the scope plus `key`, only for rows with a key;
- a partial btree on `superseded_by`, so deleting a memory does not scan
  the table to check that nothing was consolidated into it;
- a GIN index on `content_tsv` for full-text search (see
  [keyword search language](#keyword-search-language));
- an HNSW index on the embedding for cosine search.

HNSW (hierarchical navigable small world) is an approximate
nearest-neighbor index. It is fast, but it can miss close matches, it uses
memory to build and it adds cost to every write. The scope and filters
such as `kinds` and `tags` are applied after the index scan; pgvector's
iterative scan keeps reading the index until enough rows pass (see
[limitations](./limitations.md#retrieval)).

For scale, measured on Postgres 18 with 132,000 memories at 1,536
dimensions and default server settings: the HNSW index was about as large
as the table (1 GB each), searching a 30,000-memory user took 2–11 ms
against 320 ms without it, and it made inserts about ten times slower
(roughly 1 ms per memory). Users with a few hundred memories are searched
exactly, without HNSW. `findDuplicates` is slower still (see
[limitations](./limitations.md#maintenance)).

Mnemocyte creates no tag index. Benchmark against representative data
before adding indexes of your own. IVFFlat can suit large, steady-state
tables, but needs tuning once the table holds representative vectors.
