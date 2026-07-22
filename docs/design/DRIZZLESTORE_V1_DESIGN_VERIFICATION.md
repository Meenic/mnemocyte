# `drizzleStore(db)` v1 Design Verification

Status: verified against repository `HEAD`
`7d81087fd9a5821d00679f1b7dd06e6ce27d057d` and the working-tree proposal
`docs/design/drizzlestore-v1-design.md` on 2026-07-21.

This report verifies the proposal against current source, declarations, tests,
package configuration, and Git history. It does not revise the proposal or
define a replacement design.

## Final assessment

The proposed postgres.js-only, caller-supplied Drizzle scope is consistent with
current source. The store boundary can use a caller-owned postgres.js Drizzle
instance without changing Postgres operation logic, connection ownership is
centralized, schema management is already external, and the claimed integration
test gap still exists.

Four statements need correction before the proposal is treated as an exact
implementation specification:

1. `PostgresJsDatabase<typeof schema>` does not require *exactly* Mnemocyte's
   schema map: a structural superset is accepted. It does reject a caller-only
   schema that lacks Mnemocyte's keys. The installed Drizzle declarations also
   provide a source-compatible looser boundary,
   `PostgresJsDatabase<Record<string, unknown>>`, so callers do not need to
   import and merge Mnemocyte's schema merely to satisfy the type system.
2. A caller-supplied `DatabaseHandle` cannot simply omit `close()` under the
   current interface. `close()` is required and called unconditionally. An
   ownership-aware required callback, including a no-op callback for a
   caller-owned handle, is sufficient; literal omission would require changing
   the interface and its caller.
3. The existing OpenAI subpath demonstrates export/build packaging, but not
   peer-dependency packaging. `drizzle-orm` and `postgres` are current direct
   dependencies, and npm peer dependencies belong to the whole package rather
   than one export subpath.
4. The proposal's documentation inventory is incomplete after the JSDoc pass.
   Several current public comments say that omitting `databaseUrl` selects
   in-memory storage and that the returned client owns its Postgres resources.
   Those statements would become inaccurate for a caller-owned store path.

No production source changed after the readiness report's inspected snapshot:
`git diff --name-only c2d3f9a..HEAD` contains only
`docs/design/DRIZZLESTORE_READINESS_REPORT.md`. Consequently,
`CONSOLIDATION-02`, `CONSOLIDATION-03`, the `MemoryStore` contract comments,
and the public JSDoc pass were already present in the source verified by this
report.

## 1. The three previously undetermined questions

### 1.1 Exact `MnemocyteConfig` shape and validation order

#### Confirmed accurate

The exact current shape at `src/types.ts:181-219` is:

```ts
export interface MnemocyteConfig {
  databaseUrl?: string;
  embedder: Embedder;
  defaults?: {
    limit?: number;
    minScore?: number;
  };
  retrieval?: RetrievalConfig;
  observability?: ObservabilityConfig;
  provider?: ProviderResilienceConfig;
  audit?: AuditConfig;
}
```

There is no current `store`, database-handle, adapter, or other public storage
extension point. `MemoryStore` remains internal and is not exported from the
root (`src/memory/store.ts:105-325`, `src/index.ts:40-82`). The proposed
`createMnemocyte({ store: drizzleStore(db), embedder })` call therefore needs a
new config field or an equivalent new public factory input; `drizzleStore(db)`
cannot fit an existing public extension point.

Current synchronous validation and selection in `src/client.ts:40-52` is
strictly ordered as follows:

1. `assertEmbedder(config.embedder)`;
2. `validateRetrievalConfig(config.retrieval)`;
3. `validateProviderResilienceConfig(config.provider)`;
4. when `databaseUrl !== undefined`, reject an empty value, parse it, and
   reject malformed or non-Postgres protocols;
5. select the lazy Postgres store when `databaseUrl` exists, otherwise select
   the in-memory store.

This is the timing covered by `test/config/client-config.test.ts:47-110` and by
the packed-consumer synchronous URL assertion in
`test/package/lazy-postgres.test.ts:89-110`.

Adding an optional `store` property is additive to the TypeScript interface.
Supporting it requires extending the backend-selection branch, but it does not
require reordering the existing synchronous embedder, retrieval, provider, or
URL validation. Those calls can remain in their current order before store
selection, preserving the `ERR-02` / `CONFIG-02` timing.

#### Needs correction

The readiness report's `src/types.ts:177-190` citation covered only the start of
the interface and the `databaseUrl` field, not the exact full config shape. Its
narrow factual claim - that `databaseUrl` is the only current database input -
remains correct.

The proposal treats the existence of a compatible current extension point as
open. Source settles that question: no such public extension point exists.

#### Genuinely undetermined

Current source cannot decide:

- the public type used for the new `store` value while `MemoryStore` is still
  internal;
- whether supplying both `databaseUrl` and `store` rejects or has a defined
  precedence; or
- the error code and exact position in synchronous validation for that new
  conflict or for a malformed store value.

Those are API-policy decisions. They do not force existing validation to move.

### 1.2 Exhaustiveness of connection construction and ownership search

#### Confirmed accurate

The readiness report's production ownership search was exhaustive.

There is one production connection constructor:

- `src/db/index.ts:41-61` calls `postgres(databaseUrl, options)`, calls
  `drizzle(client, { schema })`, and closes the same client with
  `client.end()`.

There is one assembly chain leading to it:

- `src/client.ts:44-50` creates the lazy URL-backed store;
- `src/memory/lazy-postgres.ts:6-12` dynamically imports the runtime;
- `src/memory/postgres-runtime.ts:5-7` calls
  `createPostgresStore(createDatabase(databaseUrl))`.

There is one production teardown chain:

- `src/memory/client-core.ts:835-851` waits for admitted operations and calls
  `store.close()`;
- `src/memory/lazy-postgres.ts:71-73` loads and delegates to the real store;
- `src/memory/postgres.ts:590-592` calls `handle.close()`;
- `src/db/index.ts:58-60` calls `client.end()`.

Closing an otherwise unused URL-backed lazy client still enters this same
chain: it constructs the URL-owned handle and then ends it. That behavior is
already covered by the report and `test/lifecycle/close.test.ts:61-82`; it is
not a second constructor or owner.

A production-wide search found no other `postgres(...)`, `drizzle(...)`,
`client.end()`, pool construction, process/signal shutdown hook, or resource
disposal call. `src/db/cancellation.ts:11-39` can call `.cancel()` on one
postgres.js query promise, but that is statement cancellation, not connection
or pool teardown. It does not create, end, release, or otherwise take ownership
of the database client.

Tests construct separate postgres.js administrative, lock-holder, observer, or
benchmark clients and end those clients themselves. Those are test-owned
resources and are never the connection used by a public Mnemocyte client.

#### Needs correction

No correction is required to the readiness report's ownership inventory.

#### Genuinely undetermined

None. Source settles where current production construction and teardown occur.

### 1.3 Drizzle schema typing

#### Confirmed accurate

The concern is real, but the proposal's word "exactly" is too strong.

Current source defines (`src/db/index.ts:6-10`):

```ts
type MnemocyteDatabase = PostgresJsDatabase<typeof schema>;

interface DatabaseHandle {
  db: MnemocyteDatabase;
  close(): Promise<void>;
}
```

In the installed `drizzle-orm@0.45.2` declarations,
`PostgresJsDatabase<TSchema>` accepts any
`TSchema extends Record<string, unknown>`, while `drizzle()` infers and returns
that schema generic (`node_modules/drizzle-orm/postgres-js/driver.d.ts:6-27`).

A strict TypeScript 6.0.3 compiler probe against the installed declarations
produced this matrix:

| Argument type | `PostgresJsDatabase<typeof schema>` | `PostgresJsDatabase<Record<string, unknown>>` |
| --- | --- | --- |
| Drizzle with caller-only `{ users }` schema | Rejected: missing `memoriesTable`, `eventsTable`, and `metaTable` | Accepted |
| Drizzle with caller schema plus Mnemocyte schema | Accepted | Accepted |
| Drizzle constructed with no schema map | Rejected | Accepted |

Therefore the current alias requires the Mnemocyte schema keys to be present in
the instance's type, but does not require an exact key set. A merged schema is a
valid structural superset. A caller-only schema is rejected solely because it
lacks those keys.

The looser type asked about in the proposal is viable. An in-memory compiler
probe that replaced only the current alias with
`PostgresJsDatabase<Record<string, unknown>>` reported zero production-source
diagnostics. A generic acceptance boundary of the form
`PostgresJsDatabase<TSchema>` with
`TSchema extends Record<string, unknown>` also accepted caller-only and
schema-less instances, and current direct-table `select` and transaction calls
type-checked through it.

That result matches the operational source. Query helpers pass imported
`memoriesTable`, `eventsTable`, and `metaTable` objects directly to Drizzle and
do not use the relational `db.query` schema map
(`src/db/queries/meta.ts`, `src/db/queries/memories.ts`,
`src/db/queries/events.ts`). `executeCancelableSql()` obtains the real
postgres.js `$client` at runtime (`src/db/cancellation.ts:43-59`). None of
these operations requires Mnemocyte's tables to have been registered in the
caller's `drizzle(..., { schema })` type map.

#### Needs correction

The design statement that `PostgresJsDatabase<typeof schema>` requires the
caller to construct the instance with *exactly* Mnemocyte's schema map is
incorrect. It accepts supersets, but rejects caller-only or schema-less
instances.

The schema-merge requirement is not inherent to postgres.js Drizzle typing.
The installed declarations and current query code admit a looser type, so a
caller can retain an independent application schema map without importing and
merging Mnemocyte's schema merely for type compatibility.

The bare `PostgresJsDatabase` default is not that looser type: its default
generic is `Record<string, never>`, which accepts a schema-less database but
rejects a typed caller schema. `Record<string, unknown>` or a generic parameter
is the relevant distinction.

#### Genuinely undetermined

The exact public spelling - an erased
`PostgresJsDatabase<Record<string, unknown>>`, a generic function parameter,
or an equivalent exported alias - remains an API-design choice. Source settles
that callers do not need to merge Mnemocyte's schema; it does not choose which
of the compatible public spellings should be published.

## 2. `close()` ownership mechanism

### Confirmed accurate

An ownership-aware close callback is sufficient for the proposed
caller-supplied handle.

`DatabaseHandle` has only two members, `db` and required async `close()`
(`src/db/index.ts:8-11`). The Postgres store does not retain a separate driver
or pool. Its only lifecycle action is the unconditional
`handle.close()` call at `src/memory/postgres.ts:590-592`.

The shared client treats `store.close()` as a lifecycle promise, not proof that
a physical connection was ended. It waits for active operations, awaits the
promise, marks the Mnemocyte client closed on success, and reopens operation
admission only when the promise rejects (`src/memory/client-core.ts:835-851`).
It does not inspect a result, driver state, or pool state. The lifecycle tests
use arbitrary store close implementations, including a wrapped in-memory close
and a deliberately failing close, without any connection assumption
(`test/lifecycle/close.test.ts:117-220`).

The current `MemoryStore.close()` contract explicitly says that an adapter
wrapping a caller-supplied connection must not close it
(`src/memory/store.ts:315-325`). README and architecture text repeat that rule
(`README.md:558-570`, `docs/ARCHITECTURE.md:228-239`). A required callback that
resolves without ending the caller's client therefore satisfies both current
control flow and the documented ownership contract. The Mnemocyte client still
becomes logically closed while the caller's Drizzle/postgres.js instance
remains usable.

No read, write, migration, compatibility, transaction, error, cancellation, or
process-exit path assumes that successful Mnemocyte close means the underlying
connection was physically torn down.

### Needs correction

The proposal's "simply omitting the close callback entirely" option is not
valid against the current shape. `DatabaseHandle.close` is required, and
`createPostgresStore()` invokes it without an optional check. Literal omission
would fail type checking and would throw at runtime if bypassed with a cast.

The sufficient source-compatible mechanisms are an ownership-aware required
callback or a required no-op callback for the caller-owned handle. An explicit
boolean field is not required by current callers; it is one possible internal
representation of the same close behavior.

### Genuinely undetermined

Whether ownership is represented by a flag, by which callback is installed, or
by making the handle method optional is a maintainer decision. Only the last
choice would require changing the current unconditional caller. Source settles
the required behavior, not the internal representation.

## 3. Subpath packaging, dependency metadata, and lazy loading

### Confirmed accurate

A `mnemocyte/stores/drizzle` entry can be shipped as another ESM subpath of the
current package using the same wildcard build/export mechanism as the embedder
entries.

Current package metadata has explicit root and `./embedders` entries plus an
`./embedders/*` wildcard (`package.json:12-25`). The build emits multiple
entries through `tsdown src/index.ts "src/embedders/*.ts"`
(`package.json:28-30,54`). The resulting package contains matching `.mjs` and
`.d.mts` files under `dist/embedders/`. A parallel `./stores/*` wildcard can
emit matching files under `dist/stores/` without requiring a new export-map or
build-script entry for each future store adapter. Nothing in the ESM-only
package layout prevents that.

The root lazy-loading work remains relevant as a boundary to preserve. The
root imports only `createLazyPostgresStore`; the proxy dynamically imports
`postgres-runtime.js` on first use (`src/memory/lazy-postgres.ts:1-12`). The
package test confirms that `dist/index.mjs` has no static `drizzle-orm` or
`postgres` import and that a packed in-memory client runs with both packages
absent (`test/package/lazy-postgres.test.ts:45-136`).

The proxy itself is URL-specific and is not reusable for a caller-supplied
instance. It captures a `databaseUrl`, dynamically creates the owned Postgres
handle, and forwards all 18 `MemoryStore` methods. A caller who imports
`mnemocyte/stores/drizzle` has already chosen and loaded that adapter and
already owns the supplied Drizzle instance. The reusable principle is keeping
that adapter's runtime code out of the root static import graph, not reusing the
`createLazyPostgresStore(databaseUrl)` function.

### Needs correction

The proposal's dependency comparison with `mnemocyte/embedders/openai` is not
accurate:

- `drizzle-orm` and `postgres` are currently direct package dependencies
  (`package.json:83-86`); there is no `peerDependencies` block.
- The zero-static-import fix changed runtime loading, not package dependency
  metadata. Current architecture explicitly describes both packages as runtime
  dependencies for the Postgres path (`docs/ARCHITECTURE.md:79-84`).
- The OpenAI subpath needs no provider dependency because it uses platform
  `fetch`; it does not demonstrate how a dependency-bearing subpath declares
  peers (`src/embedders/openai.ts`, `README.md:98-108`).
- npm dependency fields apply to the package as a whole. An export subpath
  cannot independently declare `drizzle-orm` and `postgres` as peers while the
  root declares a different dependency relationship.

Thus the subpath export is achievable through the existing packaging pattern,
but "the `mnemocyte/stores/drizzle` subpath declares peers, not direct dependencies"
is not achievable as subpath-scoped metadata in the current single package.

Drizzle ORM itself does list driver packages such as `postgres` as optional
peers, so the proposal's statement about Drizzle's own driver packaging is
factually true. It does not change npm's package-wide metadata boundary for
Mnemocyte.

### Genuinely undetermined

Whether the current package-wide `drizzle-orm` and `postgres` direct
dependencies should move to package-wide peer dependencies is a maintainer
decision. That decision affects the existing URL-backed Postgres path as well
as the new subpath; current source and exports cannot make it local to
`mnemocyte/stores/drizzle`.

## 4. Testing gap

### Confirmed accurate

The claimed gap still exists.

A current repository-wide test search found:

- no test call to `drizzle(...)`;
- no test import from `drizzle-orm/postgres-js` or another Drizzle driver;
- no public `createMnemocyte({ store: ... })` path, because that API does not
  exist yet; and
- no test that calls `client.close()` and then reuses the exact database client
  Mnemocyte operated through.

The nearby cases remain the same as in the readiness report:

- `test/integration/consolidation-survivor-race.test.ts:71` passes
  `createDatabase(url)` into `createPostgresStore()`, so Mnemocyte still creates
  and owns that connection;
- `test/postgres/metadata-validation.test.ts` and
  `test/postgres/prune-validation.test.ts` use cast fake handles with empty
  close methods, not real Drizzle instances; and
- integration tests create separate postgres.js administrative connections,
  then construct the Mnemocyte client through `databaseUrl`. Reusing the admin
  connection after `client.close()` says nothing about ownership of the
  Mnemocyte connection.

The proposal's required integration scenario is therefore still the exact
missing coverage: give Mnemocyte a real externally constructed postgres.js
Drizzle instance, exercise it, close Mnemocyte, and prove that same instance is
still usable.

### Needs correction

None.

### Genuinely undetermined

None. The absence of the test is source-settled.

## 5. General accuracy after consolidation and JSDoc changes

### Confirmed accurate

The following proposal claims continue to match current source:

- v1's postgres.js-only scope matches the actual `MnemocyteDatabase` driver,
  `$client.unsafe()` cancellation, raw-result, error-field, and transaction
  assumptions.
- `createPostgresStore(handle)` does not inspect the origin of the handle or
  parse connection configuration (`src/memory/postgres.ts:201-601`). Its
  operation logic can consume a caller-owned handle once the type and close
  behavior are compatible.
- `ensureSchema()` remains a no-op and does not create or verify schema
  (`src/memory/postgres.ts:294-296`). Migrations and pgvector enablement remain
  external.
- Mnemocyte tables and indexes use fixed `mnemocyte_*` names. Drizzle table
  definitions use unqualified `pgTable`, and the migration's self-reference
  explicitly targets `public.mnemocyte_memories`; the proposal's current
  `public`-schema and collision constraints are accurate
  (`src/db/schema.ts:31-92`, `migrations/0000_initial.sql:1-35`).
- `CONSOLIDATION-02` validation runs in shared orchestration before the store,
  while `CONSOLIDATION-03` re-reads and locks the survivor with requested losers
  inside the Postgres transaction. Neither change adds connection ownership or
  a schema-map lookup that invalidates the proposal
  (`src/memory/client-core.ts:731-828`, `src/memory/postgres.ts:477-571`).
- The documented `MemoryStore.close()` ownership rule added by the JSDoc pass
  directly supports the caller-owned connection requirement.

### Needs correction

In addition to the close, typing, and dependency corrections above, the
proposal understates the documentation surface affected by the new public
path. Current source comments say:

- backend selection depends only on whether `databaseUrl` is supplied
  (`src/types.ts:59-65`);
- omitting `databaseUrl` selects in-memory storage
  (`src/types.ts:181-190`, `src/client.ts:13-19`); and
- the returned client owns its underlying Postgres resources
  (`src/client.ts:21-23`).

Those comments contradict a `store: drizzleStore(db)` path whose connection is
caller-owned. Updating only README and the new subpath documentation would
leave the public JSDoc inaccurate. The current architecture's public-surface,
config, package-dependency, and connection-lifecycle sections also describe
only the URL-owned path (`docs/ARCHITECTURE.md:79-84,288-341,683-693`).

The public `MnemocyteClient.close()` comment at `src/types.ts:961-969` is
already compatible: it says the client closes the store and releases
underlying resources, without promising that caller-owned resources are ended.

### Genuinely undetermined

No additional source question blocks the proposal's stated v1 scope. The
remaining real maintainer decisions identified by this verification are:

- the public type/export used for the new config value;
- the `databaseUrl`-plus-`store` conflict policy and its validation error;
- the exact public spelling of the loose postgres.js Drizzle type;
- the internal representation of caller ownership while preserving the
  required close behavior; and
- whether dependency metadata changes package-wide from direct dependencies to
  peers.

Everything else requested by this verification - current config shape and
validation order, production connection ownership sites, compatibility with a
looser Drizzle schema generic, close-call assumptions, subpath export
feasibility, lazy-loading relevance, and the missing integration test - is
settled by current source.
