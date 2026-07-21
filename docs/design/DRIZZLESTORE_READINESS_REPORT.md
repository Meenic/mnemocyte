# `drizzleStore(db)` Readiness Discovery Report

This report records current repository behavior relevant to the planned
`drizzleStore(db)` milestone. It is discovery only: it does not define an API,
select a compatibility strategy, or recommend an implementation.

The source snapshot inspected is commit
`c2d3f9a2b39df53988efe3fd04899294952605bc` (2026-07-21). The package is
`mnemocyte@0.4.0`; `pnpm-lock.yaml` resolves `drizzle-orm@0.45.2` and
`postgres@3.4.9`. The working tree was clean before this report was added.

## Findings at a glance

| Area | Groundwork already present | Boundary not present in current code |
| --- | --- | --- |
| Postgres store separation | `createPostgresStore()` receives a `DatabaseHandle` and does not parse URLs or construct connections itself. | `DatabaseHandle.db` and every query helper are typed specifically as `PostgresJsDatabase<typeof schema>`. |
| Lifecycle | Shared client close is idempotent, drains admitted operations, and delegates resource disposal to `MemoryStore.close()`. | The only real Postgres handle always owns and ends its postgres.js client; no real caller-owned connection path is tested. |
| Schema | Migrations, dimension rendering, and compatibility failures are explicit. | Runtime code neither applies nor verifies the base schema in `ensureSchema()`; Mnemocyte tables are fixed in the default/`public` schema namespace. |
| Transactions | Consolidation is already isolated in one Drizzle transaction callback and performs no embedding call inside it. | Driver parity is not established. Neon HTTP in the locked Drizzle release rejects transaction callbacks at runtime, and several non-transactional query paths bypass Drizzle through postgres.js. |
| Tests | CI already supplies PostgreSQL 17 with pgvector, applies migrations, and exercises the complete URL-backed behavior. | No test constructs a Drizzle instance and gives that instance to Mnemocyte; no alternate Drizzle driver is installed or exercised. |

## 1. Current Postgres adapter internal structure

### 1.1 Construction of the current Drizzle instance

The current public Postgres path is a fixed chain:

1. `createMnemocyte()` accepts only `databaseUrl` as its database input. It
   validates that URL synchronously and creates a lazy Postgres store
   (`src/client.ts:39-50`, `src/database-url.ts:3-19`).
2. The first store method dynamically imports `postgres-runtime.ts`. Even
   `close()` loads the store if no earlier operation did
   (`src/memory/lazy-postgres.ts:3-12,71-73`).
3. `createPostgresStoreFromUrl()` calls `createDatabase(databaseUrl)` and hands
   its result to `createPostgresStore()`
   (`src/memory/postgres-runtime.ts:1-7`).
4. `createDatabase()` constructs a postgres.js client, wraps it with
   `drizzle(client, { schema })`, and returns `{ db, close }`
   (`src/db/index.ts:41-61`).

The concrete connection settings in `src/db/index.ts:18-55` are:

| Setting | Current source of value |
| --- | --- |
| Driver | Hardcoded to the `postgres` npm package (postgres.js). |
| Drizzle adapter | Hardcoded import from `drizzle-orm/postgres-js`. |
| Pool maximum | Hardcoded `max: 10`. |
| Idle timeout | Hardcoded `idle_timeout: 20`. |
| Connect timeout | Hardcoded `connect_timeout: 10`. |
| SSL | Derived only from the URL's `sslmode`. `disable` or absence supplies no explicit `ssl`; `require`, `prefer`, and `allow` become `{ rejectUnauthorized: false }`; `verify-full` is passed through. Other values add no explicit option. |
| Prepared statements | Disabled with `prepare: false` only when the URL port is `6543` or `pgbouncer=true` is present. |
| Drizzle schema map | Hardcoded to all exports from `src/db/schema.ts`. |
| Shutdown | Hardcoded to `await client.end()`. |

The public `MnemocyteConfig` exposes none of the pool, timeout, SSL, prepared
statement, driver, or schema-map choices separately; only the connection URL is
configurable (`src/types.ts:177-190`).

### 1.2 What is independent of instance construction

`createPostgresStore(handle)` does not read a URL, inspect pool settings, or
construct a driver. All operational methods receive the already-created
`handle.db`, and connection creation is confined to `src/db/index.ts`
(`src/memory/postgres.ts:201-601`). Within the current postgres.js database
shape, this separates most store behavior from where that database instance
came from.

The following query paths use Drizzle's PostgreSQL query builders and imported
table objects directly rather than postgres.js connection methods:

- installation metadata reads and updates in `src/db/queries/meta.ts`;
- inserts, entity/ID lookup, statistics, access updates, embedding lookup, and
  consolidation reads/writes in `src/db/queries/memories.ts`;
- ordinary audit inserts in `src/db/queries/events.ts`;
- the row-to-domain mapping, compatibility checks, prune-filter mapping, audit
  mapping, error wrapping, and `MemoryStore` orchestration in
  `src/memory/postgres.ts` and `src/memory/postgres-records.ts`.

Those paths do not use Drizzle's relational `db.query` property. They pass
`memoriesTable`, `eventsTable`, and `metaTable` directly to `select`, `insert`,
or `update`, so their SQL construction does not look up tables through the
schema map registered when `drizzle()` was called.

This construction independence has three current limits:

1. **The type boundary is postgres.js-specific.** `MnemocyteDatabase` is an
   alias for `PostgresJsDatabase<typeof schema>`, `DatabaseHandle.db` uses that
   alias, and every query helper accepts it (`src/db/index.ts:1-10`; imports in
   `src/db/queries/*.ts`). There is no generic PostgreSQL Drizzle database type
   or alternate-driver union in the repository.
2. **Some raw-query paths assume postgres.js results.** `vectorSearch()` and
   `lexicalSearch()` call `db.execute(...)`, cast the direct return value to an
   array, and the store immediately calls `.map()` on it
   (`src/db/queries/memories.ts:664-761`; `src/memory/postgres.ts:306-327`).
   That matches the locked postgres.js Drizzle result type, which is a
   `RowList`; the locked node-postgres and Neon drivers type raw execution as a
   result object containing `rows`.
3. **Maintenance and audit reads bypass the Drizzle session.** Counts, guarded
   deletes (including `forget`, `forgetAll`, and non-dry prune), duplicate
   search, and audit-list queries all call `executeCancelableSql()`
   (`src/db/queries/memories.ts:275-518`; `src/db/queries/events.ts:30-66`).
   That helper obtains `db.$client`, treats it as postgres.js `Sql`, calls
   `$client.unsafe(...)`, and calls `.cancel()` on the returned query
   (`src/db/cancellation.ts:1-59`). It requires those postgres.js methods even
   when no `AbortSignal` is supplied.

Connection ownership itself appears in only one store operation: Postgres
`close()` delegates to `handle.close()` (`src/memory/postgres.ts:590-592`). No
read, write, compatibility, or transaction method calls `end()` or otherwise
manages the pool.

### 1.3 Schema and database coexistence

`src/db/schema.ts` declares three tables:

- `mnemocyte_memories`;
- `mnemocyte_events`;
- `mnemocyte_meta`.

It also declares four indexes whose names start with `mnemocyte_` and a
self-referencing memory foreign key. The source uses `pgTable`, not
`pgSchema(...).table(...)` (`src/db/schema.ts:33-96`). The SQL migrations create
the tables and indexes with unqualified names; the memory foreign key is the
one explicitly schema-qualified reference, and it points to
`public.mnemocyte_memories` (`migrations/0000_initial.sql:1-35`,
`migrations/0000_initial.sql.template:1-43`).

Consequently, the migration does not claim or modify an entire database. It
creates only Mnemocyte's named tables, indexes, and constraint, and it does not
drop or alter unrelated application tables. It can coexist with unrelated
tables in the same database.

The names have a `mnemocyte_` prefix, but they are not isolated in a dedicated
PostgreSQL schema. The table, index, and constraint names are fixed and not
configurable. The migration uses `CREATE TABLE`, `CREATE INDEX`, and
`ADD CONSTRAINT` without `IF NOT EXISTS`; an existing object with the same name
therefore collides rather than being adopted. The explicit `public` foreign-key
target also makes the generated migration assume that the memories table is in
`public`, even though its `CREATE TABLE` statement itself is unqualified.

The bundled SQL does not create the `vector` extension. Documentation and CI
treat pgvector enablement as a separate database prerequisite
(`README.md:113-126`; `.github/workflows/ci.yml:53-88`).

## 2. Connection lifecycle ownership: current mechanics

### 2.1 What `close()` does today

The shared client owns admission and close coordination independently of the
backend. On the first `client.close()` call it:

- changes client state to `closing`, which rejects newly admitted operations;
- waits for already-admitted operations to drain;
- calls `store.close()`;
- marks the Mnemocyte client closed on success;
- reopens admission and clears the cached close promise if store close fails;
- returns the same promise for concurrent or later successful close calls.

This is implemented in `src/memory/client-core.ts:244-323,835-853` and covered
by `test/lifecycle/close.test.ts:117-220`.

For the current URL-backed path, delegation continues as follows:

`client.close()` -> lazy store `loadStore()` -> Postgres store `handle.close()`
-> postgres.js `client.end()` (`src/memory/lazy-postgres.ts:71-73`,
`src/memory/postgres.ts:590-592`, `src/db/index.ts:56-61`). The Drizzle object
is not itself closed; the underlying postgres.js client created alongside it is
ended.

The documented `MemoryStore.close()` contract limits disposal to store-owned
resources and explicitly says that a store wrapping a caller-supplied
connection must not close it (`src/memory/store.ts:315-325`; `README.md:565-570`).
Applied to the current mechanics, a caller-owned store close cannot invoke the
supplied Drizzle instance's underlying client/pool shutdown method. Shared core
would still close the Mnemocyte client logically and reject its later
operations; the caller's database resource would remain outside that disposal
chain. No current Postgres implementation exercises that combination.

### 2.2 No other automatic shutdown path

A source-wide search finds only two production shutdown calls:

- `handle.close()` in `src/memory/postgres.ts:590-592`;
- `client.end()` inside the URL-created handle in `src/db/index.ts:58-60`.

There are no `process.on`/`process.once` exit handlers, signal handlers,
unhandled-rejection handlers, uncaught-exception handlers, or error paths that
close the Postgres resource. Operational errors are normalized and rethrown;
they do not trigger connection disposal (`src/memory/postgres.ts:76-140`).

## 3. Schema and migration handling for a supplied instance

### 3.1 The built-in path expects pre-applied migrations

No production source imports a Drizzle migrator or executes migration SQL.
`createMnemocyte()`, `createDatabase()`, and `createPostgresStore()` do not
create extensions, tables, indexes, constraints, or migration bookkeeping.
The repository instead provides:

- `migrations/0000_initial.sql`, `0001_add_mnemocyte_meta.sql`, and
  `0002_add_embedding_model.sql` for the default migration sequence;
- `migrations/0000_initial.sql.template` plus
  `migrations/render-initial.mjs` for a custom-dimension fresh install;
- manual development commands `db:generate`, `db:migrate`, and
  `migration:render` in `package.json:49-53`;
- operator instructions to enable pgvector and apply the appropriate SQL before
  constructing the client (`README.md:113-168`).

The default sequence creates memories/events first, adds the metadata table,
then adds and backfills `mnemocyte_meta.embedding_model`. The rendered custom
initial migration creates all three current tables in one file and substitutes
the requested vector dimension
(`migrations/0000_initial.sql.template:1-43`,
`migrations/render-initial.mjs:1-35`).

### 3.2 What happens against a database without Mnemocyte's schema

`MemoryStore.ensureSchema()` is a readiness hook whose contract permits
verification but explicitly does not authorize hidden schema creation or
migration (`src/memory/store.ts:142-152`). Both built-in stores currently
implement it as a no-op; the Postgres implementation is the empty method at
`src/memory/postgres.ts:295`.

The absence of schema is therefore detected by the first real query, not by
construction or `ensureSchema()`:

- Embedding-dependent operations call `ensureEmbeddingCompatibility()` first.
  A missing `mnemocyte_meta` table or column is converted to a `MIGRATION`
  error with explicit migration guidance
  (`src/memory/postgres.ts:205-250`).
- Non-embedding operations call the no-op `ensureSchema()` and then issue their
  normal query. Undefined-table, undefined-column/type/function failures in the
  configured migration-error set are normalized to `MIGRATION`
  (`src/memory/postgres.ts:65-140`; calls in
  `src/memory/client-core.ts:590-765`).
- Closing an otherwise unused lazy URL-backed client does not query schema; it
  creates and ends the postgres.js client only
  (`test/lifecycle/close.test.ts:61-82`).

The compatibility hook can record the configured embedding model when the
installation row exists but its model is null
(`src/memory/postgres.ts:252-289`, `src/db/queries/meta.ts:26-43`). That is a
conditional data update inside an already-migrated schema, not schema creation
or migration.

Supplying a Drizzle instance does not change any of these current query or hook
behaviors. The existing contract and Postgres implementation assume that
schema management remains external; the current no-op `ensureSchema()` neither
installs nor proactively verifies the base schema.

## 4. Transaction API compatibility

### 4.1 Transactions used by the current adapter

`consolidate()` is the only store method that calls
`handle.db.transaction(...)` (`src/memory/postgres.ts:477-571`). Inside that
callback it:

1. selects and locks the survivor and requested losers in ID order with
   `FOR UPDATE`;
2. validates the protected rows;
3. updates active losers;
4. inserts enabled audit events;
5. optionally updates survivor tags;
6. checks cancellation between statements and before the callback returns.

No embedder or other external provider is called inside the transaction. The
preflight read performed by shared client orchestration occurs before this
transaction, while the correctness-critical rows are re-read and locked inside
it (`src/memory/client-core.ts:731-828`, `src/memory/postgres.ts:489-566`).

Guarded deletion and prune do not open Drizzle transactions. Their atomicity is
implemented as one PostgreSQL CTE statement
(`src/db/queries/memories.ts:302-385`). Ordinary multi-event audit writes loop
over independent inserts and are intentionally not batch-atomic; consolidation
audit inserts are transaction-coupled because they run on the transaction
object (`src/memory/postgres.ts:429-441,525-539`).

### 4.2 The callback shape is shared, but behavior is not identical

The locked Drizzle release defines `transaction(callback, config?)` on its
shared PostgreSQL `PgDatabase` base. Its postgres.js, node-postgres, and Neon
serverless sessions implement callback transactions. In the same locked
release, Neon HTTP exposes the inherited method in its TypeScript surface but
its implementation throws `No transactions support in neon-http driver`.
This is visible in the installed `drizzle-orm@0.45.2` sources:

- `node_modules/drizzle-orm/pg-core/db.d.ts` and
  `pg-core/session.d.ts` for the common method;
- `node_modules/drizzle-orm/postgres-js/session.d.ts`;
- `node_modules/drizzle-orm/node-postgres/session.d.ts`;
- `node_modules/drizzle-orm/neon-serverless/session.d.ts`;
- `node_modules/drizzle-orm/neon-http/session.js:151-158` for the runtime
  rejection.

Thus the syntax used by consolidation is not unique to postgres.js, but it does
not work identically across the roadmap's named driver families. In particular,
the current consolidation implementation cannot complete on the locked Neon
HTTP driver because its atomic boundary depends on a callback transaction.

Even where a driver implements the same transaction callback, the complete
current store is not driver-neutral:

| Current assumption | Evidence and effect |
| --- | --- |
| Exact database type | `MnemocyteDatabase` is `PostgresJsDatabase<typeof schema>` (`src/db/index.ts:1-10`). Alternate Drizzle database and transaction types are not represented. |
| Active cancellation | `executeCancelableSql()` compiles a Drizzle `SQL` with `PgDialect`, then requires postgres.js `$client.unsafe()` and query `.cancel()` (`src/db/cancellation.ts:1-59`). |
| Raw execution result | Vector and lexical search treat `db.execute()` as an array. Drizzle 0.45.2's postgres.js result is an array-like `RowList`; node-postgres, Neon serverless, and Neon HTTP declarations return result objects with a `rows` property. |
| Error object fields | Migration/deletion normalization reads SQLSTATE from `error.code` and the protected foreign-key name from postgres.js's `error.constraint_name` field (`src/memory/postgres.ts:76-130`; `node_modules/postgres/types/index.d.ts:193-225`). No alternate-driver error mapping is present or tested. |
| Connection options and close | Pool creation, pooler detection, SSL mapping, prepared-statement behavior, and `client.end()` are postgres.js operations in `src/db/index.ts`. |
| Installed drivers | Root dependencies contain only `drizzle-orm` and `postgres`; neither `pg` nor `@neondatabase/serverless` is a package dependency (`package.json:80-84`). |

PostgreSQL-specific SQL is another fixed boundary independent of JavaScript
driver choice: the query layer uses pgvector operators and casts, PostgreSQL
arrays, full-text functions, CTE materialization, tuple comparison, `RETURNING`,
and `FOR UPDATE` (`src/db/queries/memories.ts`,
`src/db/queries/events.ts`). That matches the roadmap's current
Postgres-plus-pgvector scope, but it is not evidence of compatibility with each
Drizzle PostgreSQL transport.

No test in the repository exercises consolidation, raw execution, cancellation,
or error normalization through node-postgres, Neon serverless, or Neon HTTP.

## 5. Existing test infrastructure reusability

### 5.1 How integration tests construct and manage connections

The Vitest `integration` project runs `test/integration/**/*.test.ts` serially
with a 60-second default timeout (`vitest.config.ts:37-51`). Every integration
file loads `DATABASE_URL` from the process or `.env` and skips when it is
absent.

The common, currently duplicated pattern is:

1. construct an administrative postgres.js client, normally with
   `postgres(databaseUrl, { max: 1 })`;
2. read migration files from `migrations/` and execute them with
   `sql.unsafe(...)`, ignoring expected duplicate-table/column errors;
3. create unique entity IDs or prefixes and clean only those rows;
4. construct the Mnemocyte client with `createMnemocyte({ databaseUrl, ... })`;
5. close the Mnemocyte client, clean test rows through the administrative
   client, and call `sql.end()` on the administrative client.

`test/integration/postgres.test.ts:38-107,383-400` is the fullest example.
Similar local migration helpers appear in every integration file; there is no
shared Postgres setup fixture under `test/helpers.ts`. The cancellation suite
adds separate postgres.js admin, lock-holder, and observer clients
(`test/integration/cancellation.test.ts:168-287`).

GitHub Actions supplies one `pgvector/pgvector:pg17` TCP service, enables the
`vector` extension with `psql`, and runs `pnpm run test:integration` with a
postgres URL (`.github/workflows/ci.yml:47-92`). It does not supply a Neon HTTP
endpoint, a serverless/WebSocket proxy, or an alternate driver matrix.

### 5.2 What the current harness can and cannot cover

For a caller-supplied postgres.js Drizzle instance, the existing PostgreSQL
service, pgvector enablement, migration files, deterministic embedders, unique
entity isolation, cleanup SQL, and behavioral fixtures are directly applicable.
That scenario does not require a different database server from the one CI
already starts. What is absent is test wiring that constructs
`drizzle(postgresClient, ...)`, gives that database object to Mnemocyte, and
checks that the same underlying client remains usable after Mnemocyte closes.

Alternate-driver coverage is not present in the harness. The root does not
install the node-postgres or Neon client packages, and CI provides none of the
Neon-specific transport services or configuration. The current cancellation
tests also deliberately depend on postgres.js cancellation behavior rather
than a driver-neutral test seam.

### 5.3 Existing partial seams are not caller-supplied-instance coverage

There are three nearby forms of coverage, but none passes someone else's real
Drizzle instance to Mnemocyte:

- `test/integration/consolidation-survivor-race.test.ts:71` calls
  `createPostgresStore(createDatabase(url))` directly. That bypasses the public
  factory, but `createDatabase()` still constructs and owns the postgres.js
  connection exactly as the normal URL path does.
- `test/postgres/metadata-validation.test.ts` and
  `test/postgres/prune-validation.test.ts` pass fake `DatabaseHandle` objects to
  internal Postgres constructors. Their `db` values are hand-written objects
  cast to `MnemocyteDatabase`, not Drizzle instances, and their `close()`
  methods are empty.
- `test/lifecycle/close.test.ts` injects wrapped in-memory stores to verify
  draining, idempotency, and close retry. It establishes shared lifecycle
  behavior but does not prove that a database supplied by a caller remains
  usable.

A repository-wide test search contains no `drizzle(...)` construction and no
import from a Drizzle driver. The administrative postgres.js clients in
integration tests remain usable after `client.close()`, but they are separate
connections; they do not establish ownership behavior for the connection that
Mnemocyte used.

## Evidence-only readiness conclusion

The repository already has a meaningful separation between shared memory
orchestration, the Postgres `MemoryStore`, query modules, and URL-based
connection construction. Lifecycle coordination is centralized, schema setup
is explicit, and most ordinary CRUD and consolidation statements use shared
Drizzle PostgreSQL query-builder APIs.

The current implementation does not yet establish a general caller-supplied
Drizzle boundary. Its only real handle owns a postgres.js client; its database
types, cancellation path, raw result handling, connection options, shutdown,
and some error-field assumptions are postgres.js-specific. Neon HTTP also
lacks the transaction behavior required by current consolidation in the locked
Drizzle release. Existing Postgres infrastructure can exercise a supplied
postgres.js instance, but the repository contains no such test and no
alternate-driver infrastructure or coverage.
