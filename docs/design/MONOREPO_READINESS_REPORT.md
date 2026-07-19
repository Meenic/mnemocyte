# Monorepo Readiness Report

## Scope and evidence

This is a discovery report, not a target-design proposal. It describes the
repository at commit `a11ecf1` (`main`, tagged `v0.4.0`) and does not recommend
whether the repository should become a monorepo.

The findings below come from the checked-in package/build/test configuration,
the generated `dist/` tree, the current dry-run package contents, every method
on the internal `MemoryStore`, both store implementations and their callers,
the Postgres queries and migrations, all production third-party imports, the
test suite, `AGENTS.md`, Git history/tags, and `.github/workflows/ci.yml`.

The high-level fact pattern is:

- There is one npm package and one lockfile importer. A
  `pnpm-workspace.yaml` exists, but it declares no package globs and is used
  only for pnpm's `allowBuilds` setting. There is no Turborepo configuration.
- Shared client orchestration already runs through an internal `MemoryStore`,
  and there are useful shared cross-backend behavior fixtures. Those are real
  groundwork.
- The root runtime artifact still statically loads the entire Postgres stack.
  An in-memory consumer importing `mnemocyte` therefore still needs both
  current runtime dependencies to resolve.
- The store boundary is storage-oriented, but several of its required
  behaviors are stronger than basic CRUD: vector and lexical retrieval,
  atomic guarded deletion, exact post-access updates, stable tuple cursors,
  and atomic, concurrency-safe consolidation.
- Versioning, packing, changelogging, tagging, and CI are all single-package.
  No existing tool manages independent package versions or releases.

## 1. Current package structure

### 1.1 Package/workspace topology

This is a **single npm package**:

- The only `package.json` is the repository-root `package.json`.
- Its package name is `mnemocyte` and its current version is `0.4.0`.
- There are no `packages/` or `apps/` package directories and no nested
  package manifests.
- `package.json` has no `workspaces` field.
- `pnpm-lock.yaml` has one importer, `.`.
- `pnpm-workspace.yaml` exists, but contains only:

  ```yaml
  allowBuilds:
    esbuild: true
  ```

  It does not contain a `packages:` list. The repository is therefore
  workspace-root-aware for pnpm configuration, but it is not already split or
  partially populated as a multi-package workspace.
- There is no `turbo.json`, no `packageManager`-adjacent Turborepo setup, and
  no Turborepo dependency or script.

### 1.2 Monorepo-relevant configuration inventory

| File/field | Current behavior and evidence |
| --- | --- |
| `package.json#workspaces` | Absent. |
| `package.json#files` | Publishes `"dist"` and `"migrations"`. npm/pnpm also include the usual `package.json`, `README.md`, and `LICENSE`. Because the entire migration directory is included, the tarball contains SQL migrations, the template/renderer, and `migrations/meta/*.json`. |
| `package.json#exports` | One root ESM entry (`.`), one `./embedders` entry, a blocked `./embedders/index`, and a wildcard `./embedders/*`. Each live entry points to `.mjs` runtime and `.d.mts` declaration files under the single root `dist/`. There are no backend/adapter exports. |
| `package.json#types` | A single root declaration entry, `./dist/index.d.mts`. |
| `package.json#type` | `"module"`; the package is ESM-only. |
| `package.json#packageManager` | `pnpm@11.1.1`. |
| `package.json#publishConfig` | One root public package with npm provenance enabled. |
| `pnpm-workspace.yaml` | Present only for `allowBuilds`; no workspace package patterns. |
| `pnpm-lock.yaml` | Lockfile v9 with only the root importer. |
| `turbo.json` | Absent. |
| tsdown configuration | There is no `tsdown.config.*`. Build entry points are specified directly in root scripts: `tsdown src/index.ts "src/embedders/*.ts"`. |
| `tsconfig.json` | One production config for all `src/`, with `rootDir: "./src"` and `outDir: "./dist"`. It has no project references and is not `composite`. |
| `tsconfig.test.json` | Extends the root config, changes `rootDir` to `.`, includes all source/tests plus `vitest.config.ts`, and aliases the package name directly to root source files. |
| `test/package/tsconfig.json` | Extends the same root config and aliases package imports to the root `dist/` declarations via `../../dist/...`. |
| `vitest.config.ts` | One root config with `unit`, `integration`, and `package` projects. Source and built-package aliases are hard-coded to root `src/` and `dist/`. |
| `drizzle.config.ts` | One root Postgres Drizzle configuration: schema `./src/db/schema.ts`, output `./migrations`, and one root `DATABASE_URL`. |
| `biome.json` | One repository-wide root lint/format config. |
| `.github/workflows/ci.yml` | One root-package validation workflow. It invokes root scripts, not recursive/filter-based workspace tasks. |

### 1.3 How `dist/` is produced and packed

`tsc` does not produce the publishable files in the normal workflow.
`package.json` uses tsdown directly:

- `pnpm build` runs `tsdown src/index.ts "src/embedders/*.ts"`.
- `pnpm dev` runs the same entries with `--watch`.
- `pnpm run test:ci` builds first, then runs the unit and package Vitest
  projects.
- `prepublishOnly` independently runs the tsdown build, root type checking,
  and a pack dry run.
- `pnpm run pack:check` only runs `pnpm pack --dry-run`; it does not itself
  build. In CI it receives fresh artifacts because `test:ci` ran first, and on
  publish `prepublishOnly` builds first.

`dist/` is gitignored. The current generated tree contains:

- root and embedder `.mjs` entry files;
- `.d.mts` declarations;
- source/declaration maps where tsdown emitted them; and
- code-split hashed chunks such as the shared error and type chunks.

The observed `pnpm run pack:check` tarball contains those `dist/` files,
`migrations/` (including the Drizzle metadata snapshots), `package.json`,
`README.md`, and `LICENSE`. It identifies one package,
`mnemocyte@0.4.0`.

### 1.4 Single-package layout assumptions

The following current paths/configuration assume one package boundary:

- `src/index.ts` re-exports `createMnemocyte` from `src/client.ts`.
  `src/client.ts` statically imports `src/db/index.ts`, the in-memory client,
  and the Postgres client. That makes both backend implementations part of the
  root entry graph even when a caller only selects in-memory storage.
- `src/memory/postgres.ts` reaches into `../db/queries/*`,
  `../db/schema.ts`, and `../db/index.ts`, while also importing shared
  `client-core.ts`, store types, errors, resilience, defaults, and JSON/record
  helpers. These relative paths cross the most likely future core/adapter
  boundary.
- `src/memory/postgres-records.ts` imports `MemoryRow` from
  `src/db/schema.ts`, so a module under the otherwise shared `memory/`
  directory has a Drizzle/Postgres schema type dependency.
- Conversely, `src/db/cancellation.ts` imports shared `MnemocyteError` and
  `throwIfAborted`, `src/db/schema.ts` imports the public `JsonObject` type,
  and the DB query files import public memory types. The current dependency
  directions are source-folder-relative rather than package-boundary-relative.
- The internal `MemoryStore` in `src/memory/store.ts` imports public types
  from `src/types.ts` and `StoredMemory` from `src/memory/records.ts`; it is
  not a standalone contract module today.
- The one root `tsconfig.json` covers all production code. Test configs extend
  it rather than using per-package TypeScript projects or references.
- `vitest.config.ts` aliases `mnemocyte` to one root source entry and its
  package project to one root `dist/`.
- `drizzle.config.ts`, all migration scripts, package scripts, the benchmark,
  and integration tests resolve schema/migration paths from repository root.
- Package export tests in `test/package/` assume a single self-referencing
  package name and one root `dist/`.
- `.github/workflows/ci.yml` caches one lockfile, runs one install, and invokes
  one set of root validation/pack scripts.
- `README.md`, `CHANGELOG.md`, release tags, and the release policy all
  describe one published package and one version stream.

## 2. `MemoryStore` interface audit

### 2.1 Actual boundary and cross-cutting shape

The real interface is `src/memory/store.ts:127-200`. It is internal and is not
exported from `src/index.ts`.

Before considering individual methods, the interface has these cross-cutting
assumptions:

- `backend` is typed as the public `MnemocyteBackend`, whose complete union is
  currently `"in-memory" | "postgres"` (`src/types.ts:65`). It cannot
  currently identify SQLite or any third backend.
- Inserts take `StoredMemory`, which always contains an in-process
  `number[]` embedding in addition to the full public `Memory` shape.
  `Memory` itself requires model/dimension identity, JS `Date` values, string
  arrays for tags, and JSON value metadata.
- Search inputs reuse broad public inputs. For example,
  `StoreVectorSearchInput` extends `RecallInput`, removing only `minScore`, so
  it also carries fields such as `query`, `explain`, and `signal` that are not
  all storage concerns. `findDuplicatePairs` and `listAuditLog` likewise
  accept public input types and a separate store options object.
- The store has no general transaction API. Atomicity is expressed as
  postconditions on specific methods, especially guarded deletion, pruning,
  and `consolidate`.
- Lifecycle ownership is part of the boundary because every store must
  implement `close()`.

Difficulty ratings below mean the difficulty of implementing the **current
observed contract and behavior** against SQLite, not the difficulty of a
different or reduced API. “High” often reflects behavior, concurrency, or
extension requirements rather than basic SQL syntax.

### 2.2 Method-by-method audit

| Method | Current Postgres behavior | Current in-memory behavior | Backend-specific or implied contract | SQLite difficulty |
| --- | --- | --- | --- | --- |
| `ensureSchema(): Promise<void>` | No-op in `src/memory/postgres.ts:295`. Schema failures are discovered by later queries and normalized to `"MIGRATION"`/`"DB"`. | No-op. | Shared core calls it before non-embedding operations, so the implied purpose is “storage is ready,” but the current contract specifies no checks or schema-creation behavior. It does not authorize hidden migration. | **Low** — matching the current no-op is trivial. |
| `ensureEmbeddingCompatibility(embedder)` | Reads `mnemocyte_meta`; requires matching dimensions; infers/atomically records an unset installation model; rejects mixed historical models or mismatches; caches a successful check for the store lifetime (`src/memory/postgres.ts:205-290`, `src/db/queries/meta.ts`). | No-op. | Assumes a store can enforce one installation-wide vector model/dimension and, for an empty/unclaimed store, make a race-safe first model claim. This policy is not inherently PostgreSQL-specific, but it is persistent-backend state beyond ordinary row storage. The parameter is the whole `Embedder`, though only identity/dimensions are used. | **Medium** — metadata reads are simple, but first-writer model claiming and compatibility behavior must remain race-safe. |
| `insertMemories(memories)` | Converts rows to Drizzle `NewMemoryRow`, performs one batch `INSERT ... RETURNING`, maps rows to detached public memories, and wraps failures (`src/memory/postgres.ts:297-304`, `src/db/queries/memories.ts:161-169`). | Transfers each owned row into a `Map` and returns a detached clone for each row. | Requires exactly one detached result per input ID; callers reject missing, duplicate, or unknown IDs and restore input order (`src/memory/client-core.ts:156-184`). Postgres persistence currently uses pgvector, `text[]`, `jsonb`, and `timestamptz`, but the interface only requires equivalent values, not those column types. | **Medium** — batch/cardinality semantics are straightforward, while vector/array/JSON/date encoding and detached results require explicit handling. |
| `vectorSearch(input)` | Uses pgvector cosine distance (`<=>`), orders by vector distance, filters through PostgreSQL array/date/`now()` expressions, clamps the component to finite `[0,1]`, and uses the HNSW-capable vector column (`src/db/queries/memories.ts:59-77,667-717`). The query is not routed through the postgres.js cancellation helper. | Scans all memories, applies shared JS filters, computes cosine in JS, clamps, sorts, and slices. | The contract requires vector similarity candidates and `[0,1]` scores, not pgvector specifically. Efficient SQLite implementation nevertheless depends on a vector extension/index or falls back to an in-process/full-table scan. Store filtering includes all-tags semantics and strict dates. | **High** — exact behavior is implementable, but indexed vector search is not native SQLite functionality and extension behavior/indexing would dominate the work. |
| `lexicalSearch(input)` | Uses PostgreSQL English full-text search: `to_tsvector`, `websearch_to_tsquery`, and `ts_rank`, plus the same SQL filters (`src/db/queries/memories.ts:719-765`). | Uses the shared token/substring lexical scorer over an in-process scan, discards zero scores, sorts, and slices. | Backends already do not produce identical lexical scoring algorithms. The contract only exposes a numeric component and ordered candidates. PostgreSQL's query syntax/ranking is backend-specific; SQLite FTS5 has different parsing and ranking. | **Medium** — FTS5 or a scan can supply candidates, but PostgreSQL query/ranking semantics are not portable. |
| `getMemoryEmbeddings(memoryIds)` | Selects only `id, embedding` and returns a `Map`, omitting null embeddings (`src/db/queries/memories.ts:648-665`). | Looks up IDs in the map and copies each vector. | Shared recall uses this for lexical-only candidates and treats a missing vector as zero similarity. The contract assumes embeddings can be reloaded as JS number arrays. | **Low** — the main work is decoding whatever SQLite representation stores the vector. |
| `markMemoriesAccessed(memoryIds)` | One `UPDATE` increments `access_count` atomically, sets a shared timestamp, and `RETURNING`s ID/count/timestamps (`src/db/queries/memories.ts:617-646`). | Sequentially mutates matching map entries with one shared `Date`. | Requires exactly one **post-update** record per requested ID. Shared core validates cardinality/IDs and patches public results without rescoring (`src/memory/client-core.ts:524-543`). The increment must not be a read/then-write race. | **Medium** — SQLite can perform atomic increments, but batch returning/cardinality and concurrent access semantics need care. |
| `deleteMemory(entityId, memoryId)` | Executes the guarded candidate/dependent/delete CTE. If a dependent points at the candidate, reports `"CONFLICT"` before deletion. It also maps violation of the named self-FK to the same error (`src/db/queries/memories.ts:211-220,301-374`; `src/memory/postgres.ts:145-160,352-359`). | Validates entity ownership, scans every memory for a dependent, then deletes the one ID. | The required behavior is stronger than a normal delete: no referenced consolidation survivor may be removed. PostgreSQL's `ON DELETE NO ACTION` FK is a race backstop, not the only check. A different backend must preserve the relationship even if it has no foreign keys. | **Medium** — SQLite supports self-FKs, but FK enforcement must be active and the pre-delete conflict check must remain atomic with the delete. |
| `deleteMemoriesForEntity(entityId)` | Uses the same guarded CTE for the full entity selection and refuses the entire delete if any selected target has a dependent, including a dependent that is also in the selected set. | Builds the complete candidate set, checks all memories for references into it, then deletes only after the check passes. | `CONSOLIDATION-DELETE-01` explicitly requires all-or-nothing behavior. It is not acceptable to rely on delete order or to delete both ends of the relationship in the same batch. | **Medium** — a transaction plus a candidate/dependent query can preserve it, but it is more than a single `DELETE WHERE entity_id = ?`. |
| `prune(filter, options?)` | Validates that an internal selector exists; dry run uses a cancelable count query. A real prune uses the guarded materialized CTE, returns matched/deleted/per-entity counts, refuses the whole batch on dependents, and uses postgres.js query cancellation (`src/memory/postgres.ts:370-398`; `src/db/queries/memories.ts:232-374`). | Cooperatively checks cancellation while scanning, gathers all matches, checks all dependents before mutation, deletes, and calculates sorted per-entity counts. | Requires AND-combined selectors, dry-run parity, exact per-entity deletion details, all-or-nothing survivor protection, and cancellation. PostgreSQL-specific pieces include `text[] @>`, `now()`, writable/materialized CTE shape, and postgres.js cancellation. | **High** — filters alone are moderate; the combined atomic guard, count details, and in-flight cancellation make the full current behavior substantially harder. |
| `findDuplicatePairs(input, options?)` | Runs one cancelable pgvector self-join, filters both sides, clamps returned similarity, orders, and limits (`src/db/queries/memories.ts:376-511`). | Filters candidates and performs an O(n²) pair scan with cooperative cancellation. | Requires pairwise cosine behavior and one occurrence per unordered pair. Efficient SQLite support again depends on vector capabilities; the current Postgres SQL uses pgvector operators and postgres.js cancellation. | **High** — a correct O(n²) implementation is simple, but scalable vector pair search and cancelability are not native SQLite features. |
| `addAuditEvents(events)` | Sequentially inserts cloned JSON metadata events through Drizzle; it does not wrap the whole supplied array in a transaction (`src/memory/postgres.ts:429-440`). Shared ordinary audit calls swallow any failure. | Clones every event and appends it to the audit array. | Requires value-copy ingress. Ordinary audit persistence is best-effort, so partial Postgres insertion is possible if a later event fails. Consolidation audit does not use this method; it is written inside `consolidate`'s transaction. JSONB is only the Postgres representation. | **Low** — ordinary inserts and JSON text encoding are direct. |
| `listAuditLog(input, options?)` | Selects by entity and strict timestamp filters; applies row-value `(timestamp, id)` before/after comparisons; orders both columns descending; and runs through postgres.js cancellation (`src/db/queries/events.ts:33-66`). | Filters using JS `Date` milliseconds plus lexical ID tie-breaking, sorts the same tuple newest-first, slices, and deep-clones. | The composite cursor is a real cross-backend contract: stable strict ordering by timestamp then event ID. PostgreSQL row-value comparison and `timestamptz` are implementation details. Timestamp storage precision/ordering and in-flight cancellation must remain consistent elsewhere. | **Medium** — SQLite can express tuple ordering/comparisons (or equivalent predicates), but timestamp representation and driver cancellation need explicit verification. |
| `getMemory(entityId, memoryId, options?)` | Selects one row by both keys and maps it to a detached memory. It checks the signal before and after the query but does not cancel an in-flight query. | Checks cancellation, looks up by ID, verifies entity ownership, and clones. | Assumes memory IDs are globally addressable but always entity-scoped at this boundary. Cancellation semantics are only pre/post for Postgres here. | **Low** — keyed lookup and detached mapping are direct. |
| `loadConsolidationTargets(entityId, ids, options?)` | Selects `id`, `tags`, and `supersededBy` for matching IDs/entity; signal checks occur around, not during, the query. | Looks up each ID, filters by entity, copies tags, and checks cancellation per item. | Shared core requires every requested loser to be found and uses the returned target state for a preflight conflict check. The later `consolidate` call must recheck because this read is outside the mutation transaction. | **Low** — a filtered `IN` query is direct; this method alone supplies no concurrency guarantee. |
| `consolidate(input, options?)` | Opens a DB transaction; locks requested losers in stable ID order with `FOR UPDATE`; rechecks different-survivor conflicts; updates only active losers; writes `"memory.superseded"` events in the same transaction; optionally merges tags into the survivor; and checks aborts between statements and just before returning (`src/memory/postgres.ts:483-556`, `src/db/queries/memories.ts:542-615`). | Precomputes targets, conflicts, newly superseded rows, merged tags, and audit events before a final synchronous mutation block, so no await can expose a partial in-memory state. | The interface comment requires one atomic consolidation. `CONSOLIDATION-01` also requires survivor-specific idempotency and concurrency safety, so the caller's earlier read is insufficient. Audit events and tag merge must commit/roll back with loser updates. PostgreSQL uses transactions and row locks; SQLite has database/page-oriented write serialization rather than `FOR UPDATE`. | **High** — preserving atomic mutation, audit coupling, idempotency, and competing-survivor outcomes under SQLite concurrency is a major part of the adapter. |
| `stats(input, now)` | Uses SQL aggregates, filtered counts, and `countDistinct`, with the supplied `now` used for expiry classification (`src/db/queries/memories.ts:130-159,186-209`). | Scans the selected memories and counts total/active/expired/superseded plus distinct entities. | Semantics are portable, but “active” intentionally excludes both expired and superseded rows while expired and superseded counts can overlap. | **Low** — ordinary aggregates and a bound time value are sufficient. |
| `close()` | Calls the owned `DatabaseHandle.close()`, which ends the postgres.js client. Failures are normalized (`src/db/index.ts:71-75`). | Clears memories and audit events. | Every store is currently treated as lifecycle-owned by the client. Shared core waits for admitted operations and retries close after a failure, but the store method itself has no caller-owned/no-op distinction. | **Low** — driver shutdown or an intentional no-op is mechanically simple. |

### 2.3 The requested backend-specific checks

#### `ON DELETE NO ACTION` and `CONSOLIDATION-DELETE-01`

The self-reference is real and explicit:

- `migrations/0000_initial.sql:31` and the custom-dimension template at line
  39 create
  `mnemocyte_memories_superseded_by_mnemocyte_memories_id_fk` with
  `ON DELETE no action ON UPDATE no action`.
- `src/db/schema.ts:48-50` models the self-reference.
- `src/memory/postgres.ts:72-73,145-160` recognizes that exact named
  constraint and maps SQLSTATE `23503` to the shared `"CONFLICT"` error.
- The guarded CTE in `src/db/queries/memories.ts:301-374` is the primary
  atomic check; the FK is documented and implemented as a race backstop.
- The in-memory equivalent is `assertNoDependentMemories` in
  `src/memory/in-memory.ts:69-77`, called before single, entity, and prune
  deletion.

The portable contract is therefore not “support a Postgres FK.” It is “never
leave a dangling survivor reference, and reject the entire selected delete
before mutation.” A non-relational store would have to enforce that invariant
itself.

#### Composite `(timestamp, event ID)` audit cursor

The interface reuses public `ListAuditLogInput`/`AuditLogCursor`, so the tuple
ordering is part of current behavior:

- Postgres compares row values and orders `timestamp DESC, id DESC`
  (`src/db/queries/events.ts:49-62`).
- In-memory compares `Date.getTime()` then string ID and reverses that
  comparator for newest-first order (`src/memory/in-memory.ts:55-67,253-292`).
- Timestamp-only `before`/`after` remain strict filters and intentionally
  exclude all events at the boundary timestamp.

This is not JSONB- or pgvector-specific, but every backend must preserve a
stable total order and strict tuple boundary.

#### JSONB metadata

`MemoryStore` does **not** require JSONB operators. It carries the public
recursive `JsonObject` value type:

- Shared ingress validation/deep cloning is in `src/memory/json.ts`.
- In-memory stores cloned JS values.
- Postgres schema columns are `jsonb` for both memories and events
  (`src/db/schema.ts:43,78`; `migrations/0000_initial.sql:5,17`).
- Current filters and queries do not predicate on metadata fields.

The current semantic requirement is lossless JSON value persistence plus
mutation isolation, not PostgreSQL JSONB behavior. SQLite text/JSON storage
would still need to round-trip exactly the accepted JSON domain, including the
normalization of negative zero and rejection of non-finite/cyclic/non-plain
values that happens before the store.

#### Transactional consolidation

Atomicity is explicitly stated on `MemoryStore.consolidate`, and callers rely
on it. Shared core performs existence and conflict preflight, but Postgres
re-reads/locks inside the transaction to handle concurrent calls. Loser
updates, consolidation audit rows, and survivor tag merge share that
transaction. The in-memory implementation preserves the same visible
all-or-nothing behavior by doing all checks/allocation before its synchronous
mutation block.

This makes transaction/concurrency semantics part of the adapter workload even
though there is no general transaction type in the interface.

#### postgres.js-specific cancellation

The generic surface is `StoreOperationOptions.signal`, but the Postgres
implementation is driver-specific:

- `src/db/cancellation.ts` compiles Drizzle `SQL` through `PgDialect`.
- It reaches through the Drizzle database's `$client`, requires it to be a
  postgres.js `Sql` client, calls `client.unsafe(...)`, and invokes the
  returned query's `.cancel()` on abort.
- It throws `"DB"` if that postgres.js client is unavailable.
- `prune`, duplicate search, and audit-list queries use this helper.
- `getMemory` and `loadConsolidationTargets` only check before/after their
  Drizzle query.
- Consolidation deliberately does not cancel an in-flight transactional
  statement; it checks between steps so an abort rolls back at the next
  boundary. An abort after the final check may still race with commit.
- Recall vector/lexical queries and access updates have no store options
  parameter and do not request in-flight DB cancellation.

The `AbortSignal` is generic; the current in-flight implementation is not
generic across Drizzle drivers.

## 3. Runtime dependency audit

Root `package.json` has exactly two entries under `dependencies`:
`drizzle-orm` and `postgres`.

### 3.1 Dependency-by-dependency inventory

| Dependency | What it is used for | Direct production imports | Scope in the current source graph | Current required/peer status |
| --- | --- | --- | --- | --- |
| `drizzle-orm@^0.45.2` | Creates a Drizzle database over postgres.js; declares PostgreSQL tables/types; builds typed CRUD/aggregate queries and raw SQL fragments; compiles raw SQL for cancellation. | `src/db/index.ts` (`drizzle-orm/postgres-js`); `src/db/cancellation.ts` (`drizzle-orm`, `drizzle-orm/pg-core`); `src/db/schema.ts` (`drizzle-orm`, `drizzle-orm/pg-core`); `src/db/queries/events.ts`; `src/db/queries/memories.ts`; `src/db/queries/meta.ts`. | Direct imports are confined to `src/db/`. Indirect Drizzle schema/query types reach `src/memory/postgres.ts` and `src/memory/postgres-records.ts`. Shared `client-core.ts`, validation, embedding, scoring, context, observability, resilience, and the in-memory store do not import Drizzle. | It is genuinely required by the **current published root artifact**, because `dist/index.mjs` statically imports it. Semantically it is used only for the Postgres code path. Simply marking it optional/peer without changing the entry graph would make root import fail when it is absent. |
| `postgres@^3.4.9` (postgres.js) | Opens/owns the TCP client, applies connection/SSL/pooler options, closes it, and supplies the cancelable `.unsafe(...).cancel()` query object under Drizzle. | Runtime import in `src/db/index.ts`; type import plus runtime `$client` assumption in `src/db/cancellation.ts`. | Direct production usage is Postgres-only. It is selected by `src/client.ts`, but that file statically imports the Postgres setup before it knows which backend the caller will choose. | It is also genuinely required by the **current root artifact** and could not become an absent optional peer with the current static imports. It is otherwise not used by shared orchestration or the in-memory backend. |

For completeness, repository test/tooling imports reinforce the current
Postgres harness:

- All ten `test/integration/*.test.ts` files import `postgres` directly.
- `test/benchmarks/retrieval.bench.ts` imports it for optional Postgres
  benchmarks.
- `drizzle.config.ts` imports `drizzle-kit`, which is correctly a
  `devDependency`; it is not one of the two runtime dependencies.
- No test directly imports `drizzle-orm`; production DB modules provide that
  layer.

### 3.2 How deeply the dependencies reach into shared code

They are **not deeply threaded through `client-core.ts` or shared
validation/orchestration**:

- `src/memory/client-core.ts` depends on the internal `MemoryStore`, public
  types, and shared helpers only.
- `src/memory/validation.ts`, `src/memory/embeddings.ts`,
  `src/retrieval/scorer.ts`, context modules, observability, resilience, JSON
  validation, and the in-memory adapter have no third-party runtime imports.
- The store interface itself has no Drizzle or postgres.js types.

They are, however, **eagerly threaded through the root module graph**:

1. `src/index.ts` exports `createMnemocyte`.
2. `src/client.ts` statically imports `createDatabase` and
   `createPostgresClient`.
3. Those imports load the Drizzle schema/query modules and postgres.js even
   when `databaseUrl` is omitted.
4. The generated `dist/index.mjs` confirms the result at its top level with
   static imports from `drizzle-orm/postgres-js`, `drizzle-orm`,
   `drizzle-orm/pg-core`, and `postgres`.

The current separation is therefore good at the **source responsibility**
level but not at the **installed/runtime package boundary**.

### 3.3 Specific obstacles to a zero-required-dependency root

These are observations about the current graph, not proposed contract changes:

- `src/client.ts` makes Postgres selection synchronous and statically imports
  the complete Postgres implementation. There is no optional/dynamic adapter
  boundary in the root artifact.
- The tsdown root entry bundles both backends into one entry and externalizes
  their npm dependencies, so ESM resolution happens at import time rather than
  only when `databaseUrl` is used.
- `src/types.ts` exposes `databaseUrl` as the root factory's Postgres switch
  and limits `MnemocyteBackend` to two current values.
- `src/memory/postgres.ts` is mostly an adapter, but it directly imports shared
  client construction and many `src/db/` modules; it is not a self-contained
  publishable subtree.
- `src/memory/postgres-records.ts` imports a Drizzle-derived `MemoryRow` from
  `src/db/schema.ts`.
- `src/db/cancellation.ts` is explicitly tied to both Drizzle's PostgreSQL
  dialect compiler and postgres.js's `$client`/`.cancel()` behavior.
- Migrations and Drizzle metadata are packaged as part of the one root package.
- Package export smoke tests prove an in-memory root client from the built
  package, but they run in this repository where both dependencies are
  installed; there is no packed-consumer test with the database dependencies
  absent.

The positive evidence is equally specific: there are no provider SDKs, the
OpenAI helper is `fetch`-based, and all non-Postgres shared runtime modules use
only local code and platform APIs. The required dependency problem is caused
by root assembly/selection, not by validation, orchestration, retrieval
fusion, or context rendering importing those packages.

## 4. Test duplication between backends

### 4.1 Corpus and existing suite split

The current test corpus contains:

- 41 `*.test.ts` files with 6,288 physical lines;
- 10 files under `test/fixtures/` with 1,306 physical lines;
- 10 Postgres integration files with 1,827 physical lines; and
- separate Vitest projects for unit, integration, and built-package tests.

Integration tests skip when `DATABASE_URL` is absent. The integration project
runs files serially and allows 60-second tests.

### 4.2 Near-equivalent in-memory/Postgres coverage

Nine behavior areas already put the substantive scenario/assertions in a
shared fixture. The separate test files are backend-specific wrappers around
that shared behavior:

| Behavior | In-memory test file | Postgres test file | Shared behavior/assertion fixture |
| --- | --- | --- | --- |
| Equal-timestamp composite audit cursor ordering/pagination | `test/audit/audit-cursor.test.ts` | `test/integration/audit-cursor.test.ts` | `test/fixtures/audit-cursor.ts` |
| Referenced-survivor deletion conflict for `forget`, `forgetAll`, and prune | `test/consolidate/deletion-policy.test.ts` | `test/integration/consolidation-delete-policy.test.ts` | `test/fixtures/consolidation-delete-policy.ts` |
| Survivor-specific consolidation idempotency, mixed-batch atomicity, audit/tag preservation, and concurrent targets | `test/consolidate/target-policy.test.ts` | `test/integration/consolidation-delete-policy.test.ts` | `test/fixtures/consolidation-target-policy.ts` |
| Per-entity audit events for global prune | `test/audit/prune-audit.test.ts` | `test/integration/prune-audit.test.ts` | `test/fixtures/prune-audit.ts` |
| Recall returns exact persisted post-access counts/timestamps without rescoring | `test/retrieval/access-metadata.test.ts` | `test/integration/recall-access-metadata.test.ts` | `test/fixtures/recall-access-metadata.ts` |
| Mutable remember/rememberMany input snapshot timing | `test/memory/remember-input-snapshot.test.ts` | `test/integration/remember-input-snapshot.test.ts` | `test/fixtures/remember-input-snapshot.ts` |
| Runtime remember/type-filter validation before embedding/storage | `test/memory/remember-input-validation.test.ts` | `test/integration/remember-input-snapshot.test.ts` | `test/fixtures/remember-input-validation.ts` |
| Metadata traversal count and detached memory/audit metadata | `test/memory/metadata-traversals.test.ts` | `test/integration/remember-input-snapshot.test.ts` | `test/fixtures/metadata-traversals.ts` |
| Batch insert cardinality and input order | `test/memory/store-insert-contract.test.ts` | `test/integration/store-insert-contract.test.ts` | `test/fixtures/store-insert-contract.ts` |

These are not merely similar tests: the same exported fixture function is
called with an in-memory client and a Postgres client. The Postgres access
metadata fixture additionally receives a backend-specific callback that reads
the persisted row state directly.

There are also manually duplicated or partially overlapping behavior checks:

| Overlap | In-memory/shared-core coverage | Postgres coverage | Current degree of sharing |
| --- | --- | --- | --- |
| Pre-aborted maintenance operations (`prune`, duplicate search, audit list, consolidation) leave state unchanged | `test/resilience/operation-cancellation.test.ts:19-70` | `test/integration/cancellation.test.ts:202-228` | Assertions are written separately. The same files then diverge into backend-specific mid-scan versus blocked-query/transaction cancellation. |
| Zero-norm rejection and acceptance of tiny nonzero vectors | `test/embeddings/validation.test.ts` | `test/integration/vector-correctness.test.ts:165-280` | Similar public behavior is asserted separately; the Postgres test adds direct pgvector/index/storage checks. |
| Signed cosine clamping before fused score filtering | `test/retrieval/quality.test.ts:102-162` | `test/integration/vector-correctness.test.ts:282-359` | Similar candidate/final-score behavior is asserted separately; no shared fixture. |
| Malformed prune selectors reject before storage | `test/prune/prune.test.ts:12-77` | `test/integration/postgres.test.ts:209-233` | The Postgres list is a subset of the unit list and is duplicated inline. |
| General happy path for remember/recall, duplicate detection, consolidation, context, audit, prune, stats, forget-all, and observability | Focused files including `test/dedup/find-duplicates.test.ts`, `test/consolidate/consolidate.test.ts`, `test/context/builder.test.ts`, `test/audit/audit-log.test.ts`, `test/prune/prune.test.ts`, and `test/observability/hooks.test.ts` | `test/integration/postgres.test.ts` | The integration file is a shallower end-to-end repetition, not a shared contract suite. |

Postgres-only coverage should not be counted as duplication. Examples include:

- installation model/dimension repair and mismatch behavior in
  `test/integration/embedding-model-compatibility.test.ts` and mocked
  `test/postgres/metadata-validation.test.ts`;
- pgvector float4 round-trip and HNSW/index assertions in
  `test/integration/vector-correctness.test.ts`;
- postgres.js blocked-query cancellation and transaction rollback in
  `test/integration/cancellation.test.ts`;
- the defensive “empty internal prune filter issues no DELETE” query test in
  `test/postgres/prune-validation.test.ts`; and
- SQL migration rendering/application tests.

Likewise, provider resilience, OpenAI response handling, context formatting,
configuration validation, lifecycle coordination, package exports, and many
shared scoring tests are core/package concerns rather than two backend suites.

### 4.3 Setup versus shareable assertion estimate

There are two useful ways to quantify this.

**Parity-focused slice.** The nine parity fixtures above total 1,185 lines.
Their associated in-memory and Postgres wrapper files total 941 lines (404
non-integration plus 537 integration). Some wrapper lines contain additional
unique contract/failure tests, so treating all wrapper lines as setup is an
upper bound. A review of the wrappers puts the parity slice at approximately:

- **40-45% backend/client setup and wrapper lifecycle**; and
- **55-60% shared scenario and behavior assertions**.

That means most of the substantive assertions in the strongest parity areas
are already parameterized, but client construction/migrations/cleanup are
not.

**Postgres integration suite as a whole.** The ten integration files total
1,827 lines. All ten repeat `.env`/`DATABASE_URL` discovery, nine define their
own migration helper or inline equivalent, and seven define essentially the
same deterministic 1536-dimensional string embedder. Each fixture-backed file
also repeats:

- opening a raw postgres.js admin client;
- applying/ignoring already-applied migrations;
- creating a database-URL client;
- generating unique entity IDs/prefixes;
- closing both clients; and
- deleting test memories/events.

In the six fixture-backed integration files, roughly 70-80% of each wrapper is
this Postgres harness and only a few lines invoke the shared behavior fixture.
Across all integration files, a reasonable physical-line estimate is that
about **40-50% is backend harness/setup/cleanup or lock-control machinery**.
The rest is a mix of shareable public behavior assertions and legitimately
Postgres-specific SQL/vector/cancellation assertions.

Relative to the complete 7,594-line test-plus-fixture corpus, the 1,827-line
integration layer is about 24%. It would be misleading to call all of that
duplication: several large integration sections are deliberately
Postgres-specific.

### 4.4 Existing parameterization groundwork and gaps

Existing groundwork:

- The nine cross-backend fixtures listed above accept a `MnemocyteClient`
  rather than constructing a backend themselves.
- `test/helpers.ts` centralizes typed error and defined-value assertions.
- `test/fixtures/retrieval-quality.ts` supplies shared retrieval cases to unit
  tests and benchmarks; the benchmark can optionally run Postgres.
- Vitest already separates unit, integration, and package projects.

What does not exist today:

- no common backend factory/adapter-test harness;
- no shared migration/setup/cleanup helper for Postgres integration files;
- no `describe.each`/backend matrix that can add a third store once and run a
  full contract suite;
- no public `MemoryStore` contract test package/export; and
- no SQLite test project, package, migration, driver, or fixtures.

## 5. Existing release and versioning tooling

### 5.1 Current release process

`AGENTS.md` defines releases as manual maintainer actions:

1. Validate with `pnpm checktypes`, `pnpm test`, and
   `pnpm run pack:check`.
2. Maintain release notes in the one root `CHANGELOG.md`.
3. Run `pnpm version patch` for a patch release (or minor/major when the
   change requires it). The guidance explicitly says not to create a second
   release commit because `pnpm version` handles the version commit and tag.
4. The maintainer manually publishes and creates the GitHub release. Agents
   must not publish packages, push tags, or create releases.
5. GitHub release titles use `mnemocyte vX.Y.Z`, and descriptions use one
   package-wide compare link.

The current repository state is slightly ahead of some maintainer documents:

- root `package.json` is `0.4.0`;
- `HEAD` is commit `a11ecf1` with subject `0.4.0`;
- annotated tag `v0.4.0` points at that commit; and
- `pnpm pack --dry-run` reports `mnemocyte@0.4.0`.

`docs/ARCHITECTURE.md` and `docs/PROJECT_MEMORY.md` still say `v0.3.0` is the
published release and the `v0.4.0` version bump/tag are pending. The local Git
and package evidence shows the bump/tag have occurred; this report cannot
establish npm/GitHub publication state from the local repository alone.

### 5.2 Automation/tooling that exists

- `.github/workflows/ci.yml` is validation-only:
  - Node 22.18 and 24 type/lint/test/pack gates;
  - a Postgres/pgvector integration job.
- `prepublishOnly` builds, type-checks, and dry-runs the package.
- npm provenance is requested through root `publishConfig`.
- Git tags follow one `vX.Y.Z` stream.
- `CHANGELOG.md` follows Keep a Changelog and has one version history and one
  set of compare links.

### 5.3 Automation/tooling that is absent

Repository-wide searches and the file tree show no:

- Changesets (`.changeset/` or `@changesets/*`);
- release-please;
- semantic-release;
- Lerna;
- Nx/Turborepo release/version tooling;
- npm publish or GitHub release workflow;
- per-package changelogs;
- workspace-recursive build/pack/publish scripts; or
- independent package tag/version convention.

### 5.4 Readiness for independently versioned packages

The current tooling does **not** already support independent package versions.
Real release-tooling rework would be required because:

- there is one version field, one package name, one `publishConfig`, one
  changelog, and one tag stream;
- `pnpm version` operates at the root package;
- build and pack scripts target one root `dist/` and one root `files` list;
- CI runs root commands rather than discovering/filtering packages;
- the lockfile has only one importer and the workspace manifest has no package
  globs;
- no tool records which package changed or calculates inter-package version
  ranges;
- no workflow packs/publishes multiple packages; and
- release guidance and GitHub release text assume exactly one changelog compare
  range.

The existing reusable pieces are validation conventions, ESM/strict
TypeScript expectations, changelog/release-writing conventions, and provenance
configuration. They are single-package conventions, not an independent
versioning system.

## Overall readiness picture

The codebase has meaningful adapter groundwork: shared client orchestration, a
named internal `MemoryStore`, two working implementations, explicit
migrations, strict package exports, and nine substantial shared backend
behavior fixtures.

It does not have monorepo/package-release groundwork beyond a minimal pnpm
workspace manifest. The root artifact still requires the Postgres stack at
module-load time, the internal contract and backend discriminator are not
public/third-backend-ready, several store responsibilities carry strong
transaction/search/cancellation semantics, integration setup is repeated, and
all publishing/versioning machinery assumes one package.

Those facts describe how much groundwork exists and how much does not; they do
not determine whether a monorepo, SQLite adapter, public adapter contract, or
peer-dependency model should be adopted.
