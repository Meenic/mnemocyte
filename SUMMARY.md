# Codebase Cleanup Summary

All 16 audit items are closed: 13 were resolved and 3 were explicitly deferred
after documenting their reproductions, policy choices, and recommendations.
Each audit item was committed separately after its project validation gate.

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

Deferred behavioral findings are reproduced in [BUGS_FOUND.md](./BUGS_FOUND.md):

- `rememberMany` observes only the first input's cancellation signal.
- Runtime tuning accepts numeric values that can disable budgets, corrupt
  scores, or produce invalid candidate limits.
- Nested in-memory metadata aliases caller/result objects and does not share
  Postgres JSONB serialization semantics.

## Needs human input

[NEEDS_HUMAN_INPUT.md](./NEEDS_HUMAN_INPUT.md) records the recommended policy
for each deferred item:

- Use one explicit batch-level cancellation signal.
- Reject invalid tuning with typed configuration/validation errors.
- Define metadata as JSON-compatible persisted value data, validate it, and
  deep-clone it at ingress and egress.

## Validation

The final gate passed with the supported bundled Node 24 runtime:

- `pnpm checktypes`
- `pnpm lint` (63 files, no fixes or warnings)
- `pnpm test` (18 files, 40 tests)
- `pnpm build`
- `pnpm run pack:check`
- `pnpm run test:integration` (entrypoint passed; its one Postgres scenario
  skipped because `DATABASE_URL` is not set locally)

The host's default Node 22.17 remains below the declared `>=22.18` engine and
emits a warning in nested pnpm invocations; CI covers Node 22.18 and Node 24.
