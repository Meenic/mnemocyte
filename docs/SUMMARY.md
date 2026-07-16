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

Counts, environment details, and scope statements in the older sections below
are snapshots of their named runs. The consolidation-deletion section above is
the latest completed implementation snapshot in this document.

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
and consolidation itself was not changed.

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
  future version sequencing remains explicitly planning intent.
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

[NEEDS_HUMAN_INPUT.md](./NEEDS_HUMAN_INPUT.md) records the approved option 1
decision and resolution commit for each item:

- Use one explicit batch-level cancellation signal.
- Reject invalid tuning with typed configuration/validation errors.
- Define metadata as JSON-compatible persisted value data, validate it, and
  deep-clone it at ingress and egress.

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
