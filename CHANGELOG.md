# Changelog

All notable changes to `mnemocyte` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
package is pre-1.0; minor versions (`0.x.0`) may contain additive or
behavioural changes documented in their entries.

## [Unreleased]

### Changed

- **Postgres recall transfers narrower result rows.** Vector and lexical
  candidate queries no longer return stored embeddings in their main result
  sets; lexical-only candidates fetch embeddings through a narrow follow-up
  lookup only when JS-side cosine rescoring needs them.
- **Postgres `stats()` aggregates in SQL.** Entity and global stats now use
  conditional aggregate queries instead of materializing full memory rows in
  JavaScript.
- **Documentation now matches the shipped schema and driver path.** README,
  architecture, roadmap, and performance notes now describe the actual HNSW,
  full-text, embedder-dimension, postgres.js, and retry behavior.
- **Retrieval benchmarks now cover scale curves.** `bench:retrieval` runs
  multiple in-memory sizes and optional Postgres cases when `DATABASE_URL` is
  configured.
- **Recall scoring avoids repeated per-candidate setup.** Recall paths now
  precompute lexical query terms and normalized retrieval weights once per
  request.

### Fixed

- **Postgres consolidation honors audit opt-in.** `"memory.superseded"` audit
  events are only written when `audit.enabled` is true, matching the in-memory
  backend and README contract.
- **`buildContext` no longer depends on method `this` binding.** Both backends
  close over the client object when delegating to `recall`.
- **Postgres `stats()` has broader parity coverage.** Integration assertions
  now cover empty, active, expired, superseded, pruned, deleted, entity, and
  global stats scenarios.
- **Postgres tag filters bind text arrays correctly.** Raw SQL recall and
  duplicate-detection paths now pass requested tags as `text[]` values.
- **Postgres raw recall rows preserve timestamp semantics.** Timestamp fields
  returned from raw SQL candidate queries are normalized to `Date` instances
  before scoring and output.
- **Postgres tooling loads `.env` when present.** `drizzle.config.ts` and
  `test:integration` now pick up `DATABASE_URL` from `.env` if it is not
  already set in the process environment.
- **Migrations now use Drizzle-native format.** Replaced hand-written SQL
  migration with Drizzle-generated migration for better schema sync and
  maintainability.

## [0.1.2] — 2026-05-20

### Changed

- **`rememberMany` batches embedding and insert.** Both backends now call
  `embedder.embed()` once for all texts and the Postgres backend performs a
  single batch `INSERT`, reducing N sequential network round-trips to 1.
- **Hybrid recall computes real scores for non-overlapping candidates.**
  Vector-only results now get a JS-side lexical score and lexical-only
  results get a cosine similarity from the stored embedding, instead of
  defaulting to 0.
- **`buildContext` uses binary search for token-budget fitting.** Reduced
  from O(N) to O(log N) `tokenCounter.count()` calls.
- **`experimental.consolidate` mutations are transaction-wrapped.** The
  `markMemoriesSuperseded`, audit event inserts, and `setMemoryTags` calls
  now execute inside a single `db.transaction()` for ACID safety.

### Added

- `embedMany()` batch embedding helper in `memory/shared.ts`.
- `insertMemories()` batch insert query in `db/queries/memories.ts`.

## [0.1.1] — 2026-05-14

### Fixed

- Postgres recall/buildContext tag filters now require all requested tags,
  matching the public types and in-memory backend.
- pgvector insert and query literals now reject non-finite values and avoid
  scientific notation.
- Context output now uses explicit Markdown/plain text boundaries and trims
  whole ranked memories before falling back to string-level token truncation.
- README, architecture, and roadmap wording now match the current HNSW
  migration, passive dedup/conflict-detection status, and Neon driver plan.

## [0.1.0] — Phase 5 hardening + Phase 6 consolidation tooling

First milestone release. Phase 5 (production hardening) and the first
three Phase 6 items (passive duplicate detection, audit log, active
consolidation) are complete and stable enough to publish as a
coherent surface.

### Added — public API

- **Provider resilience** (`MnemocyteConfig.provider`): `timeoutMs`,
  `retries`, `baseDelayMs`, `maxDelayMs`, `shouldRetry`. Applied to every
  embedder call. Defaults are no-op.
- **`AbortSignal` cancellation** on `remember`, `rememberMany`, `recall`,
  `buildContext`, `prune`, `findDuplicates`, `listAuditLog`, and
  `experimental.consolidate`. Throws `MnemocyteError` code `"ABORTED"`.
- **Observability hooks** (`MnemocyteConfig.observability.onEvent`):
  `start` / `success` / `error` events for every state-changing or
  read operation, with `backend`, `operation`, `entityId`, `memoryId`,
  `count`, `durationMs`. New `MnemocyteOperation` values:
  `"prune"`, `"findDuplicates"`, `"listAuditLog"`, `"consolidate"`.
- **`client.prune(input)`**: bulk-delete by `entityId` / `expired` /
  `superseded` / `createdBefore` / `notAccessedSince` / `types` / `tags` /
  `maxImportance`, with `dryRun` preview. Rejects `prune({})` with code
  `"VALIDATION"` to avoid accidental full deletion.
- **`client.findDuplicates(input)`**: read-only pairwise cosine scan,
  threshold + limit + filters, returns `DuplicatePair[]`. *Experimental.*
- **`client.listAuditLog(input)`** + **`MnemocyteConfig.audit.enabled`**:
  opt-in audit log of state changes, persisted to `mnemocyte_events` (or
  an in-memory array). Slugs: `"memory.created"`, `"memory.deleted"`,
  `"entity.cleared"`, `"memory.pruned"`, `"memory.superseded"`.
  *Experimental.*
- **`client.experimental.consolidate(input)`**: mark loser memories as
  superseded by a survivor; idempotent for already-superseded losers;
  optional tag merge; emits `"memory.superseded"` audit events.
  *Experimental.*
- **Public types**: `ProviderResilienceConfig`, `PruneInput`,
  `PruneResult`, `FindDuplicatesInput`, `DuplicatePair`, `AuditConfig`,
  `AuditEvent`, `ListAuditLogInput`, `ConsolidateInput`,
  `ConsolidateResult`, `ExperimentalMnemocyteClient`.
- **Public type field**: `Memory.supersededAt: Date | null`, set whenever
  `supersededBy` is set.
- **New error codes**: `"TIMEOUT"`, `"ABORTED"`.

### Changed — behaviour

- `forgetAll` no longer cascade-deletes the audit log. The trail is
  sticky; wiping an entity is itself a recorded `"entity.cleared"`
  event.
- `createMnemocyte` now validates `embedder.dimensions === 1536` when a
  `databaseUrl` is supplied, throwing `MnemocyteError` code `"CONFIG"`
  before opening the connection pool. Previously the embedder mismatch
  surfaced as a confusing SQL error at first insert.
- Postgres `forgetAll` surfaces the deletion count via the observability
  `count` metadata to match the in-memory backend.

### Fixed

- `Memory.id` JSDoc no longer claims the Postgres backend uses a UUID;
  both backends emit `mem_*` prefixed IDs.
- `lifecycle/close.test.mjs` now covers every public method, including
  `findDuplicates`, `listAuditLog`, and `experimental.consolidate`.

### Removed

- `useDatabase` helper from `src/db/index.ts`. It was never re-exported
  from `mnemocyte` and is unused internally.

### Tooling

- New tests: `test/resilience`, `test/prune`, `test/lifecycle`,
  `test/dedup`, `test/audit`, `test/consolidate`. CI runs them all.
- Postgres integration test (`test/integration/postgres.test.mjs`)
  exercises the full happy path: `remember` → `rememberMany` → `recall`
  → `findDuplicates` → `experimental.consolidate` → `buildContext`
  → `listAuditLog` → `prune` → `forgetAll`, plus observability event
  coverage assertions.
- `pnpm pack:check` replaces the unsupported `pnpm pack --dry-run`.

### Docs

- `README.md`: new sections for provider resilience, pruning, finding
  duplicates, audit log, and consolidating duplicates. Postgres section
  documents the 1536-d embedder constraint.
- `ARCHITECTURE.md`: refreshed module structure, public surface map for
  0.1.0, refreshed error-code list, new "Known limitations" section.

## [0.0.8] — 2026-05-13

- Pre-Phase-6 audit fixes: stale checklist flipped, `Memory.id` JSDoc
  corrected, Postgres `forgetAll` symmetry, lifecycle test for
  `assertOpen` after `close()`.

## [0.0.7] — 2026-05-13

- Provider retries, timeouts, and `AbortSignal` cancellation plumbed
  through `remember` / `recall` / `buildContext`. New error codes
  `"TIMEOUT"` and `"ABORTED"`. CI matrix raised to Node 22.18 / 24.

## [0.0.6] — 2026-05-13

- Observability hooks: `MnemocyteConfig.observability.onEvent` + public
  `MnemocyteObservation` types.

## [0.0.5] — earlier

- Package export smoke tests + `test:exports`.

## [0.0.4] — earlier

- Context builder (`buildContext`) with markdown / plain / xml formats,
  XML escaping, and a pluggable `TokenCounter`.

## [0.0.3] — earlier

- Retrieval scoring improvements and quality fixtures.

## [0.0.2] — earlier

- MVP public API (`remember`, `recall`, `forget`, `forgetAll`, `stats`)
  with in-memory and Postgres + pgvector backends.

## [0.0.1] — earlier

- Initial project setup.

[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Meenic/mnemocyte/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Meenic/mnemocyte/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Meenic/mnemocyte/compare/v0.0.8...v0.1.0
[0.0.8]: https://github.com/Meenic/mnemocyte/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/Meenic/mnemocyte/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/Meenic/mnemocyte/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/Meenic/mnemocyte/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/Meenic/mnemocyte/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Meenic/mnemocyte/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Meenic/mnemocyte/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Meenic/mnemocyte/releases/tag/v0.0.1
