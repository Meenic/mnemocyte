# Postgres backend

Current behavior of the Postgres + pgvector backend. Known problems are listed
at the end with the roadmap item that fixes each one.

## Schema

Three tables, all unqualified in queries (they resolve through `search_path`;
the foreign key alone names `public`):

| Table | Purpose |
|---|---|
| `mnemocyte_memories` | One row per memory: `id` (text PK), `entity_id`, `content`, `type`, `importance`, `tags text[]`, `source`, `metadata jsonb`, `confidence real`, `embedding vector(N)` (nullable), `embedding_model`, `embedding_dimensions`, `superseded_by` (self FK, `ON DELETE NO ACTION`), `superseded_at`, `expires_at`, `last_accessed_at`, `access_count`, `created_at`, `updated_at`. |
| `mnemocyte_events` | Audit log: `id`, `entity_id`, `description`, `metadata jsonb`, `timestamp`. |
| `mnemocyte_meta` | One row, key `installation`: `embedding_dimensions` and `embedding_model` for the whole installation. |

Indexes: btree `(entity_id)` and `(entity_id, type)` on memories, btree
`(entity_id, timestamp)` on events, and HNSW on `embedding vector_cosine_ops`.
There is no full-text, tag or `superseded_by` index.

`type` and `importance` are plain `text` with no `CHECK` constraint; the
library validates them before writing.

## Migrations

pgvector is a prerequisite: no migration runs `CREATE EXTENSION`. Files in
`migrations/`:

| File | What it does |
|---|---|
| `0000_initial.sql` | Creates memories and events tables, the self FK and the four indexes, with `vector(1536)`. |
| `0001_add_mnemocyte_meta.sql` | Creates `mnemocyte_meta(key, embedding_dimensions)` and inserts `('installation', 1536)`. |
| `0002_add_embedding_model.sql` | Adds `mnemocyte_meta.embedding_model` and backfills it when the stored memories use exactly one model. |
| `fresh-install.sql` | The final schema of `0000`→`0002` in one file, rendered at 1536 dimensions. Only for an empty database. |
| `0000_initial.sql.template` | The same final schema with `{{EMBEDDING_DIMENSIONS}}`. |
| `render-initial.mjs` | `--dimensions N [--out file]`: renders the template. |
| `meta/` | Drizzle journal and snapshots for `0000`→`0002`. |

Install paths:

- New database, 1536 dimensions: apply `fresh-install.sql`.
- New database, other dimensions: render the template and apply the result.
  It already contains the effects of `0001` and `0002`.
- Existing 0.1.x database: apply `0001`, then `0002`.
- Existing 0.2.x or 0.3.x database: apply `0002`.
- Inside this repository, `pnpm db:migrate` runs `drizzle-kit migrate` over
  the journal (`0000`→`0002`), reading `DATABASE_URL` or `.env`.

`fresh-install.sql` is generated from the template; a unit test fails if the
two drift, and an integration test compares its resulting schema with the
`0000`→`0002` sequence. Nothing records which files were applied outside
Drizzle's own journal.

To change the schema: edit `src/db/schema.ts`, run `pnpm db:generate`, review
the SQL, update the template and re-render `fresh-install.sql` with
`pnpm migration:render`.

## Installation metadata

`mnemocyte_meta` is the source of truth for the vector space. Before `remember`,
`rememberMany`, `recall`, `buildContext` and `findDuplicates`, the store reads
it and:

- rejects with `"MIGRATION"` when the table or row is missing;
- rejects with `"CONFIG"` when `embedder.dimensions` differs;
- when `embedding_model` is null, records the single model found in stored
  rows, or the configured model for an empty table, with a conditional
  `UPDATE … WHERE embedding_model IS NULL` so concurrent first writers agree;
  rejects with `"MIGRATION"` when stored rows hold more than one model;
- rejects with `"CONFIG"` when `embedder.model` differs from the recorded one.

The result is cached per store instance after the first success. `forget`,
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

All queries are plain SQL strings built in `src/db/queries/`. Values are
always parameters, never interpolated. Three type rules keep the SQL
independent of driver-level parsers (Drizzle installs its own on a shared
client):

- Timestamps are sent as ISO strings with `::timestamptz` and read as `Date`
  or string, then normalized.
- `jsonb` is sent as text with `::text::jsonb` and read back with `::text`,
  then parsed, so no driver serializer wraps it twice.
- Vectors travel as text (`'[…]'::vector`, `embedding::text`).

`tags` are written as one JSON parameter turned into a `text[]` in input
order, so the number of bind parameters does not grow with the tag count.

## Errors

- SQLSTATE `42P01`, `42703`, `42704`, `42883` (missing table, column, object,
  function) become `"MIGRATION"`.
- A `23503` foreign-key violation on the `superseded_by` constraint during a
  delete becomes `"CONFLICT"`.
- Everything else becomes `"DB"` with the driver error as `cause`.

## Cancellation

`prune`, `findDuplicates` and `listAuditLog` pass their signal to
`SqlExecutor.query`, and the postgres.js adapter sends `query.cancel()` when it
aborts. postgres.js opens a second connection for the cancel request and
documents that, in a race, it can cancel a different query on that backend;
Mnemocyte accepts this and rejects the caller with `"ABORTED"` either way.
`consolidate` checks the signal between statements
inside its transaction; a statement already running finishes first, and an
abort during commit may still commit. Other queries are not cancelled.

## Known problems

Each one is a roadmap item in Phase 1 unless noted.

- Lexical candidates are scored with `ts_rank`, vector-only candidates with a
  substring scorer, so the two scales mix (see
  [retrieval.md](./retrieval.md)).
- Filters are applied after the HNSW scan and `hnsw.ef_search` stays at its
  default of 40, so filtered recall can return fewer matches than exist.
- `vector` HNSW indexes support at most 2,000 dimensions; rendering the
  template above that produces a migration that fails at `CREATE INDEX`.
- `superseded_by` has no index, so every deleted row makes the foreign-key
  check scan the table.
- `psql -f` without `-v ON_ERROR_STOP=1 --single-transaction` keeps going
  after an error and can leave a partial schema.
- `rememberMany` sends one `INSERT`; past about 3,400 rows it exceeds the
  65,535 bind-parameter limit.
- The compatibility cache is per store, not per embedder, so two clients with
  different models sharing one `drizzleStore(db)` value skip the second check.
- Lexical search computes `to_tsvector` per row on every query.
- `getMemoryEmbeddings` and `markMemoriesAccessed` filter by id only, not by
  entity. The ids always come from entity-scoped results, so nothing leaks
  today.
- The vector query computes the cosine distance three times per row.
