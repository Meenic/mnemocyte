# Codebase Cleanup, Approved Fixes, and Documentation Audit Summary

The original cleanup closed all 16 audit items: 13 were resolved and 3 were
deferred after documenting their reproductions and required policy choices.
The follow-up behavior run approved option 1 for each deferred item and has now
resolved all three. Each behavior fix was validated and committed separately.

The later consolidation-deletion policy run resolved only
`CONSOLIDATION-DELETE-01`, using the separately approved option 1 rejection
policy.

The subsequent vector-correctness run resolved four additional approved
high-risk proposals. Each issue was independently reproduced, implemented,
fully validated against real Postgres + pgvector, and committed before the next
fix began.

The 2026-07-20 consolidation-integrity run resolved only `CONSOLIDATION-03`
and `CONSOLIDATION-02`, in that order. Each fix was reproduced, implemented,
validated against both adapters including real Postgres + pgvector, and
committed before the next implementation began.

Counts, environment details, and scope statements in the older sections below
are snapshots of their named runs. The consolidation section immediately below
records the current run; the following section records the 2026-07-17
root-entry lazy Postgres loading run, and later sections retain their historical
scope.

## Caller-owned postgres.js Drizzle adapter

The `drizzleStore(db)` v1 design is now implemented for caller-supplied
postgres.js Drizzle instances. The new wildcard-backed
`mnemocyte/stores/drizzle` export constructs the existing Postgres
`MemoryStore` around a caller-owned `DatabaseHandle` whose required `close()`
callback is a no-op. `client.close()` therefore keeps its normal
operation-draining semantics without ending the application's postgres.js
connection.

`MnemocyteConfig.store` accepts a deliberately opaque
`MnemocyteStoreConfig`. This keeps the complete 18-method `MemoryStore`
interface internal while giving official adapter factories a narrow public
value to pass into `createMnemocyte()`. Supplying `store` together with
`databaseUrl` rejects synchronously with `"CONFIG"`; the existing URL-only and
no-config in-memory selection paths retain their prior behavior and validation
order.

The package now builds matching `dist/stores/drizzle.mjs` and
`dist/stores/drizzle.d.mts` artifacts from the same wildcard source/build/export
pattern used for embedder helpers. Future store entries require only another
`src/stores/*.ts` file. The root entry still has no static Drizzle or
postgres.js imports, and the packed in-memory consumer scenario continues to
run with both database packages absent. The v1 adapter is explicitly limited
to postgres.js, fixed Mnemocyte tables in the `public` schema, and databases
where the bundled migrations were already applied.

Integration coverage constructs a typed Drizzle instance with an unrelated
application schema, passes it through `drizzleStore(db)`, compares
`remember`/`recall` behavior with the `databaseUrl` path, closes both clients,
and executes another query through the original caller-owned instance. This is
the first real coverage proving that Mnemocyte does not take ownership of a
supplied connection.

The final wildcard-export state passed `pnpm checktypes`, `pnpm lint`, `pnpm
test`, `pnpm build`, `pnpm run pack:check`, and `pnpm run test:integration`
against the configured real Postgres + pgvector database. Unit/package
validation passed 34 files with 136 tests, and integration validation passed
12 files with 16 tests. Emitted-artifact inspection also confirmed the
`dist/stores/drizzle.mjs` / `.d.mts` pair, no obsolete flat Drizzle artifact,
and no static `drizzle-orm` or `postgres` import in `dist/index.mjs`.

## `MemoryStore` storage adapter contract documentation

The documentation track from the corrected stabilization proposal is complete
in
[`dafed57`](https://github.com/Meenic/mnemocyte/commit/dafed57fd706f14a7e502ede94486853bb331ffd).
`src/memory/store.ts` now states the verified postconditions for the 12
ship-ready methods, gives `vectorSearch`, `lexicalSearch`, and
`findDuplicatePairs` their distinct search framing, and records the
cross-cutting survivor-deletion, cancellation, and no-capability-flag rules.
The comments preserve the distinct-ID precondition for access updates,
best-effort and potentially partial audit batches, composite audit cursors,
untrusted insert return order, and caller-owned connection lifecycle.

`README.md` now has a scoped **Storage Adapter Contract** section for future
adapter authors and links to the source comments for full per-method detail.
The v3 design record has a short status note linking the implementation commit.
This pass changed documentation only: no runtime behavior, method signature,
return type, error code, public export, or capability surface changed.

The final state passed `pnpm checktypes`, `pnpm lint`, and `pnpm test` (34 test
files, 134 tests).

## Consolidation mutation integrity and duplicate-ID policy

The requested order was verified against the actual diff overlap and retained.
`CONSOLIDATION-03` changed the `MemoryStore.consolidate()` mutation contract,
shared orchestration's stale tag snapshot, both adapters, and the Postgres lock
query. `CONSOLIDATION-02` then added a distinct-ID precondition at shared
validation plus its contract and cross-backend coverage; it did not depend on
or restructure the corrected mutation sequence.

**CONSOLIDATION-03** landed first in
[`14748e5`](https://github.com/Meenic/mnemocyte/commit/14748e5429f87bd0ddf248be158f439231a2ed59).
A deterministic gate pauses each test call after shared survivor/loser
preflight and before `MemoryStore.consolidate()`. The failing-first run showed
in-memory consolidation succeeding after survivor deletion and Postgres
mapping the same race to generic `"DB"`. The shared fixture also exercises a
survivor superseded in that window and two concurrent same-survivor tag merges
in both adapters.

Both stores now re-read and protect the survivor together with requested-loser
checks and mutation. A missing or newly superseded survivor rejects with
`"CONFLICT"` before loser, survivor-tag, or audit changes. In-memory performs
the check and mutation in one non-interleaved synchronous block. Postgres locks
the survivor and requested losers in deterministic ID order inside the
transaction, and its tag union starts from the locked survivor row. Concurrent
successful tag merges therefore preserve every committed tag while loser
updates, tag changes, and enabled audit events continue to commit or roll back
together.

The proposal's file inventory included `migrations/0000_initial.sql`, but the
verified implementation required no schema rewrite: the existing explicit
`ON DELETE NO ACTION` self-reference remains the referential backstop, while
mutation-time row locking and state validation close the race. Real integration
tests applied the bundled migrations and exercised the transactional behavior.

**CONSOLIDATION-02** landed second in
[`e67b812`](https://github.com/Meenic/mnemocyte/commit/e67b8129ecc178b06cbcff1f4c7ed5f67f08ce2d).
Its failing-first shared fixture confirmed that both adapters accepted a
repeated loser ID: in-memory preserved the duplicate through target loading,
while Postgres deduplicated it through `WHERE id IN (...)`. Shared validation
now rejects duplicates with `"VALIDATION"` before either target loading or
mutation. The cross-backend fixture verifies the rejection leaves loser state,
survivor tags, and audit events unchanged, then confirms one valid transition
returns count one and one ID, writes one audit event, and remains an idempotent
zero-count retry.

Each implementation commit independently passed `pnpm checktypes`, `pnpm
lint`, `pnpm test`, `pnpm build`, `pnpm run pack:check`, and `pnpm run
test:integration` with the configured real Postgres + pgvector database. The
first commit passed 33 unit/package files with 133 tests and 11 integration
files with 15 tests. The second passed 34 unit/package files with 134 tests and
11 integration files with 15 tests; one unrelated integration test timed out
once, then passed in isolation and in the clean full-suite rerun.

Changes in this run are limited to `CONSOLIDATION-03`, `CONSOLIDATION-02`,
their focused tests and current-behavior documentation, the two matching
proposal approval/resolution records, and this summary. No other proposal was
implemented or changed. The unrelated pre-existing edit to
`docs/design/public-memorystore-stabilization-v3.md` was left untouched and
uncommitted.

## Lazy Postgres root-entry loading

The package root no longer loads `drizzle-orm`, `postgres`, or implementation
modules from `src/db/` when callers omit `databaseUrl`. `createMnemocyte`
retains its synchronous factory and performs the same embedder, retrieval,
provider, non-empty URL, URL parsing, and Postgres-protocol validation before
returning. A Postgres-configured client now wraps an internal lazy
`MemoryStore`; its first asynchronous store operation, including `close()`,
dynamically imports the Postgres runtime and constructs one shared database
handle.

The rebuilt `dist/index.mjs` imports only local driver-free chunks at module
scope and contains one dynamic import of the emitted `postgres-runtime` chunk.
All emitted `drizzle-orm` and `postgres` imports are confined to that chunk.
`src/memory/postgres-records.ts` already imported `MemoryRow` with
`import type`, so no source change was required there, and the built
declarations contain no runtime database-module reference.

Package coverage now creates a real `pnpm pack` tarball, extracts only
`mnemocyte` into an isolated consumer tree, verifies that `drizzle-orm` and
`postgres` are absent, and exercises in-memory `remember` and `recall` through
the packed root entry. The same driver-free consumer also verifies that an
invalid non-Postgres URL still throws `"CONFIG"` synchronously. The existing
configuration test confirms that a valid Postgres URL does not construct the
driver until an asynchronous store operation.

The final state passed `pnpm checktypes`, `pnpm lint`, `pnpm test` (32
unit/package files, 132 tests), direct emitted-module and declaration
inspection, `pnpm run pack:check`, and `pnpm run test:integration` against the
configured real Postgres + pgvector database (10 files, 14 tests).

Changes in this run are limited to `src/client.ts`, the shared
`src/database-url.ts` validator, the `src/db/index.ts` validator reuse,
`src/memory/lazy-postgres.ts`, `src/memory/postgres-runtime.ts`, focused config
and packed-package tests, the package-test include pattern in
`vitest.config.ts`, and this summary. Dependencies, migrations, public exports,
public types, API signatures, and documented public behavior are unchanged.
Synchronous configuration-validation timing is also unchanged, so
`CHANGELOG.md` was intentionally not edited. The recommended commit message is
`fix: lazily load Postgres without changing sync validation`.

## Consolidation target policy and documentation decisions

**CONSOLIDATION-01** was implemented in
[`c44c01d`](https://github.com/Meenic/mnemocyte/commit/c44c01dc27f4ee4759d526ef31954b9fcf3afc77).
Same-survivor retries remain zero-count no-ops, while a loser already assigned
to a different survivor rejects the whole call with `"CONFLICT"`. Both
adapters preflight mixed batches before changing loser state, survivor tags, or
audit events. Postgres locks requested loser rows inside its existing
transaction, so concurrent same-target calls yield one mutation and one no-op,
while concurrent different-target calls yield one mutation and one conflict.
The shared fixture enforces these rules in memory and against real Postgres +
pgvector.

The four former `DOCS-DEF` judgments are now resolved: the in-memory backend is
documented as a development/prototyping path whose duplicate scan degrades
noticeably beyond roughly a few thousand memories per entity; performance work
is ordered by correctness/data integrity, hot-path latency, write throughput,
then tooling/benchmarks; provider helpers stay on package subpaths until a
second provider or heavy/conflicting SDK triggers review; and the confirmed
adapter order is public `MemoryStore` stabilization, `drizzleStore(db)`, then
`@mnemocyte/mcp`. Subsequent `0.4.0` release preparation advanced the two
still-unshipped adapter targets to `0.5.0` and `0.6.0` without reordering them.

The final documentation sweep checked all 14 Markdown files against source,
tests, migrations, package metadata, CI, Git history, and the npm release
state. It corrected remaining historical-summary wording that still presented
`CONSOLIDATION-01` as open, distinguished published `v0.3.0` from the newer
`[Unreleased]` repository state, and verified every relative Markdown link and
referenced local commit.

The final combined state passed `pnpm checktypes`, `pnpm lint`, `pnpm test`
(31 unit/package files, 130 tests), `pnpm build`, `pnpm run pack:check`, and
`pnpm run test:integration` against the configured real Postgres + pgvector
database (10 files, 14 tests).

## Approved store, retrieval, audit, and context fixes

The dependency order was verified against the current code before editing and
matched the requested sequence:

1. **STORE-01** landed in
   [`ee557b4`](https://github.com/Meenic/mnemocyte/commit/ee557b47be698fefd96fbb0d386dd423bdde62ef).
   Shared orchestration now validates that batch inserts return exactly one
   known memory per prepared ID, rejects missing, duplicate, or unknown IDs
   with `"DB"`, and restores input order.
2. **RETRIEVAL-02** landed in
   [`caefcda`](https://github.com/Meenic/mnemocyte/commit/caefcda0485ab37d332fd5995b982ddb4d178dfc).
   Recall now patches selected results with the exact post-update
   `accessCount`, `lastAccessedAt`, and `updatedAt` returned by the store while
   retaining pre-access counts for ranking and explanations.
3. **AUDIT-01** landed in
   [`3a16c09`](https://github.com/Meenic/mnemocyte/commit/3a16c092ed425172a82d5b1dab2d4d95f5ce56a0).
   Prune store results now carry validated per-entity deletion counts, and
   shared orchestration emits one best-effort `"memory.pruned"` event per
   affected entity for both scoped and global non-dry runs.
4. **AUDIT-02** landed in
   [`dbe655e`](https://github.com/Meenic/mnemocyte/commit/dbe655ea622d4c2dc1d16ce7a130e6b8940e678f).
   The experimental `AuditLogCursor` and `beforeCursor` / `afterCursor` inputs
   page by `(timestamp, event ID)` with deterministic ordering and tuple
   comparisons. Timestamp-only `before` / `after` remain strict filters and
   are documented as incomplete cursors when timestamps tie.
5. **CONTEXT-01** landed in
   [`26b5beb`](https://github.com/Meenic/mnemocyte/commit/26b5beb2456a8ccf0453e3505e0dcaf992357e1f).
   Plain-text context now chooses a deterministic `=` fence longer than every
   run in the query, rendered metadata, and included content. Markdown and XML
   formatting were not changed.

Each issue was reproduced before implementation:

- STORE-01 let reversed results escape in store order and accepted missing,
  duplicate, and unknown returned IDs.
- RETRIEVAL-02 returned access count `0` on the first recall while both stores
  had already advanced it to `1`.
- AUDIT-01 deleted expired memories across two entities without attempting any
  prune audit write.
- AUDIT-02 skipped the remaining same-timestamp consolidation events with a
  timestamp-only page boundary; the Postgres reproduction also exposed the raw
  timestamp parameter binding in that query path.
- CONTEXT-01 produced eight apparent fixed boundary lines for two memories
  when adversarial content supplied its own start/end markers.

Every implementation commit independently passed `pnpm checktypes`,
`pnpm lint`, `pnpm test`, `pnpm build`, `pnpm run pack:check`, and
`pnpm run test:integration` using the configured real Postgres + pgvector
database. At the final implementation commit, the unit/package suite contained
30 passing files with 110 tests, and the integration suite contained 10
passing files with 14 tests.

Changes in that run were limited to STORE-01, RETRIEVAL-02, AUDIT-01,
AUDIT-02, CONTEXT-01, their focused tests, and current-behavior documentation.
No migration or default index was added. At that run's endpoint,
`CONSOLIDATION-01` still had blank approval and no resolution status; it was
subsequently approved and resolved in `c44c01d` as described above.

## Approved remember input, config, observability, and metadata fixes

The verified dependency order matched the requested sequence:

1. **INPUT-01** landed in
   [`33ba44a`](https://github.com/Meenic/mnemocyte/commit/33ba44a69a0848a71b6549e8eb4fd7badebed171).
   Single and batch remember calls now synchronously snapshot caller-owned
   tags, metadata, expiration dates, and primitive fields before awaiting
   provider or storage work.
2. **INPUT-02** landed in
   [`000043f`](https://github.com/Meenic/mnemocyte/commit/000043f9e5cc3104a8ce60376d18620141f2961b).
   Remember rejects unknown type/importance values, malformed tags/source
   values, and invalid expiration dates with `"VALIDATION"` before embedding
   or storage. Recall, duplicate-search, and prune type filters share the same
   runtime memory-type validation.
3. **CONFIG-01** landed in
   [`e586024`](https://github.com/Meenic/mnemocyte/commit/e58602487294d7c9a0b781f594809982ab761dd9).
   Provider timeout/delay values, retry counts, and retry predicates are now
   validated synchronously with `"CONFIG"`. The existing policy that raises
   `maxDelayMs` to `baseDelayMs` when needed remains supported.
4. **OBSERVABILITY-01** landed in
   [`e159618`](https://github.com/Meenic/mnemocyte/commit/e1596181d4b62d1963bb7abcdcb167d054a5a9f7).
   Remember preparation and validation failures now emit exactly one
   `"start"` and one `"error"` event carrying the same thrown value. Input
   snapshots still complete before awaiting user hooks, and closed-client
   errors retain precedence over malformed input.
5. **REFACTOR-01** landed in
   [`a2fcf8b`](https://github.com/Meenic/mnemocyte/commit/a2fcf8b5f27a39d5f7d6c8c5b5fbaa5b2942f693).
   An internal validated/owned JSON type now carries remember metadata through
   record construction and storage. Single and batch writes perform one
   validating ingress traversal and one detached public-egress traversal per
   memory in both adapters; audit events retain one adapter-ingress clone and
   one public-egress clone.

Each issue was reproduced before implementation:

- INPUT-01 stored tags and dates mutated while a gated embedder was pending in
  both adapters.
- INPUT-02 accepted and persisted an unknown memory type instead of rejecting
  before provider/storage work.
- CONFIG-01 with `retries: NaN` called the provider zero times and surfaced an
  `"EMBEDDING"` error with no cause instead of rejecting construction.
- OBSERVABILITY-01 produced no operation events for cyclic metadata during
  synchronous remember preparation.
- REFACTOR-01 traversed one memory metadata object six times between public
  ingress and the returned remember result in both adapters.

Every implementation commit independently passed `pnpm checktypes`,
`pnpm lint`, `pnpm test`, `pnpm build`, `pnpm run pack:check`, and
`pnpm run test:integration` using the configured real Postgres + pgvector
database. The final implementation gate contained 26 passing unit/package
files with 99 tests and six passing integration files with ten tests.

The metadata refactor removed only traversals covered by the explicit ownership
contract and instrumentation. Recall scoring and duplicate-pair mapping retain
their separate clones because their multi-candidate ownership paths were not
proven redundant.

Changes in that run were limited to INPUT-01, INPUT-02, CONFIG-01,
OBSERVABILITY-01, REFACTOR-01, their tests and current-behavior documentation,
the five matching proposal approvals/statuses, and this summary.
`CONSOLIDATION-01` was not modified during that run; it was implemented later
in `c44c01d`.

## Consolidation survivor deletion policy

**CONSOLIDATION-DELETE-01** landed in
[`a95d641`](https://github.com/Meenic/mnemocyte/commit/a95d64187e120eacec857f1bed9fcdfd5e525a43).
Both storage adapters now reject deletion of a memory while another memory's
`supersededBy` points to it, using the public `"CONFLICT"` error code.

The in-memory adapter checks the complete candidate set before mutation.
Postgres uses one guarded candidate/dependent/delete statement so `forgetAll`
and multi-row prune operations cannot partially delete, while its existing
`ON DELETE NO ACTION` self-reference remains a race-condition backstop.
Deleting an ordinary memory or a superseded loser remains valid, and deleting
the survivor succeeds after its dependents are removed.

One shared behavioral fixture runs against both adapters. It covers
`forget(survivor)`, `forgetAll` selecting both sides, an expired-memory prune
that also selects an unrelated row, dry-run preview, loser deletion, and
ordinary deletion. The rejection cases verify that every row remains and the
loser's `supersededBy` pointer is unchanged.

The final implementation state passed `pnpm checktypes`, `pnpm lint`,
`pnpm test` (23 unit/package files, 94 tests), `pnpm build`,
`pnpm run pack:check`, and `pnpm run test:integration` (five files, seven
tests) using the configured real Postgres + pgvector database.

Implementation, tests, public types, README, architecture, changelog,
maintainer memory, the `CONSOLIDATION-DELETE-01` status, and this summary were
the only changes. No other `PROPOSALS.md` entry was modified or implemented,
and consolidation itself was not changed during that deletion-policy run.
Survivor-specific consolidation behavior changed later in `c44c01d`.

## Approved vector correctness and compatibility fixes

The verified implementation order matched the requested order:

1. **SERIALIZATION-01** landed in
   [`5d779c0`](https://github.com/Meenic/mnemocyte/commit/5d779c0b372185f56b15142d21e0a017c3390742).
   Postgres inserts and raw query-vector literals now share a shortest
   round-trip-safe finite-number formatter, preserving tiny nonzero components
   through pgvector's float4 conversion.
2. **EMBED-01** landed in
   [`1e8a512`](https://github.com/Meenic/mnemocyte/commit/1e8a51233081bf9607431c85fab8aeb68c454cb7).
   Shared embedding validation rejects exact zero-norm vectors with
   `"EMBEDDING"` before storage, recall, or duplicate comparison while
   retaining valid tiny nonzero vectors.
3. **RETRIEVAL-01** landed in
   [`542cf4c`](https://github.com/Meenic/mnemocyte/commit/542cf4c8c40fa1e9c8a816378ab39caad2d74a28).
   Both `MemoryStore` adapters now expose a finite vector component clamped to
   `[0, 1]`; Postgres applies candidate cutoffs to that component, while public
   `minScore` remains a shared final fused-score filter.
4. **EMBED-02** landed in
   [`e0b80a5`](https://github.com/Meenic/mnemocyte/commit/e0b80a5ec0bca2cb77f0a5d778f9d1e5c6530f93).
   Postgres now records installation-level embedding-model identity alongside
   dimensions. Writes, recall, and duplicate scans validate both before
   provider use or vector comparison. Migration `0002_add_embedding_model.sql`
   records one unambiguous historical model; mixed history remains unset and
   fails with `"MIGRATION"` until explicit operator repair.

The dependency order was checked against the actual code before work began and
again between fixes. Serialization had to precede zero-norm rejection because
the old formatter could manufacture false zero vectors from legitimate tiny
components. RETRIEVAL-01 shared the scorer and Postgres query layer but was
otherwise independent, so it followed the settled embedding-validation rule.
EMBED-02 remained last because it introduced the schema migration and depended
on the vector serialization path already being stable.

The failing behavior was reproduced separately before each implementation:

- SERIALIZATION-01 formatted `1e-20` as fixed-decimal zero and stored a public
  Postgres embedding with that component as zero.
- EMBED-01 accepted exact zero vectors; pgvector produced `NaN` cosine behavior,
  and duplicate search could return a reported similarity below its requested
  threshold.
- RETRIEVAL-01 returned a negative-cosine candidate from the in-memory backend
  with vector score `0` and a positive fused score, while Postgres removed the
  same candidate before fusion.
- EMBED-02 let a same-dimension model-B client recall model-A data and compare
  model-A/model-B rows as duplicates.

Each fix passed `pnpm checktypes`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm run pack:check`, and `pnpm run test:integration` with a real Postgres 17
database running pgvector before its commit. The final implementation state
contains 22 passing unit/package files with 92 tests and four passing
integration files with six real Postgres tests. A separate pre-`0002`
migration check confirmed that one historical model is recorded and mixed
historical models remain unset.

During that vector-only run, implementation and documentation changes were
limited to SERIALIZATION-01, EMBED-01, RETRIEVAL-01, and EMBED-02. No other
proposal was implemented or modified; specifically,
`CONSOLIDATION-DELETE-01` was not touched or resolved.

## Approved proposal execution

The three newly approved high-risk proposals were implemented in verified
dependency order and committed independently:

1. **LIFECYCLE-01** landed in
   [`e91e4e7`](https://github.com/Meenic/mnemocyte/commit/e91e4e7734ac724f234add514dfa6d1b5d52ec10).
   The shared client lifecycle now rejects new operations after closing starts,
   waits for admitted operations before closing the store, shares concurrent
   close calls, and reopens admission if store close fails so a retry is
   possible.
2. **CANCELLATION-01** landed in
   [`1591a92`](https://github.com/Meenic/mnemocyte/commit/1591a92e3323de2fe977d1a75cc67fe089c6df59).
   Maintenance-operation signals now cross the internal `MemoryStore`
   boundary. In-memory scans check cooperatively; standalone Postgres prune,
   duplicate-search, and audit-log queries use postgres.js cancellation.
   Consolidation checks between transactional steps and before its transaction
   callback returns. An in-flight statement may finish before rollback, and an
   abort after the final check, including during commit, may still leave the
   transaction committed.
3. **PRUNE-01** landed in
   [`e99a1d3`](https://github.com/Meenic/mnemocyte/commit/e99a1d3c15ace4feb3af9e3c0249d4c64288217e).
   Public prune input is exhaustively validated and normalized before store
   access. Both adapters receive only the internal validated filter and reject
   an empty internal filter before scanning or issuing SQL.

The order was deliberate. Lifecycle admission is the shared orchestration
foundation; cancellation builds on that operation boundary and extends the
storage contract; prune validation then narrows the destructive store input
without conflating malformed selectors with lifecycle or cancellation
behavior.

Each documented issue was reproduced before its implementation:

- LIFECYCLE-01 allowed `close()` to complete while a gated `remember()` later
  inserted and resolved successfully.
- CANCELLATION-01 allowed one pre-aborted signal to preview prune results,
  return duplicate pairs and audit events, and complete consolidation.
- PRUNE-01 let an invalid date delete all in-memory rows while Postgres failed
  with `"DB"`, and an unknown `maxImportance` value produced an unbounded
  delete in both backends.

Each fix passed `pnpm checktypes`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm run pack:check`, and `pnpm run test:integration` against a real
Postgres 17 + pgvector database before its commit. The final implementation
suite contains 22 unit/package files with 78 tests, plus two passing real
Postgres integration scenarios.

Implementation and documentation changes were limited to LIFECYCLE-01,
CANCELLATION-01, and PRUNE-01. No other proposal was implemented. The only
additional repository changes are the requested retained-proposal status links
and this summary update.

## Approved behavior fixes

The implementation order was BUG-03, BUG-02, then BUG-01. This was verified
against the actual file overlap before editing:

1. **BUG-03 — metadata semantics** touched the deepest shared surface: public
   types, JSON validation/cloning, memory records, database schema typing, both
   storage adapters, client orchestration, and package/integration tests. It
   landed first in
   [`43baf7d`](https://github.com/Meenic/mnemocyte/commit/43baf7d86c60e4563dbbf80924cd4eb79ea7b7ff).
2. **BUG-02 — tuning validation** built on the shared validation boundary and
   then changed constructor and `buildContext` rejection behavior. It landed
   second in
   [`51cae0d`](https://github.com/Meenic/mnemocyte/commit/51cae0d8afc8d36039ffa4f7aa8b331ae18efd1f).
3. **BUG-01 — batch cancellation** was the narrowest change, limited to the
   public batch input shape, batch orchestration, compatibility typing, and
   focused cancellation coverage. It landed third in
   [`cf79854`](https://github.com/Meenic/mnemocyte/commit/cf798545f6c9b023e64a7fb5275c69cb91df3dae).

Before implementation, each historical reproduction in `BUGS_FOUND.md` was
rerun against the starting branch and failed for its documented reason. The
updated tests now enforce the approved behavior rather than merely checking
that the old failure disappeared.

No behavior, refactor, dependency, schema migration, or feature outside these
three approved items was added. The positional `rememberMany(inputs)` overload
was retained as a deprecated pre-v1 compatibility path; it was not silently
removed.

## Dead code removed

- Removed unused `getSignal`, single-memory insert/list queries,
  entity-event deletion, standalone lexical scoring, and legacy scored-memory
  helpers.
- Removed the private filter and imports that became orphaned with those
  helpers.
- Verified that none of the removed symbols were part of the package root or
  embedder subpath exports.

## Refactors

- Replaced the mixed `memory/shared.ts` module with focused defaults,
  embeddings, filters, records, Postgres-record mapping, and validation modules.
- Centralized public-memory cloning so storage and retrieval share one mapping.
- Centralized precise pgvector component serialization in `db/vector.ts`.
- Renamed the batch access-update query to `markMemoriesAccessed` for cardinality
  consistency.

## Test improvements

- Added failing-first coverage for non-finite single/batch embeddings, explicit
  empty and malformed database URLs, empty embedder models, and in-memory audit
  retention after close.
- Added direct pgvector serialization coverage for precision, negative zero,
  and all non-finite number categories.
- Updated the Postgres retrieval benchmark to apply current metadata migration
  state without overwriting an existing custom dimension.
- The unit/package suite grew from 14 files/29 tests at baseline to 18 files/40
  tests.

## Documentation fixes

- Added a complete clone/install/watch/build/test contributor path and source
  responsibility map to `README.md`.
- Removed shipped milestone checklists from the forward-looking roadmap and,
  at that cleanup checkpoint, updated performance sequencing to the then-
  unreleased `0.3.0` line.
- Corrected token-heuristic, error-guard, audit-write, dimension-validation, and
  removed-helper descriptions.
- Updated architecture, changelog, roadmap, performance, and maintainer memory
  where their current facts changed.

## Documentation audit and root move

The documentation-only audit moved every root Markdown file except `AGENTS.md`,
`README.md`, and the follow-up-requested root `CHANGELOG.md` into `docs/` with
`git mv`. The final Markdown inventory and evidence checklist live in
[DOCS_AUDIT.md](./DOCS_AUDIT.md). Changes and reference updates are grouped by
file:

- **`AGENTS.md`:** Kept at root; updated required-reading and documentation-rule
  paths to `docs/`, and corrected `MemoryStore` from wholly planned to an
  existing internal boundary with a future public contract.
- **`README.md`:** Kept at root; redirected architecture and roadmap links to
  `docs/`, corrected per-attempt timeout and embedding-dependent dimension
  validation wording, and made the canonical and compatibility
  `rememberMany` signal behavior executable and explicit.
- **`docs/ARCHITECTURE.md`:** Moved from root; corrected unreleased API status,
  Node declarations/support, module and public-type maps, internal filter array
  mutability, migration prerequisite, metadata write order, dimension-check
  scope, remaining production work, and the current `0.3.0` implementation
  boundary.
- **`docs/BUGS_FOUND.md`:** Moved from root; historical reproductions,
  resolutions, API behavior, and commit links were source- and test-verified
  without factual edits.
- **`CHANGELOG.md`:** Kept at root by follow-up request; only `[Unreleased]` was
  corrected to distinguish the API-preserving internal store refactor from the
  separate breaking changes. Published history and compare links were left
  unchanged.
- **`docs/CODEBASE_AUDIT.md`:** Moved from root; labeled its dated cleanup
  checkpoint, corrected current `MemoryStore` and `rememberMany` evidence, and
  redirected root `README.md` / `AGENTS.md` path references.
- **`docs/NEEDS_HUMAN_INPUT.md`:** Moved from root; approved decisions,
  implemented behavior, errors, public types, compatibility choice, and commit
  links were verified without factual edits.
- **`docs/PERFORMANCE_REVIEW.md`:** Moved from root; removed resolved tuning
  semantics from the outstanding architecture follow-ups after verifying the
  implementation paths, query shapes, benchmarks, and remaining risks.
- **`docs/PROJECT_MEMORY.md`:** Moved from root; corrected metadata grammar,
  the complete positive-integer `maxTokens` rule, internal/public `MemoryStore`
  status, release-prep status, and root README/AGENTS paths.
- **`docs/ROADMAP.md`:** Moved from root; current and planned feature status,
  names, migration direction, and links were verified without factual edits;
  future version sequencing remained planning intent at that checkpoint. The
  `0.4.0` / `0.5.0` sequence was confirmed by maintainer direction on
  2026-07-17, then superseded later that day when `0.4.0` was allocated to the
  prepared hardening release and the adapter targets advanced to `0.5.0` /
  `0.6.0`.
- **`docs/SUMMARY.md`:** Moved from root and updated with this grouped account;
  its earlier cleanup, fix sequencing, commits, and behavior scope were checked
  against Git history and the current branch.
- **`docs/DOCS_AUDIT.md`:** Added as the complete final-file checklist, move and
  old-path verification record, evidence summary, and Deferred register.

## Config changes

- Made `pnpm lint` a read-only Biome formatting/lint/import gate that fails on
  warnings, with `pnpm lint:fix` owning safe write mode.
- Aligned `@types/node` with the Node 22 support floor; the lockfile resolves
  version 22.20.1.
- Verified `pnpm install --frozen-lockfile` against the final lockfile.

## Bugs found

Resolved during cleanup:

- Non-finite embedding components could reach storage or scoring.
- Empty/malformed database URLs and empty embedder models produced inconsistent
  backend selection or error categories.
- Closing the in-memory store retained audit metadata.

The three formerly deferred findings remain documented with their historical
reproductions in [BUGS_FOUND.md](./BUGS_FOUND.md), and each is now marked
resolved with a link to its behavior commit.

## Needs human input

[NEEDS_HUMAN_INPUT.md](./NEEDS_HUMAN_INPUT.md) records seven resolved
decisions. The original three behavior entries are:

- Use one explicit batch-level cancellation signal.
- Reject invalid tuning with typed configuration/validation errors.
- Define metadata as JSON-compatible persisted value data, validate it, and
  deep-clone it at ingress and egress.

The four later documentation entries settle in-memory duplicate scale,
performance priority, provider packaging, and adapter milestone sequencing.
No entry currently remains open.

## Validation

The complete required gate passed after each behavior fix and again after the
documentation audit:

- `pnpm checktypes`
- `pnpm lint` (66 files, no fixes or warnings)
- `pnpm test` (20 files, 71 tests)
- `pnpm build`
- `pnpm run pack:check`
- `pnpm run test:integration` (entrypoint passed; its one Postgres scenario
  skipped because `DATABASE_URL` is not set locally)

At that documentation-audit snapshot, the checks found 12 Markdown files, no
broken local links, only `AGENTS.md`, `README.md`, and `CHANGELOG.md` at root,
and no old root-doc path in source, tests, package metadata, CI, migrations, or
scripts. Repository changes in that run were limited to Markdown moves,
corrections, and the new audit file.

The host runtime used for that audit was Node 22.17, below the declared
`>=22.18` engine, so nested pnpm invocations emitted an engine warning even
though all commands exited successfully. CI continues to cover Node 22.18 and
Node 24.

## Approved low-risk fixes

The three approved low-risk proposals were implemented one at a time in the
requested order:

1. **CONTEXT-02 — hard context token budgets** was reproduced with
   `maxTokens: 1` returning an eight-token marker, then fixed and committed in
   [`47931e2`](https://github.com/Meenic/mnemocyte/commit/47931e216640be2025bb2576f655b18afe481b94).
   Focused coverage now checks tiny budgets across Markdown, plain text, and
   XML with the default heuristic, character counting, and a counter where
   even one character exceeds the budget.
2. **CONFIG-02 — Postgres URL protocols** was reproduced with HTTP(S) and file
   URLs creating a database handle, then fixed and committed in
   [`da1bea9`](https://github.com/Meenic/mnemocyte/commit/da1bea9d44aa4fe30a68b33bc9dabfa0472faf40).
   Construction now accepts `postgres:` and `postgresql:` while rejecting
   other protocols with `"CONFIG"` before postgres.js is called.
3. **OPENAI-01 — embedding response indices** was reproduced with the
   documented duplicate-index payload silently overwriting a result, then
   fixed and committed in
   [`021c1e4`](https://github.com/Meenic/mnemocyte/commit/021c1e4aee63de415b85cefa238fb6bf44cf1ee0).
   Response validation now rejects count mismatches, duplicate or invalid
   indices, non-array data, malformed items, and non-array embeddings before
   restoring valid out-of-order results.

Each fix passed `pnpm checktypes`, `pnpm lint`, `pnpm test`, `pnpm build`,
`pnpm run pack:check`, and `pnpm run test:integration` before its separate
commit. The same complete gate passed again on the final combined state,
including 30 unit/package test files with 129 tests and 10 live Postgres
integration files with 14 tests.

Changes in that run were limited to `CONTEXT-02`, `CONFIG-02`, `OPENAI-01`,
their focused tests and current-behavior documentation, the three matching
proposal approval/resolution records, and this summary update. No other
`PROPOSALS.md` entry was implemented or changed during that run.
`CONSOLIDATION-01` was implemented later in `c44c01d`.
