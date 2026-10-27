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
- No `(namespace, entity_id, kind)` index: with one, a `types` filter saves
  under 1 ms (0.26 → 0.19 ms per entity, 4.6 → 3.9 ms on the large one), and
  the HNSW path does not use it at all. Not worth another index on every
  write.
- Audit pages scan `mnemocyte_events_scope_time_idx` backwards with no sort
  (0.08 ms on the large entity). The `ORDER BY` names the table columns,
  because the select list's `id::text AS id` would otherwise shadow `id` and
  force a sort on the text.

`kind` and `importance` are plain `text` with no `CHECK` constraint; the
library validates them before writing. Queries select `kind AS "type"`
because the public field is still `type`.

## Ids

Memory and event ids are UUIDv7 strings generated in JavaScript
(`createUuidV7` in `memory/records.ts`): 48 bits of Unix milliseconds, then
random bits. They sort roughly by creation time, so primary-key inserts stay
near the right edge of the btree instead of hitting random pages as UUIDv4
does. Postgres has `uuidv7()` only from version 18, and CI also runs 17.

Every statement casts id parameters with `$n::uuid` and selects ids with
`::text`, so drivers that type string parameters as `text` work and every
driver returns ids as strings. An id that is not a canonical UUID cannot
match a row: `forget` reports `NOT_FOUND`, lookups skip it without a query,
and an audit cursor with such an id throws `"VALIDATION"`.

## Scope

Rows carry `namespace`, `entity_id`, `agent_id` and `session_id`. The public
API still takes only `entityId`, so the store builds a `StoreScope` with
`entityScope(entityId)`: namespace `"default"`, no agent, no session.
Queries in `db/queries/` take that scope:

- Reads and id lookups (`recall`, embeddings, access updates, `getMemory`,
  consolidation, duplicates) match the namespace and entity, and for each
  optional field either the given value or null (shared). A null field
  matches only shared rows.
- Deletes by entity and `stats` match the namespace and entity across all
  agents and sessions, so erasing an entity leaves nothing behind.
- `prune` and global `stats` always stay inside one namespace.
- Audit events are listed by namespace and entity.

## Migrations

pgvector is a prerequisite: no migration runs `CREATE EXTENSION`. Files in
`migrations/`:

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
Nothing records which files were applied outside Drizzle's own journal.

To change the schema: write the next numbered migration by hand, add it to
`meta/_journal.json`, update the template so a fresh install matches the
upgraded catalog column for column, and re-render `fresh-install.sql` with
`pnpm migration:render`. There is no Drizzle schema to generate from: the
table definitions in `src/db/schema.ts` were removed with `0003`, because
drizzle-kit cannot express the dimension-dependent vector type, and their
inferred types blocked `isolatedDeclarations`.

## Installation metadata

`mnemocyte_meta` is the source of truth for the vector space. Before `remember`,
`rememberMany`, `recall`, `buildContext` and `findDuplicates`, the store reads
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
against the two allowed values before it is put into SQL. `forget`,
`forgetAll`, `prune`, `listAuditLog` and `stats` skip the check, so cleanup
works on an incompatible installation.

## Connections

Mnemocyte never creates or closes a database client. The application passes
the client it already owns, wrapped as a `SqlExecutor`:

```ts
interface SqlExecutor {
  query<Row>(sql: string, params: readonly unknown[], options?: { signal?: AbortSignal }): Promise<Row[]>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}
```

- `postgresJs(sql)` (`mnemocyte/postgres`) wraps a postgres.js client.
  `query` is `sql.unsafe(text, params)` with `$1…` placeholders; `transaction`
  is `sql.begin`, or `sql.savepoint` inside a transaction.
- `postgresStore({ client })` turns an executor into `MnemocyteConfig.store`.
- `drizzleStore(db)` (`mnemocyte/stores/drizzle`) takes a
  `drizzle-orm/postgres-js` instance and runs the same SQL on `db.$client`,
  sharing its pool. Other Drizzle drivers are not supported. A value without a
  postgres.js `$client` throws `"CONFIG"`.
- TLS, pool size, timeouts and `prepare` are whatever the caller configured.
  `unsafe` does not create named prepared statements, so transaction-mode
  poolers work as they are.
- `client.close()` releases nothing; the caller ends its own client.

Every write is one statement. The guarded deletes are one `WITH … DELETE`,
and `consolidate` is one `WITH` query (see
[maintenance.md](./maintenance.md#experimentalconsolidate)), so the backend
never calls `transaction` and needs no connection held across round trips.
That is what stateless HTTP drivers (Neon's HTTP driver, D1) require.
`transaction` stays on the interface for drivers that have it; an optional
`batch` for paths that need several statements is planned with
`fix/batch-writes`, the first such path.

All queries are plain SQL strings built in `src/db/queries/`. Values are
always parameters, never interpolated; the only interpolated value is the
checked `vector_type`. Three type rules keep the SQL independent of
driver-level parsers (Drizzle installs its own on a shared client):

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
lookups pass their signal to `SqlExecutor.query`, and the postgres.js adapter
sends `query.cancel()` when it aborts. postgres.js opens a second connection
for the cancel request and documents that, in a race, it can cancel a
different query on that backend; Mnemocyte accepts this and rejects the
caller with `"ABORTED"` either way. Because `consolidate` is one statement, a
cancel while it waits for a row lock stops it before anything is written; a
cancel that arrives after the statement finished has no effect. Other
queries are not cancelled.

## Known problems

Each one is a roadmap item in Phase 1 unless noted.

- Lexical candidates are scored with `ts_rank`, vector-only candidates with a
  substring scorer, so the two scales mix (see
  [retrieval.md](./retrieval.md)).
- Filters are applied after the HNSW scan and `hnsw.ef_search` stays at its
  default of 40, so filtered recall can return fewer matches than exist.
- `psql -f` without `-v ON_ERROR_STOP=1 --single-transaction` keeps going
  after an error and can leave a partial schema.
- `rememberMany` sends one `INSERT`; past about 2,900 rows it exceeds the
  65,535 bind-parameter limit.
- The vector query computes the cosine distance three times per row.
- Scopes exist in the schema but not in the public API: everything is in the
  `default` namespace with no agent or session until `feat/scoped-api`.
