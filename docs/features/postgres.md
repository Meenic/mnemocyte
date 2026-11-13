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
| `mnemocyte_events_scope_time_idx` | btree `(namespace, entity_id, timestamp, id)` | Audit pages, read backwards for newest first, and `pruneAuditLog` batches, read forwards. |

The `ORDER BY` of audit pages and `pruneAuditLog` batches names the table
columns, because the select list's `id::text AS id` would otherwise shadow
`id` and force a sort on the text.

### Indexes measured

`pnpm bench:postgres` (see [DEVELOPMENT.md](../DEVELOPMENT.md#testing))
measures every default index with `EXPLAIN (ANALYZE, BUFFERS)`, with the
index and without it (dropped inside a transaction that rolls back), on the
statements the library sends. Numbers from 2026-11-13: Postgres 18.6 and
pgvector 0.8.7 in Docker (`pgvector/pgvector:0.8.7-pg18`, default settings:
`shared_buffers` 128 MB, `work_mem` 4 MB, JIT on), on a Windows laptop
(WSL 2). Times are the median of five warm runs; run-to-run noise is about
±25% for the slower cases, so only differences well beyond that count.

The main dataset is 132,000 memories at 1,536 dimensions (`vector`) in one
namespace: one entity of 30,000 ("large"), one of 2,000 ("mid") and 1,000 of
100 ("small"), written over a year with all entities interleaved in the
heap, 13,200 superseded and 132,000 audit events. Embeddings are 256 random
cluster centers plus noise, and one memory in ten is a near-copy of another.
The table is 1.09 GB (vectors are stored in TOAST), the HNSW index 1.01 GB,
the GIN 9.1 MB, the scope index 968 kB.

| Index | Query | With | Without |
|---|---|---|---|
| HNSW | vector search, large entity | 2–11 ms, 1,200–6,400 buffers (two query vectors) | 322 ms, 111,000 buffers (reads and sorts the entity) |
| scope | vector search, small entity | 1.5 ms, 440 buffers | 65 ms, 9,600 buffers (table scan) |
| GIN | keyword search, large entity | 8.0 ms, 1,900 buffers | 24 ms, 8,900 buffers |
| `superseded_by` | delete one memory | 0.4 ms | 80 ms (30 ms of it the foreign-key check, the rest the dependents check) |
| `superseded_by` | prune 3,000 superseded memories of the large entity | 159 ms | 96 s (3,000 foreign-key checks, each a table scan) |
| events scope | audit page, large entity | 0.08 ms | 31 ms (table scan and sort) |
| primary key | `get` by id | 0.05 ms, 4 buffers | (needed by the foreign key) |
| scope + key | keyed `add` | 2.6 ms, the `ON CONFLICT` arbiter | (needed for correctness) |

What each index costs a write, measured on one 250-row `addMany` chunk
inserted into the large entity:

| Indexes present | Time |
|---|---|
| All (default) | 268 ms |
| All but HNSW | 22 ms |
| Only the primary key and the scope + key index | 13 ms |

HNSW is about 1 ms per inserted memory at this size: each insert searches
the graph for the new vector's neighbors. Dropping the GIN, the scope index
or the `superseded_by` index alone changes the chunk by less than the noise
(219–283 ms). The other indexes together cost about 9 ms per 250 rows.

How the planner uses them:

- A small entity's vector search reads its 100 rows through the scope index
  and sorts them, which is exact (1.5 ms); a mid entity's 2,000 rows take
  23 ms the same way. The large entity's search uses HNSW (see
  [filtered vector search](#filtered-vector-search) for recall).
- A small entity's keyword search for a common word combines the scope
  index with the GIN (`BitmapAnd`), whose bitmap covers every row in the
  table with the word: 1.2 ms, against 0.3 ms with the scope index alone.
  The planner's choice; the loss is under a millisecond.
- `prune` of a large entity hashes the candidates and scans the table
  twice, once for dependents outside the selection and once for the delete
  (159 ms for 3,000 rows); the foreign-key checks still use the
  `superseded_by` index.
- `content_tsv` as a stored column was most of the gain over 0.x, which ran
  `to_tsvector` per row: 209 ms for the large entity's keyword search when
  `0003` was measured.

No `(namespace, entity_id, kind)` index. With one, keyword search with a
`kinds` filter takes 0.12 ms instead of 1.2 ms on a small entity and 1.9 ms
instead of 6.4 ms on the large one; the HNSW path does not use it, and its
write cost is lost in HNSW's. The saving is a few milliseconds on one kind of
query, so it stays out until an application shows a `kinds`-heavy workload.

Audit pages read `mnemocyte_events_scope_time_idx` backwards with no sort
(0.08–0.17 ms). `pruneAuditLog` reads it forwards in keyset batches; a
separate `(timestamp)` index was measured and left out (see
[maintenance.md](./maintenance.md#retention)).

At 3,072 dimensions (`halfvec`, 42,000 memories: the large and mid entities
and 100 small ones) the HNSW index is 328 MB next to a 355 MB table and
builds in 23 s; a large-entity search takes 2.6 ms against 303 ms without
it, and a small entity's 1.4 ms through the scope index.

`kind` and `importance` are plain `text` with no `CHECK` constraint; the
library validates them before writing.

## Ids

Memory and event ids are UUIDv7 strings generated in JavaScript
(`createUuidV7` in `memory/records.ts`): 48 bits of Unix milliseconds, then
random bits. They sort roughly by creation time, so primary-key inserts stay
near the right edge of the btree instead of hitting random pages as UUIDv4
does. Postgres has `uuidv7()` only from version 18, and CI also runs 17.

Audit events written by a `delete` or `prune` are the exception: the
statement cannot know in advance how many events it writes, so it builds
each id in SQL (`sqlUuidV7` in `src/db/sql.ts`): the event time's Unix
milliseconds over the first 48 bits of a `gen_random_uuid()` (core since
Postgres 13), with the version nibble set to 7. `add`, `addMany`, `update`
and `consolidate` pass ids generated in JavaScript, one per row.

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

No migration file runs `CREATE EXTENSION`; pgvector is enabled by an admin
or, on request, by `migrate()` (see
[enabling pgvector](#enabling-pgvector)). The SQL
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

- Any database: `migrate({ memory })` or `migrate({ store, dimensions })`.
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

`migrate(input)` is exported from the root `mnemocyte` import and calls the
store's `migrate` method; the Postgres one is `runPostgresMigrations` in
`src/db/migrations/runner.ts`. The root bundle contains no SQL: it reaches
the runner only through a store from `mnemocyte/postgres` or
`mnemocyte/stores/drizzle`.

- **Input.** Either `{ memory }` or `{ store, dimensions? }`, plus
  `createExtension?`, `dryRun?` and `signal?`; both or neither of `memory`
  and `store` is `"VALIDATION"`, and the TypeScript union rejects them too.
  `createMemory` attaches the client's store and embedder under the
  non-enumerable `Symbol.for("mnemocyte.memory-client")` key
  (`src/memory/client-internals.ts`), so they stay out of `Object.keys`,
  spreads and JSON, and a client from one copy of the package works with
  `migrate` from another, like the store envelope. `migrate` reads
  `embedder.dimensions` from it, rejects an explicit `dimensions` that
  differs (`"CONFIG"`) and checks the 1–4,000 bound under the name
  `embedder.dimensions`. An in-memory store resolves with empty lists.

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
- **Inspection.** Every transaction starts with `inspect`: the lock, the
  dimensions check, the tracking table, then, without tracked versions, the
  catalog level and, for a fresh install, `pg_extension`. It returns
  `fresh`, `untracked` or `tracked` and throws every error a run raises
  before its first change, so a real step and a dry run share them.
- **Fresh install.** With no Mnemocyte tables, the runner requires
  `dimensions` (`"VALIDATION"`), checks `pg_extension` for `vector`, runs
  the template rendered for those dimensions (`halfvec` above 2,000), and
  records `0000`→`0003`. A missing pgvector is `"MIGRATION"` unless
  `createExtension` is set; see the next section.
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
- **Dry run.** `dryRun` opens one transaction whose first statement is
  `SET TRANSACTION READ ONLY`, so any write would fail instead of landing,
  then takes the advisory lock (allowed in a read-only transaction), so it
  waits for a running step and reports what is left after it. It turns the
  inspection into the whole result: the remaining tracked migrations, or
  the adopted and pending ones, or every migration for a fresh install,
  with `extensionCreated` true when pgvector is missing and
  `createExtension` is set. It creates no tracking table. It cannot see a
  statement that would fail on data, and it does not check whether the role
  may create the extension.
- **Limits.** Stateless HTTP drivers have no `transaction`, so they cannot
  migrate or dry-run. The self foreign key names `public.mnemocyte_memories`, so the
  tables must be in `public`. There is no `lock_timeout`: `0003` waits for
  its `ACCESS EXCLUSIVE` locks as long as the server allows.

### Enabling pgvector

`createExtension: true` lets a fresh install run `CREATE EXTENSION IF NOT
EXISTS vector` (no `SCHEMA` clause, so pgvector's objects go into the first
schema on `search_path`, normally `public` like the tables). It is off by
default (ARCHITECTURE decision 20): pgvector's control file is not marked
`trusted`, so only a superuser, or a provider's admin role, may create it.

- It runs only on the fresh-install path, after `pg_extension` shows
  `vector` missing, so an installed pgvector gets no statement and no
  notice. Once Mnemocyte tables exist the `vector` column depends on the
  extension, so the existing-installation paths never look.
- It runs inside the fresh install's locked transaction, before the schema.
  `CREATE EXTENSION` is transactional: a schema that fails takes the
  extension with it, and concurrent callers take turns at the lock, so two
  of them never race to insert the same `pg_extension` row.
- SQLSTATE `42501` (`insufficient_privilege`: "permission denied to create
  extension") becomes `"MIGRATION"` with a message to have an admin run
  `CREATE EXTENSION vector;`; `0A000` ("extension is not available": the
  server lacks pgvector's files) becomes `"MIGRATION"` saying so; anything
  else becomes `"MIGRATION"` "CREATE EXTENSION vector failed". The driver
  error is the `cause` each time.
- `extensionCreated` in the result is true when the call ran it.

## Installation metadata

`mnemocyte_meta` is the source of truth for the vector space. Before `add`,
`addMany`, `search`, `context`, `findDuplicates` and an `update` that changes
content, the store reads
it and:

- rejects with `"MIGRATION"` when the table or a column is missing (the
  migrate hint under [Errors](#errors)), when the row is missing, or when
  `vector_type` is not `vector` or `halfvec`. The missing-row message does
  not suggest `migrate`, which writes the row only on a fresh install; it
  links the guide's section with the `INSERT` that restores it;
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
SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true),
       set_config('hnsw.ef_search', $1, true);
WITH nearest AS MATERIALIZED (
  SELECT …, embedding <=> $q::vector AS "vectorDistance"
  FROM mnemocyte_memories
  WHERE <scope and filters> AND embedding IS NOT NULL
  ORDER BY "vectorDistance"
  LIMIT $n
)
SELECT * FROM nearest ORDER BY "vectorDistance" + 0;
```

- `set_config(…, true)` is `SET LOCAL`: the settings end with the
  transaction. Inside a caller's transaction they last until that
  transaction ends.
- An iterative scan (pgvector 0.8+) continues past the first candidates
  until `LIMIT` rows pass the filters or `hnsw.max_scan_tuples` (20,000 by
  default) tuples were visited. Mnemocyte leaves `max_scan_tuples` and
  `scan_mem_multiplier` at the server's values. With `strict_order` a later
  pass drops rows closer than ones already returned; `relaxed_order` keeps
  them, so more of the exact nearest rows come back, slightly out of order
  (decision 34).
- The materialized CTE puts them back in distance order. The outer sort
  reads at most `limit` rows. `+ 0` is needed on Postgres 17+, which would
  otherwise take the CTE's output as already sorted and skip the sort (the
  pgvector README's iterative index scans section). The query inside the
  CTE is planned as before, and pgvector's cost estimate does not read
  `iterative_scan`, so the planner's choice of HNSW does not change.
- `ef_search` is `max(40, limit)`, capped at pgvector's maximum of 1,000, so
  one HNSW pass can fill the request. The floor stays at pgvector's default
  because a higher one changes the plan (below).
- Measured with `pnpm bench:postgres` (see
  [indexes measured](#indexes-measured)): a `search` with `limit: 10` (30
  vector rows) on the large entity, over 20 query vectors, against the same
  statement with index scans off, both orderings on the same index build.
  Time is the median over the queries of each query's median of five warm
  runs. "Exact" is the share of the exact rows returned; buffers are the
  mean per query.

  | `ef_search` 40 | 1,536 dims (entity 23% of the table) | same, `kinds` keeping a tenth | 3,072 dims, `halfvec` (entity 71%) | same, `kinds` |
  |---|---|---|---|---|
  | `strict_order` | HNSW, 3.2 ms (p90 24 ms), 2,687 buffers, 82.7% exact | HNSW, 31 ms (p90 122 ms), 13,471 buffers, 61.7% | HNSW, 1.6 ms (p90 10.7 ms), 1,291 buffers, 89.8% | seq scan + sort, 44 ms, 100% |
  | `relaxed_order` + CTE | HNSW, 3.3 ms (p90 5.1 ms), 1,385 buffers, 95.8% | HNSW, 23 ms (p90 35 ms), 10,319 buffers, 80.7% | HNSW, 1.9 ms (p90 2.5 ms), 717 buffers, 91.8% | seq scan + sort, 46 ms, 100% |

  The returned rows are closer too: at 1,536 dimensions 16.2% farther on
  average than the exact rows with `strict_order`, 3.6% with
  `relaxed_order`. The p90 falls because the relaxed scan fills the
  `LIMIT` after visiting fewer tuples.
- A higher `ef_search` is not a safe way to raise recall further. With
  `strict_order` (`relaxed_order` got the same plan at every value):

  | `ef_search` | 1,536 dims | same, `kinds` | 3,072 dims, `halfvec` |
  |---|---|---|---|
  | 40 (default) | HNSW, 3.2 ms, 82.7% | HNSW, 31 ms, 61.7% | HNSW, 1.6 ms, 89.8% |
  | 100 | HNSW, 2.5 ms, 99.3% | scope index + sort, 41 ms, 100% | seq scan + sort, 308 ms, 100% |
  | 200 | HNSW, 2.4 ms, 99.3% | scope index + sort, 49 ms, 100% | seq scan + sort, 353 ms, 100% |
  | 300 | scope index + sort, 346 ms, 100% | scope index + sort, 51 ms, 100% | HNSW, 5.1 ms, 100% |
  | 400 | scope index + sort, 342 ms, 100% | scope index + sort, 46 ms, 100% | HNSW, 6.8 ms, 100% |

  Where HNSW is kept, a higher `ef_search` costs nothing and returns
  closer rows. But pgvector's `hnswcostestimate` sets the HNSW scan's
  startup cost to its total cost times a fraction that grows with
  `ef_search`, and under a `LIMIT` a higher startup cost makes reading the
  scope and sorting look cheaper. Every query at a given value got the
  same plan, and where the planner switches depends on the table: 100–200
  are the best values at 1,536 dimensions and the worst at 3,072. No fixed
  value above 40 kept HNSW on both datasets, so the default stays
  (decision 33). With the `kinds` filter the switch is a gain over
  `strict_order` (exact rows at a better p90), less so over
  `relaxed_order`. Recall at the default varies between builds of the same
  data (92.8%, 87.8% and 82.7% at 1,536 dimensions, 99.8%, 94.8% and 89.8%
  at 3,072, with `strict_order` in three runs), since a parallel HNSW build
  is not deterministic; compare orderings within one run.
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
  checks the plan with `EXPLAIN (ANALYZE, BUFFERS)` (an HNSW index scan and
  one sort, the outer one on `"vectorDistance" + 0`) for `vector` and
  `halfvec`, and checks that the same statement with `iterative_scan = off`
  finds none of the filtered rows.
- `findDuplicates` keeps `strict_order` without a CTE (see
  [maintenance.md](./maintenance.md)); measuring `relaxed_order` on its
  HNSW path is a roadmap item.

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
the client it already owns as `createMemory({ store })` (or
`migrate({ store })`), or to `postgresStore({ client })`; either way it
becomes a `SqlExecutor`:

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
- `createMemory({ store: client })` and `migrate({ store: client })`
  resolve `store` in `resolveStore` (`src/memory/store-input.ts`): a store
  config from `postgresStore()` or `drizzleStore()` first, then a client;
  see [client detection](#client-detection) and
  [lazy loading](#lazy-loading).
- `postgresStore({ client })` turns a client into a store config through
  `toSqlExecutor` (`src/sql/clients.ts`), eagerly: the `mnemocyte/postgres`
  entry imports the backend statically.
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
[maintenance.md](./maintenance.md#consolidate)). Only `migrate()`
needs `transaction`, because each step reads the tracking table and decides
what to run from it; without one it throws `"CONFIG"`.

### Client detection

`detectClient` (`src/sql/detect.ts`) reads properties only and imports no
driver or adapter, so it can sit in the root entry and the built entries
stay free of driver imports (a package test checks this). It returns the
client tagged with its driver, unwrapped from Drizzle, or `undefined`;
`executorFor` (`src/sql/clients.ts`) then wraps it in its adapter, and
`toSqlExecutor` is the two in a row. Checks run in a fixed order and the
first match wins (ARCHITECTURE decisions 21 and 23):

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
clients. Messages name what the caller passed: `client` for
`postgresStore` and `toSqlExecutor`, `store` for `createMemory` and
`migrate`, whose unrecognised-value message also names `postgresStore()`
and `drizzleStore()`.

The public types are structural (`PostgresJsClient`, a union of the
`begin` and `savepoint` shapes, `NodePostgresPool`,
`PGliteClient`, `DrizzleClient`, their union `PostgresClient`), so the
`.d.mts` files name no driver package either. `MemoryConfig.store` and
`migrate`'s `store` are `MnemocyteStoreConfig | PostgresClient`, without
extra `createMemory` overloads, and `mnemocyte` exports `PostgresClient`
as a type. A `pg.Client` still type-checks, because its `query` fits
`SqlExecutor`, whose other methods are optional; it fails at runtime.

### Lazy loading

A client passed as `store` gets a lazy store (`createLazyStore`,
`src/memory/lazy-store.ts`): a `MemoryStore` whose `backend` is
`"postgres"` from the start and whose every method first awaits one shared
`import("./postgres-backend.js")`, which builds the real store with
`executorFor` and `createPostgresStore`. Every `MemoryStore` method is
async, so `createMemory` stays synchronous and detection errors stay
synchronous `"CONFIG"`; nothing is imported or queried until the first
call, `migrate({ memory })` included. Concurrent first calls share one
load; a failed load throws `"CONFIG"` with the import error as `cause` and
is not cached, so the next call retries.

Rolldown puts every dynamic `import()` target in its own chunk, so
`dist/index.mjs` reaches the backend (`postgres-backend-*.mjs`, which
imports the shared chunk `mnemocyte/postgres` also uses) only through
that `import()`. A static import would put the queries, migration runner
and adapters in every in-memory user's bundle, and top-level `await`
would make `require("mnemocyte")` throw `ERR_REQUIRE_ASYNC_MODULE`. A
consumer importing only `createMemory`, bundled and minified with
Rolldown (2026-11-13):

| Build | Loaded at startup | Loaded on first Postgres call |
|---|---|---|
| 0.6 (no client support) | 45.2 KB, 13.4 KB gzip | none |
| Lazy (this design) | 48.8 KB, 15.0 KB gzip | 47.0 KB, 12.5 KB gzip |
| Static import | 95.3 KB, 26.1 KB gzip | none |

Package tests check that no static import from `dist/index.mjs` reaches
the backend, and that a packed CommonJS consumer can `require` the
package and run a client passed as `store`.

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
inserts. Every other write, audit events included, is one statement. Both
go through `runAtomically` (`src/db/atomic.ts`):

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
- With audit on, each chunk is a `WITH written AS (INSERT … RETURNING …)`
  whose `audit` step inserts that chunk's events, so they commit or roll
  back with the chunks. The step adds one JSON parameter (each row's id,
  key and event id, read with `jsonb_to_recordset`).

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
  function) become `"MIGRATION"`, from `missingSchemaError` in
  `src/memory/postgres.ts`: "Mnemocyte's tables are missing or out of date
  in this database (*driver message*). Run migrate({ memory }) to create or
  upgrade them:" followed by the guide's `#install-the-schema` URL. The
  driver message is repeated (whitespace collapsed, cut at 200 characters)
  because many log pipelines drop `cause`; the driver error is still the
  `cause`. The message names no SQL files and does not mention
  `createExtension`: when pgvector is also missing, `migrate` itself fails
  before changing anything and names it. `MIGRATE_COMMAND` holds the fix,
  so `feat/cli` changes one line. The guide URL points at `main`, like the
  README's links.
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
