# Codebase Cleanup, Approved Fixes, and Documentation Audit Summary

The original cleanup closed all 16 audit items: 13 were resolved and 3 were
deferred after documenting their reproductions and required policy choices.
The follow-up behavior run approved option 1 for each deferred item and has now
resolved all three. Each behavior fix was validated and committed separately.

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
- Removed shipped milestone checklists from the forward-looking roadmap and
  updated performance sequencing to the current unreleased `0.3.0` line.
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

The final documentation checks found 12 Markdown files, no broken local links,
only `AGENTS.md`, `README.md`, and `CHANGELOG.md` at root, and no old root-doc
path in source, tests, package metadata, CI, migrations, or scripts. Repository
changes are limited to Markdown moves, corrections, and the new audit file.

The available bundled/host runtime is Node 22.17, below the declared `>=22.18`
engine, so nested pnpm invocations emit the existing engine warning even though
all commands exit successfully. CI continues to cover Node 22.18 and Node 24.
