# libSQL backend

Current behavior of the libSQL backend (`mnemocyte/libsql`, ARCHITECTURE
decisions 62 to 70). Known problems are listed at the end.

## Files

| File | What it holds |
|---|---|
| `src/libsql.ts` | The `mnemocyte/libsql` entry: `libsqlStore({ client })` and the client types. |
| `src/sql/detect.ts` | `detectLibsqlClient`, `LibsqlDriverClient`, `LibsqlClient`: shape checks only, in the root entry. |
| `src/memory/libsql.ts` | `createLibsqlStore`: the `MemoryStore`, error mapping, embedder checks. |
| `src/memory/libsql-backend.ts` | The dynamic `import()` target of `createMemory({ store: client })`. |
| `src/memory/duplicates.ts` | The exact duplicate search, shared with the in-memory store. |
| `src/db/libsql/executor.ts` | The adapter over the user's `@libsql/client`: `execute`, `batch`, `transaction`. |
| `src/db/libsql/sql.ts` | `?NNN` parameters, row conversion, `sqlUuidV7`, the blob vector format. |
| `src/db/libsql/queries.ts` | Every statement the store runs. |
| `src/db/libsql/migrations.ts` | The runner, `check`'s report, the tokenizer change. |
| `src/db/libsql/bundled.ts` | Generated from `migrations/libsql/` by `scripts/bundle-libsql-migrations.mjs`. |

## Clients

`detectLibsqlClient` accepts a value with the functions `execute`, `batch`,
`transaction` and `executeMultiple` and a string `protocol` (`"file"`,
`"http"`, `"ws"`), or an object whose `$client` is one, which is what
`drizzle-orm/libsql` sets (`db.$client = client` in its `driver-core.js`).
The methods sit on the client's prototype, so detection reads them with
`typeof`, not `Object.keys`. No Postgres client, and no Drizzle instance
itself, has `executeMultiple` and a string `protocol`, and no libSQL client
has `query` or `unsafe`, so `resolveStore` checks libSQL first without
affecting Postgres detection. A Drizzle libSQL instance
given to `postgresStore` still throws `"CONFIG"`, with a message that
names `libsqlStore`.

The root entry has no libSQL code: `resolveStore` returns a lazy store with
`backend: "libsql"` and `LIBSQL_CAPABILITIES`, and the backend loads with a
dynamic `import()` on the first call, as Postgres does
([postgres.md](./postgres.md#lazy-loading)). A package test checks that
`dist/index.mjs` reaches `libsql-backend-*.mjs` only through `import()`,
and that no built entry imports `@libsql/client`.

## Statements

- Placeholders are `?1`, `?2`, … (`createLibsqlParams`). SQLite binds
  `?NNN` by number, so a condition built once can appear several times in
  one statement; `$1` would be a named parameter numbered by first
  appearance.
- Timestamps are Unix milliseconds in `integer` columns, the precision of
  a `Date`. Audit positions print them with six fraction digits
  (`…123000Z`) as the store contract requires; `createdAfter` needs none of
  the Postgres store's rounding.
- `tags` and `metadata` are JSON text. A tag filter is one
  `EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)` per tag.
- Ids are lower-case UUID text. The store lower-cases ids it is given, and
  filters out values that are not UUIDs before sending them, as Postgres
  does. Audit events of a delete or prune get ids built in SQL
  (`sqlUuidV7`: the event's milliseconds, version 7, `randomblob`).
- Vectors are sent as `vector32(?)` over an `ArrayBuffer` of float32s, the
  `F32_BLOB` layout. JSON text was parsed again for every row a search
  compared: on 1,000 stored rows, 97 ms against 43 ms. Stored vectors are
  read back as blobs (`toEmbedding` checks four bytes per dimension);
  `vector_extract` took 1.5 ms per row at 1,536 dimensions.
- The client's `intMode` decides how integers come back (`number`,
  `bigint`, `string`); rows go through `Number()`.
- No aggregate `ORDER BY` (`json_group_array(x ORDER BY y)`, SQLite 3.44):
  the local engine runs it, but a libSQL server parses statements with its
  own parser and rejects it (`SQL_PARSE_ERROR`), found by the run on
  `sqld`. Ids are sorted in JavaScript, or the aggregate reads an ordered
  subquery where the SQL must keep the order (the restored ids in an audit
  payload, merged tags).

## Atomic writes

Every write that needs more than one statement is one
`client.batch(statements, "write")`, which is `BEGIN IMMEDIATE`: the write
lock is taken at the start, so no other writer runs between the
statements. SQLite has no data-modifying `WITH` and no `FOR UPDATE`, so a
write is shaped as:

1. a `SELECT` that reads what the write depends on (found, dependents,
   hidden dependents, the ids it will change);
2. the audit `INSERT`, reading the rows before they change;
3. the writes, each with the same check as a `WHERE` condition, so on a
   conflict every statement matches nothing.

The store reads the first statement's result and throws `"CONFLICT"` when
it says so; nothing was written. Keyed `add` uses `INSERT … ON CONFLICT`
on the unique expression index `(namespace, entity_id, ifnull(agent_id,
''), ifnull(session_id, ''), key) WHERE key IS NOT NULL`, the stand-in for
Postgres's `NULLS NOT DISTINCT`; scope fields are never empty, so `''`
cannot collide with a real value. Its audit statement runs first and finds
an existing key with a `LEFT JOIN`, to write `memory.updated` with the
existing id. `update` with audit is the `UPDATE` and an
`INSERT … SELECT` of the updated row with the same conditions.

No store method uses an interactive transaction. On a local file the
driver is synchronous: a batch runs to completion before the next call
starts, so concurrent writes from one client queue up. An interactive
transaction keeps the lock across `await`s, and another write that starts
meanwhile fails at once with `SQLITE_BUSY`; a busy timeout cannot help,
because waiting blocks the thread that holds the lock (9 of 10 concurrent
transactions failed in a probe, with or without `timeout`). Only `migrate`
uses one.

The foreign key on `superseded_by` is on by default in libSQL
(`PRAGMA foreign_keys` is 1); the guards above do not depend on it.

## Migrations

`migrations/libsql/0000_initial.sql.template` is migration `0000` and
always holds the final schema, with `{{EMBEDDING_DIMENSIONS}}` and
`{{FTS_TOKENIZE}}`. Later migrations will be `0001_name.sql` and up in the
same folder; the template must then change with them, as for Postgres.
`pnpm migration:bundle` runs both bundle scripts; a unit test compares
`bundled.ts` with the script's output. The folder does not ship: the SQL
reaches users only through `bundled.ts`.

Tables: `mnemocyte_memories` (a rowid table, `id text PRIMARY KEY`,
`embedding F32_BLOB(N)`), the FTS5 table `mnemocyte_memories_fts`
(external content on `rowid`, kept in sync by three triggers),
`mnemocyte_events` (with `memory_id`, a virtual generated column of
`json_extract(metadata, '$.memoryId')`, indexed with the timestamp), and
`mnemocyte_meta` (`vector_type` `F32_BLOB`). The btree indexes match the
Postgres ones by name and purpose; the FTS5 table takes the place of the
GIN index on `content_tsv`, and there is no vector index.

The runner (`runLibsqlMigrations`) takes one `transaction("write")`: it
reads the tracking table and the catalog, then installs or applies what is
missing, and records it. SQLite's schema changes are transactional, so a
failure leaves nothing. A concurrent `migrate` waits on, or fails with
`SQLITE_BUSY` against, the write lock. `dryRun` reads without a
transaction. There is no adoption: tables without rows in
`mnemocyte_migrations` throw `"MIGRATION"` (`SCHEMA_UNRECOGNIZED`).
`dimensions` is checked against `capabilities.maxDimensions` (65,536) in
`migrate()`, after the store is known.

`inspectInstallation` returns the Postgres report shape with
`pgvectorVersion: null` and `sqliteVersion` (`sqlite_version()`), which is
how `check` tells the backends apart.

## Search

Vector search is exact: `vector_distance_cos("embedding", ?)` over the rows
the recall filters select through `mnemocyte_memories_scope_idx`, ordered
by distance and id, `LIMIT` the candidate count. The capabilities say
`"exact"` and `"prefilter"` (decision 63).

Keyword search joins `mnemocyte_memories_fts` to the memories on `rowid`,
`MATCH`es the query from `ftsQuery`, applies the recall filters to the
joined rows and orders by `bm25()`; the score is `-bm25()`, positive for
every match. `ftsQuery` splits on whitespace, drops repeats, keeps 64
terms, doubles `"` and quotes each one as an FTS5 string, joined with `OR`
(decision 64). The `MATCH` runs over the whole index before the scope
filter, and `bm25`'s term statistics come from every scope.

The tokenizer is read from the FTS5 table's `CREATE` text in
`sqlite_master` (`tokenize='…'`), once per store before its first keyword
search; `porter` is `porter unicode61 remove_diacritics 2` and
`unicode61` is `unicode61 remove_diacritics 2`. `setTextSearchConfig` drops
the FTS5 table and its triggers, creates them with the new tokenizer and
runs `'rebuild'`, in one write batch.

## Duplicates

`findDuplicates` reads the candidates (the duplicate filters, with their
embeddings) and compares them in JavaScript with `memory/duplicates.ts`,
the in-memory store's exact algorithm: each vector is copied to a
`Float64Array` once, every pair's cosine is computed once in a pass over
the upper triangle, and each memory keeps its `neighbors` best (ties by
id). Pages compare their batch with every candidate and cache the
neighbor lists of the re-check. In SQL, `vector_distance_cos` between two
stored rows cost about 37 µs at 1,536 dimensions, so the self-join took
59 s for 1,000 memories; in JavaScript it took 4.4 s before computing
each pair once, and 1.2 s after.

## Measured

`pnpm bench:libsql` (`scripts/bench-libsql.mjs`) builds, then seeds one
entity of N memories next to another of the same size on a local file and
times each operation through `dist/`:

| Memories in the entity | `search` (keyword matches) | `search` (vector only) | same, `kinds` keeping a tenth | first `findDuplicatesPage` (100) | `findDuplicates` | seeding both entities |
|---|---|---|---|---|---|---|
| 1,000 | 79.6 ms | 53.3 ms | 20.5 ms | 383.6 ms | 1,218.8 ms | 1.6 s |
| 10,000 | 728.1 ms | 469.8 ms | 142.9 ms | 3,310.4 ms | 120,806.7 ms | 14.7 s |
| 50,000 | 3,221.5 ms | 1,802.5 ms | 641.9 ms | - | - | 65.8 s |

Node 24.22.1 on Windows x64 (8 cores), 1,536 dimensions, `@libsql/client`
0.18.0 (SQLite 3.45.1), the median of 20 searches with `limit` 10, on
2026-11-21. The vector-only search costs about 36 to 53 µs per memory of
the scope, most of it `vector_distance_cos` (about 43 µs per row against a
blob parameter in a probe). Ranking on `rowid`, `id` and the distance
before reading the other columns took the 10,000 row from 654 to about
470 ms.
Keyword matches add the FTS5 query, which here matched every memory.
`findDuplicates` grows with the square of the scope: 50 million pairs at
10,000.

## Errors

- `no such table` or `no such column` becomes `"MIGRATION"`
  (`SCHEMA_MISSING`) with the driver's text and a link to the guide.
- A unique violation on `mnemocyte_memories_scope_key_idx` in `update`
  becomes `"CONFLICT"` (`KEY_IN_USE`). The local driver reports
  `SQLITE_CONSTRAINT_UNIQUE`; the store matches the message, which both
  protocols carry.
- `SQLITE_BUSY` becomes `"DB"` with a message about the write lock.
- Everything else is `"DB"`, with the driver error as `cause`.

## Cancellation

`@libsql/client` takes no `AbortSignal`. The adapter checks the signal
before every call, so an aborted signal stops the next statement with
`"ABORTED"`; a statement already sent runs to the end.

## Tests

- `test/contract/libsql-store.test.ts`, `libsql-direct.test.ts` and
  `libsql-drizzle.test.ts` run the shared contract
  (`test/contract/shared.ts`) through `libsqlStore`, the client itself
  and Drizzle, each on a database file of its own under the folder
  `test/contract/libsql.global-setup.ts` creates. Windows keeps a file
  locked for a while after `client.close()` (removing it took up to 16 s),
  so the folder goes when the run ends.
- `test/contract/libsql-fixtures.test.ts`: the shared fixtures the
  Postgres side runs in `integration` (consolidation policies and races,
  access tracking, prune audit, input snapshots and validation, metadata
  traversals, the insert contract), on libSQL.
- `test/contract/libsql-behavior.test.ts`: migrations, tokenizers,
  query quoting, the FTS5 triggers, audit ids, capabilities, abort.
- `test/contract/cli-libsql.test.ts`: `migrate`, `check`, `text-search`
  and `--schema` with a libSQL memory target.
- `test/libsql/libsql-unit.test.ts`: `ftsQuery`, detection, the bundle,
  rendering.
- `test/package/libsql.test.ts`: the packed package with `@libsql/client`
  linked in, through ESM and `require()`.
- `test/integration/libsql-remote.test.ts`: the shared contract on a
  libSQL server at `LIBSQL_URL`; skipped without it. CI runs it in the
  `libSQL server integration` job on
  `ghcr.io/tursodatabase/libsql-server:d6c75af`, pinned by digest
  (decision 71; how to bump the pin is in
  [DEVELOPMENT.md](../DEVELOPMENT.md#what-ci-runs)). By hand, with the same
  image (the server answers `GET /health` once it is up):

  ```bash
  docker run -d --name mnemocyte-sqld-test -p 8089:8080 -e SQLD_NODE=primary ghcr.io/tursodatabase/libsql-server:d6c75af@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67
  curl --fail --retry 30 --retry-all-errors --retry-delay 1 http://127.0.0.1:8089/health
  LIBSQL_URL=http://127.0.0.1:8089 pnpm test:integration:libsql
  docker rm -f mnemocyte-sqld-test
  ```

## Known problems

- No vector index. A DiskANN index (`libsql_vector_idx`, `vector_top_k`)
  ranks the whole table before the scope filter, so it would leave most
  scopes of a shared table with no results; it waits in ROADMAP.md
  ("Later") for a single-scope workload that the exact scan is too slow
  for.
- The CLI reaches libSQL only through a memory file (`DATABASE_URL` is
  postgres.js), and `--dimensions` stops at 4,000.
