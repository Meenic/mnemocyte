# Codebase Cleanup and Approved Fixes Summary

The original cleanup closed all 16 audit items: 13 were resolved and 3 were
deferred after documenting their reproductions and required policy choices.
The follow-up behavior run approved option 1 for each deferred item and has now
resolved all three. Each behavior fix was validated and committed separately.

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

The complete required gate passed after each behavior fix and again on the
final state:

- `pnpm checktypes`
- `pnpm lint` (66 files, no fixes or warnings)
- `pnpm test` (20 files, 71 tests)
- `pnpm build`
- `pnpm run pack:check`
- `pnpm run test:integration` (entrypoint passed; its one Postgres scenario
  skipped because `DATABASE_URL` is not set locally)

The available bundled/host runtime is Node 22.17, below the declared `>=22.18`
engine, so nested pnpm invocations emit the existing engine warning even though
all commands exit successfully. CI continues to cover Node 22.18 and Node 24.
