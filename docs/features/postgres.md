# Postgres backend

Current behavior of the Postgres + pgvector backend. Known problems are listed
at the end with the roadmap item that fixes each one.

## Schema

Three tables, all unqualified in queries (they resolve through `search_path`;
the foreign key alone names `public`):

| Table | Purpose |
|---|---|
| `mnemocyte_memories` | One row per memory: `id` (uuid PK), `entity_id`, `content`, `kind`, `importance`, `tags text[]`, `source`, `metadata jsonb`, `confidence real`, `embedding vector(N)` or `halfvec(N)` (nullable), `embedding_model`, `embedding_dimensions`, `superseded_by` (uuid, self FK, `ON DELETE NO ACTION`), `superseded_at`, `expires_at`, `last_accessed_at`, `access_count`, `created_at`, `updated_at`, then the scope columns `namespace`, `agent_id`, `session_id`, an optional `key`, and `content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED`. |
| `mnemocyte_events` | Audit log: `id` (uuid), `entity_id`, `description`, `metadata jsonb`, `timestamp`, `namespace`, `agent_id`, `session_id`. |
| `mnemocyte_meta` | One row, key `installation`: `embedding_dimensions`, `embedding_model` and `vector_type` (`vector` or `halfvec`, `CHECK`ed) for the whole installation. |

New columns sit at the end of each table, in the order `0003` adds them, so
a fresh install and an upgraded one have identical catalogs.

`content_tsv` must say `STORED`: from Postgres 18 a generated column is
virtual by default, and a virtual column cannot be indexed.

Indexes:

| Index | Columns | Why |
|---|---|---|
| `mnemocyte_memories_scope_idx` | btree `(namespace, entity_id, agent_id, session_id)` | Every query filters by scope. Replaces `(entity_id)` and `(entity_id, type)`. |
| `mnemocyte_memories_scope_key_idx` | unique btree scope + `key`, `NULLS NOT DISTINCT`, `WHERE key IS NOT NULL` | One row per key and scope, for the planned `add` upserts. `NULLS NOT DISTINCT` (Postgres 15+) makes two rows with a null `agent_id` and the same key collide. |
| `mnemocyte_memories_superseded_by_idx` | partial btree `(superseded_by) WHERE superseded_by IS NOT NULL` | The foreign-key check on delete and the dependents check in the delete CTE look rows up by `superseded_by`. |
| `mnemocyte_memories_content_tsv_idx` | GIN `(content_tsv)` | Full-text `@@` without parsing every row. |
| `mnemocyte_memories_embedding_hnsw_idx` | HNSW `vector_cosine_ops` or `halfvec_cosine_ops` | Cosine kNN. |
| `mnemocyte_events_scope_time_idx` | btree `(namespace, entity_id, timestamp, id)` | Audit pages, read backwards for newest first. |

Tradeoffs, measured with `EXPLAIN (ANALYZE, BUFFERS)` on Postgres 18.6 /
pgvector 0.8.1 with 130,000 memories (1,000 entities of about 100, one of
30,000), 13,000 superseded rows and 130,000 audit events; the numbers are in
the PR that added `0003`:

- `superseded_by` index: deleting one memory goes from about 32 ms to
  0.3 ms, because the foreign-key check on each deleted row becomes an index
  lookup instead of a table scan. Without it, pruning 3,000 rows would run
  3,000 such scans. It costs one more btree entry per superseded row only.
- `content_tsv` + GIN: keyword search on the 30,000-memory entity takes
  5 ms, against 7.5 ms without the GIN and 209 ms when `to_tsvector` runs
  per row as before. The stored column is most of the gain; the GIN cuts
  buffer reads from about 3,000 to 880 for large entities. On a 100-memory
  entity the planner uses the scope index alone (0.2 ms).
- No `(namespace, entity_id, kind)` index: with one, a `kinds` filter saves
  under 1 ms (0.26 → 0.19 ms per entity, 4.6 → 3.9 ms on the large one), and
  the HNSW path does not use it at all. Not worth another index on every
  write.
- Audit pages scan `mnemocyte_events_scope_time_idx` backwards with no sort
  (0.08 ms on the large entity). The `ORDER BY` names the table columns,
  because the select list's `id::text AS id` would otherwise shadow `id` and
  force a sort on the text.

`kind` and `importance` are plain `text` with no `CHECK` constraint; the
library validates them before writing.

## Ids

Memory and event ids are UUIDv7 strings generated in JavaScript
(`createUuidV7` in `memory/records.ts`): 48 bits of Unix milliseconds, then
random bits. They sort roughly by creation time, so primary-key inserts stay
near the right edge of the btree instead of hitting random pages as UUIDv4
does. Postgres has `uuidv7()` only from version 18, and CI also runs 17.

Every statement casts id parameters with `$n::uuid` and selects ids with
`::text`, so drivers that type string parameters as `text` work and every
driver returns ids as strings. An id that is not a canonical UUID cannot
match a row: `delete` and `update` report `NOT_FOUND`, `get` returns `null`,
lookups skip it without a query,
and an audit cursor with such an id throws `"VALIDATION"`.

## Scope

Rows carry `namespace`, `entity_id`, `agent_id` and `session_id`, and
memories an optional `key`. Every query in `db/queries/` takes a scope:
`visibilityConditions` for reads and writes by id (the scope plus shared
rows), `selectorConditions` for `deleteScope`, `prune`, `stats` and audit
listings (set fields match exactly, omitted ones match anything). The rules,
the keyed `INSERT … ON CONFLICT`, `list` pagination and `update` are in
[scopes.md](./scopes.md). Rows written before 0.6 are in namespace
`"default"` with no agent or session.

## Migrations

pgvector is a prerequisite: no migration runs `CREATE EXTENSION`. The SQL
lives in `migrations/`; `migrate()` runs the same SQL from
`src/db/migrations/bundled.ts` (see [the runner](#the-migrate-runner)).
Files in `migrations/`:

| File | What it does |
|---|---|
| `0000_initial.sql` | Creates memories and events tables, the self FK and the four indexes, with `vector(1536)`. |
| `0001_add_mnemocyte_meta.sql` | Creates `mnemocyte_meta(key, embedding_dimensions)` and inserts `('installation', 1536)`. |
| `0002_add_embedding_model.sql` | Adds `mnemocyte_meta.embedding_model` and backfills it when the stored memories use exactly one model. |
| `0003_schema_v2.sql` | Scope columns, `key`, `type` → `kind`, text ids → uuid, `content_tsv`, the new indexes, `mnemocyte_meta.vector_type`. |
| `fresh-install.sql` | The final schema of `0000`→`0003` in one file, rendered at 1536 dimensions. Only for an empty database. |
| `0000_initial.sql.template` | The same final schema with `{{EMBEDDING_DIMENSIONS}}` and `{{VECTOR_TYPE}}`. |
| `render-initial.mjs` | `--dimensions N [--out file]`: renders the template, with `halfvec` above 2,000 dimensions; rejects more than 4,000. |
| `meta/` | Drizzle journal for `0000`→`0003`, and snapshots for `0000`→`0002`. |

`0003` in detail:

- It converts ids with `CASE WHEN id ~* '<uuid pattern>' THEN id::uuid ELSE
  md5(id)::uuid END`, for `id`, `superseded_by`, event ids and the
  `memoryId` / `supersededBy` strings in event metadata. The mapping is
  deterministic, so applications can convert ids they stored with the same
  expression.
- The self FK is dropped before the type change and recreated after it, with
  the same name, which the delete path matches on.
- Postgres 18 stores `NOT NULL` as named constraints and keeps
  `mnemocyte_memories_type_not_null` through the column rename; a `DO` block
  renames it to `…_kind_not_null` when it exists, so upgraded and fresh
  catalogs match. Postgres 17 has no such constraint and skips it.
- The type changes and the new stored column share one `ALTER TABLE`, so
  each table is rewritten once. The rewrite takes `ACCESS EXCLUSIVE` and
  rebuilds every index, including HNSW.
- `namespace` is added with `DEFAULT 'default'` (Postgres fills existing
  rows from the catalog without a rewrite) and the default is dropped right
  after, so a write that forgets the namespace fails.
- The first statement is `ADD COLUMN "namespace"`, so running it twice fails
  at once with `42701` and, inside one transaction, changes nothing. The
  integration tests rely on this (`test/integration/schema-v2.ts`).

Install paths:

- Any database: `migrate({ store, dimensions })`.
- New database, 1536 dimensions: apply `fresh-install.sql`.
- New database, other dimensions: render the template and apply the result.
  It already contains the effects of `0001`→`0003`.
- Existing 0.1.x database: apply `0001`, `0002`, then `0003`.
- Existing 0.2.x or 0.3.x database: apply `0002`, then `0003`.
- Existing 0.4.x or 0.5.x database: apply `0003`.
- Inside this repository, `pnpm db:migrate` runs `drizzle-kit migrate` over
  the journal (`0000`→`0003`), reading `DATABASE_URL` or `.env`.

`fresh-install.sql` is generated from the template; a unit test fails if the
two drift, and an integration test compares its resulting catalog (columns
in order, constraints, indexes, metadata) with the `0000`→`0003` sequence.

To change the schema: write the next numbered migration by hand, add it to
`meta/_journal.json`, update the template so a fresh install matches the
upgraded catalog column for column, re-render `fresh-install.sql` with
`pnpm migration:render --dimensions 1536 --out migrations/fresh-install.sql`,
and regenerate the bundled module with `pnpm migration:bundle`. Teach
`installedVersion` in `src/db/migrations/runner.ts` the object the new
migration adds, so untracked schemas at that level are still adopted. There is no Drizzle schema to generate from: the
table definitions in `src/db/schema.ts` were removed with `0003`, because
drizzle-kit cannot express the dimension-dependent vector type, and their
inferred types blocked `isolatedDeclarations`.

### The `migrate()` runner

`migrate({ store, dimensions?, signal? })` is exported from the root
`mnemocyte` import and calls the store's `migrate` method; the Postgres one is
`runPostgresMigrations` in `src/db/migrations/runner.ts`. The root bundle
contains no SQL: it reaches the runner only through a store from
`mnemocyte/postgres` or `mnemocyte/stores/drizzle`.

- **Bundled SQL.** `scripts/bundle-migrations.mjs` (`pnpm migration:bundle`)
  writes every journal entry and the template into `bundled.ts` as template
  literals. Reading `migrations/` at runtime through `import.meta.url` would
  break in bundlers and serverless builds that do not copy the folder. Unit
  tests fail when the module differs from the script's output or from the
  `.sql` files, and when `renderInitialSchema(1536)` differs from
  `fresh-install.sql`.
- **Tracking table.** `mnemocyte_migrations(version integer PK, name text,
  applied_at timestamptz)`, resolved through `search_path` like the other
  tables. The runner creates it on its first call, after checking with
  `to_regclass` that it is missing (`CREATE TABLE IF NOT EXISTS` would send a
  notice on every later call, and postgres.js logs notices by default). It is
  not part of `fresh-install.sql` or the template.
- **One transaction per step.** The runner loops over
  `SqlExecutor.transaction`. Each transaction first runs
  `pg_advisory_xact_lock(7885351518266947956)` ("mnemocyt" in ASCII), then
  reads the tracking table and does one step: a fresh install, an adoption,
  or one numbered migration. The lock is transaction-level because a
  session-level `pg_advisory_lock` must be released on the connection that
  took it, which a pooled executor does not guarantee, and transaction-mode
  poolers do not support session locks. Under `READ COMMITTED` every
  statement after the lock sees what a concurrent caller committed before
  releasing it, so the second caller finds the step done.
- **Statements one at a time.** Each migration is split on
  `--> statement-breakpoint` and every statement is sent with `tx.query`, so
  drivers that use the extended query protocol (one statement per query)
  work. A statement failure becomes `"MIGRATION"` naming the migration, with
  the driver error as `cause`; the transaction rolls back.
- **Fresh install.** With no Mnemocyte tables, the runner requires
  `dimensions` (`"VALIDATION"`), checks `pg_extension` for `vector`
  (`"MIGRATION"` when missing), runs the template rendered for those
  dimensions (`halfvec` above 2,000), and records `0000`→`0003`.
- **Adoption.** With tables but an empty tracking table, `installedVersion`
  reads the level from the catalog: `mnemocyte_memories` and
  `mnemocyte_events` (`0000`), `mnemocyte_meta` (`0001`),
  `mnemocyte_meta.embedding_model` (`0002`), `mnemocyte_memories.namespace`
  (`0003`). Those versions are recorded without running; any other
  combination throws `"MIGRATION"`.
- **Dimensions.** Inside each locked transaction the runner reads the
  embedding column's `atttypmod`, which pgvector sets to the declared size
  of `vector(n)` and `halfvec(n)`, and throws `"CONFIG"` when `dimensions` is
  given and differs.
- **Tracking checks.** Recorded versions must be `0…n-1` without gaps, and
  `n` may not exceed the bundled count (a newer Mnemocyte migrated the
  database); both throw `"MIGRATION"`. There are no checksums: the SQL ships
  inside the package and users do not edit it.
- **Limits.** Stateless HTTP drivers have no `transaction`, so they cannot
  migrate. The self foreign key names `public.mnemocyte_memories`, so the
  tables must be in `public`. There is no `lock_timeout`: `0003` waits for
  its `ACCESS EXCLUSIVE` locks as long as the server allows.

## Installation metadata

`mnemocyte_meta` is the source of truth for the vector space. Before `add`,
`addMany`, `search`, `context`, `findDuplicates` and an `update` that changes
content, the store reads
it and:

- rejects with `"MIGRATION"` when the table, a column or the row is missing,
  or `vector_type` is not `vector` or `halfvec`;
- rejects with `"CONFIG"` when `embedder.dimensions` differs;
- when `embedding_model` is null, records the single model found in stored
  rows, or the configured model for an empty table, with a conditional
  `UPDATE … WHERE embedding_model IS NULL` so concurrent first writers agree;
  rejects with `"MIGRATION"` when stored rows hold more than one model;
- rejects with `"CONFIG"` when `embedder.model` differs from the recorded one.

A successful check is cached per store and per `(dimensions, model)`, so one
store value shared by clients with different embedders checks each of them.
A failed check is not cached. `vector_type` is cached with it and decides the
cast on every vector parameter (`$n::vector` or `$n::halfvec`); it is checked
against the two allowed values before it is put into SQL. `get`,
`list`, `delete`, `deleteScope`, `prune`, `listAuditLog`, `stats` and
updates that leave the content alone skip the check, so cleanup
works on an incompatible installation.

## Filtered vector search

An HNSW index scan collects `hnsw.ef_search` candidates (40 by default) and
Postgres applies the `WHERE` filters to those afterwards. Without help, a
selective filter (a `kinds` or `tags` filter, or one scope in a large table)
could leave fewer rows than exist, or none. The search vector search
(`vectorSearch` in `src/db/queries/memories.ts`) therefore sends two
statements that run in one transaction (see
[atomic statements](#atomic-statements)):

```sql
SELECT set_config('hnsw.iterative_scan', 'strict_order', true),
       set_config('hnsw.ef_search', $1, true);
SELECT …, embedding <=> $q::vector AS "vectorDistance"
FROM mnemocyte_memories
WHERE <scope and filters> AND embedding IS NOT NULL
ORDER BY "vectorDistance"
LIMIT $n;
```

- `set_config(…, true)` is `SET LOCAL`: the settings end with the
  transaction. Inside a caller's transaction they last until that
  transaction ends.
- `strict_order` (pgvector 0.8+) makes the scan continue past the first
  candidates, in exact distance order, until `LIMIT` rows pass the filters or
  `hnsw.max_scan_tuples` (20,000 by default) tuples were visited. Mnemocyte
  leaves `max_scan_tuples` and `scan_mem_multiplier` at the server's values.
  `relaxed_order` would need a materialized CTE to re-sort and gains little
  at search's small limits.
- `ef_search` is `max(40, limit)`, capped at pgvector's maximum of 1,000, so
  one HNSW pass can fill the request.
- The distance is computed once per row. `ORDER BY` names the selected
  column, and the planner still matches it to the index's ordering operator
  (pgvector needs `ORDER BY` to be a bare distance operator, ascending). The
  score `clamp(1 − distance, 0, 1)` (non-finite → 0) is computed in
  TypeScript with the in-memory backend's `toVectorScore`. Scores fall as
  distance grows, so the rows at or above `minVectorScore` are a prefix of
  the result and are filtered after the `LIMIT` with the same outcome.
- The planner does not always pick HNSW: for a small scope it reads the scope
  index and sorts, which is exact. `test/integration/filtered-vector-search.test.ts`
  drops the scope index in a rolled-back transaction to force the HNSW path,
  checks the plan with `EXPLAIN (ANALYZE, BUFFERS)` (an HNSW index scan, no
  sort) for `vector` and `halfvec`, and checks that the same statement with
  `iterative_scan = off` finds none of the filtered rows.

Before the first vector search each store reads `pg_extension.extversion`
once and rejects pgvector before 0.8.0 with `"MIGRATION"`. Without the check,
an older pgvector would reject `hnsw.iterative_scan` as an unknown setting
(`"DB"`), or, in a session that has not loaded pgvector yet, drop it with a
warning and return too few rows. A failed check is not cached.

Test data needs care: many hand-made vectors at the same distance (for
example one-hot perturbations) can leave parts of the HNSW graph unreachable,
so no `ef_search` finds them. The integration test uses seeded pseudo-random
vectors.

## Connections

Mnemocyte never creates or closes a database client. The application passes
the client it already owns to `postgresStore({ client })`, which turns it
into a `SqlExecutor`:

```ts
interface SqlExecutor {
  query<Row>(sql: string, params: readonly unknown[], options?: { signal?: AbortSignal }): Promise<Row[]>;
  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  batch?(statements: readonly SqlStatement[], options?: { signal?: AbortSignal }): Promise<Record<string, unknown>[][]>;
}
```

- `query` is required, and so is one of `transaction` and `batch`;
  `createPostgresStore` checks this with `assertSqlExecutor`
  (`src/db/atomic.ts`) and throws `"CONFIG"`.
- `batch` runs its statements in order in one transaction, all or nothing,
  and returns one rows array per statement. It is the shape of a
  non-interactive transaction: Neon's HTTP `sql.transaction([...])` and D1's
  `batch()` take a list of statements and return a list of results. A
  `set_config(…, true)` in one statement applies to the later ones.
- `postgresJs(sql)` (`mnemocyte/postgres`) wraps a postgres.js 3.4.9+ or
  4.x client and returns a `PostgresJsExecutor` with both optional methods.
  `query` is `sql.unsafe(text, params)` with `$1…` placeholders (`unsafe`
  defaults to `prepare: false` on both majors); `transaction` is
  `sql.begin`, or `sql.savepoint` inside a transaction (on 4.x a
  transaction's `sql` also has `begin`, so `savepoint` is what marks it).
  `batch` depends on the major:
  - 4.1+, outside a transaction: `sql.batch([...unsafe queries])`, which
    sends every statement in one round trip ending in a single Sync.
    Postgres runs everything before a Sync as one implicit transaction, so
    the statements commit together, roll back together, and a
    `set_config(…, true)` reaches the later ones. No connection is held
    for a transaction.
  - 3.x and 4.0 (no `sql.batch`), and inside a transaction on any major:
    the array of `unsafe` queries returned from the `sql.begin` (or
    `sql.savepoint`) callback, which postgres.js awaits with `Promise.all`,
    so the statements are pipelined on the transaction's connection at the
    cost of `BEGIN`, one pipelined round trip and `COMMIT`. Inside a
    transaction a failed `sql.batch` would abort the whole outer
    transaction, so the savepoint keeps the failure to the batch.

  On abort it cancels what it sent (the `sql.batch`, or every statement)
  and throws `"ABORTED"`; postgres.js rolls back.
- `postgresStore({ client })` turns a client into `MemoryConfig.store`
  through `toSqlExecutor` (`src/sql/clients.ts`); see
  [client detection](#client-detection).
- `drizzleStore(db)` (`mnemocyte/stores/drizzle`) is
  `postgresStore({ client: db })` for a Drizzle instance; its parameter type
  also accepts `PostgresJsDatabase`, which does not declare `$client`. A
  value without `$client` throws `"CONFIG"`.
- TLS, pool size, timeouts and `prepare` are whatever the caller configured.
  `unsafe` does not create named prepared statements, so transaction-mode
  poolers work as they are.
- The memory client has no `close()`; the caller ends its own client.

Writes need no connection held across round trips, which is what
stateless HTTP drivers (Neon's HTTP driver, D1) require. The guarded deletes
are one `WITH … DELETE`, and `consolidate` is one `WITH` query (see
[maintenance.md](./maintenance.md#experimentalconsolidate)). Only `migrate()`
needs `transaction`, because each step reads the tracking table and decides
what to run from it; without one it throws `"CONFIG"`.

### Client detection

`toSqlExecutor` reads properties only and imports no driver, so the built
entries stay free of driver imports (a package test checks this). Checks run
in a fixed order and the first match wins (ARCHITECTURE decision 21):

1. postgres.js: a function with `unsafe` and `begin` (or `savepoint`, a
   transaction's `sql`) → `postgresJs`. The top-level `sql` has `begin` on
   both majors (4.x adds `batch`); a transaction's `sql` has `savepoint`,
   and on 4.x also `begin` and `batch`. A reserved connection
   (`sql.reserve()`) has neither `begin` nor `savepoint` on either major,
   so it falls through to the `"CONFIG"` error: it cannot open a
   transaction.
2. Drizzle: an object with `$client`, which must match 1, 3 or 4. A
   `pg.Client` there gets the error below; anything else gets `"CONFIG"`
   naming the supported Drizzle drivers.
3. PGlite (or `PGliteWorker`): an object with `query`, `exec` and
   `transaction` → `pgliteExecutor`. It comes before the `SqlExecutor`
   check because it has that shape too, but its `query` returns
   `{ rows }`.
4. node-postgres `Pool`: an object with `query`, `connect` and a numeric
   `totalCount` → `nodePostgresExecutor`. pg-compatible pools (Neon's
   serverless `Pool`) match.
5. `SqlExecutor`: an object with `query` and `transaction` or `batch`,
   returned unchanged. A function never matches, so Neon's HTTP `sql`
   (which has `query` and an array-taking `transaction`) is rejected.

An object with `query` and `connect` but no `totalCount` is a `pg.Client`
and throws `"CONFIG"` asking for a `Pool`: a transaction must run on one
connection, which only `pool.connect()` gives without taking over the
caller's client. Everything else throws `"CONFIG"` listing the accepted
clients.

The public types are structural (`PostgresJsClient`, a union of the
`begin` and `savepoint` shapes, `NodePostgresPool`,
`PGliteClient`, `DrizzleClient`, their union `PostgresClient`), so the
`.d.mts` files name no driver package either. A `pg.Client` still
type-checks, because its `query` fits `SqlExecutor`, whose other methods are
optional; it fails at runtime.

The adapters:

- `nodePostgresExecutor` (`src/sql/node-postgres.ts`): `query` is
  `pool.query(text, values).rows`. `transaction` checks out a client, runs
  `BEGIN`, the callback and `COMMIT` on it, and `ROLLBACK` on failure; the
  client is released in `finally`, with `release(true)` (destroy) when the
  `ROLLBACK` itself failed. node-postgres warns that consecutive
  `pool.query` calls may use different connections, so nothing in a
  transaction goes through the pool. No `batch`: pg sends a client's
  queries one at a time, so a transaction costs the same.
- `pgliteExecutor` (`src/sql/pglite.ts`): `query` is `db.query(...).rows`
  (one statement, extended protocol), `transaction` is `db.transaction`,
  which holds PGlite's exclusive lock until it ends.
- Both pass the callback a `createScopedExecutor` (`src/sql/scoped.ts`):
  `query` on the transaction's connection, and a nested `transaction` that
  runs `SAVEPOINT mnemocyte_savepoint_<depth>`, then `RELEASE` or
  `ROLLBACK TO`. PGlite's `tx` has no `transaction` of its own.
- Neither driver can cancel a running query (pg has no public cancel API,
  PGlite none at all). Their executors check the signal before each
  statement and throw `"ABORTED"`; a statement already sent runs to the
  end.

Driver errors carry the violated constraint as `constraint_name`
(postgres.js) or `constraint` (node-postgres and PGlite, both built on
`pg-protocol`); `postgresConstraintName` (`src/db/errors.ts`) reads either,
for the key-collision and foreign-key `"CONFLICT"` mappings.

### Atomic statements

Two paths need several statements to commit together: the search vector
query (its `set_config` must share a transaction with the query) and chunked
inserts. Both go through `runAtomically` (`src/db/atomic.ts`):

- One statement goes through `query`; a single statement is already atomic.
- Otherwise `batch` when the executor has it, else a `transaction` that sends
  the statements one at a time.
- A `batch` that returns a different number of results than statements
  throws `"DB"`.

### Chunked inserts

`insertMemories` splits rows into `INSERT … ON CONFLICT` statements of
`INSERT_CHUNK_ROWS` (250) rows and runs them through `runAtomically`, so an
`addMany` commits all its rows or none. Placeholders restart at `$1` in each
statement.

- A memory row binds 23 parameters. Postgres allows 65,535 per statement
  (the Bind message counts them in an Int16), and postgres.js (3.4 and 4.x) rejects
  65,534 or more (`MAX_PARAMETERS_EXCEEDED`), so one statement could hold
  2,849 rows; before chunking, larger `addMany` calls failed with `"DB"`.
- 250 rows keep one statement near 4 MB at 1,536 dimensions. A `batch` over
  HTTP sends every statement in one request (64 MB on Neon), and `addMany`
  takes at most 1,000 memories, so a full call stays near 20 MB of vectors.
- Keys are distinct within a call, so two chunks never upsert the same row.
- Audit events use the same chunking: `insertEvents` writes one multi-row
  `INSERT` per 250 events (8 parameters each) instead of one statement per
  event. Audit stays best-effort after the memory write commits.

All queries are plain SQL strings built in `src/db/queries/`. Values are
always parameters, never interpolated; the only interpolated value is the
checked `vector_type`. Every parameter is a string, a finite number or null.
postgres.js 3.x typed a `Date`, boolean, `bigint`, `Buffer` or array from
JavaScript and 4.x sends every value untyped for the server to decide
(unless `infer: true`); strings, numbers and null are written the same
either way. Parameters that land on a typed column or function argument
need no cast; the rest have one (`::timestamptz`, `::uuid`, `::text`,
`::int`, `::real`, the vector type). The PGlite contract run "parameter
types checked" wraps the executor and fails on any other value. Three type
rules keep the SQL independent of driver-level parsers (Drizzle installs
its own on a shared client):

- Timestamps are sent as ISO strings with `::timestamptz` and read as `Date`
  or string, then normalized.
- `jsonb` is sent as text with `::text::jsonb` and read back with `::text`,
  then parsed, so no driver serializer wraps it twice.
- Vectors travel as text (`'[…]'::vector`, `embedding::text`).

`tags` are written as one JSON parameter turned into a `text[]` in input
order, so the number of bind parameters does not grow with the tag count.
Id lists inside a statement (consolidation's requested ids and audit event
ids) use the same trick.

## Errors

- SQLSTATE `42P01`, `42703`, `42704`, `42883` (missing table, column, object,
  function) become `"MIGRATION"`.
- A `23503` foreign-key violation on the `superseded_by` constraint during a
  delete becomes `"CONFLICT"`.
- Everything else becomes `"DB"` with the driver error as `cause`.

## Cancellation

`prune`, `findDuplicates`, `listAuditLog`, `consolidate` and its preflight
lookups pass their signal to `SqlExecutor.query`, and the `addMany` insert
passes it to `query`, `batch` or each statement of its transaction, and the postgres.js adapter
sends `query.cancel()` when it aborts, on both majors. postgres.js 4 also
has `query.signal(abortSignal)`, which only calls the same `cancel()`, so
the adapter keeps one path. `cancel()` returns the cancel request's promise,
which on 4.x rejects when the server does not answer within
`cancel_timeout` (`CANCEL_UNANSWERED`); the adapter catches it, since the
query rejects on its own. The node-postgres and PGlite adapters
only check the signal before each statement (see
[client detection](#client-detection)). postgres.js opens a second connection
for the cancel request and documents that, in a race, it can cancel a
different query on that backend; Mnemocyte accepts this and rejects the
caller with `"ABORTED"` either way. Because `consolidate` is one statement, a
cancel while it waits for a row lock stops it before anything is written; a
cancel that arrives after the statement finished has no effect. Other
queries are not cancelled.

## Known problems

Each one is a roadmap item in Phase 1 unless noted.

- `psql -f` without `-v ON_ERROR_STOP=1 --single-transaction` keeps going
  after an error and can leave a partial schema; `migrate()` then refuses to
  adopt it. The guide shows the flags.
