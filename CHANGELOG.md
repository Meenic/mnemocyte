# Changelog

All notable changes to `mnemocyte` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
package is pre-1.0; minor versions (`0.x.0`) may contain additive or
behavioural changes documented in their entries.

## [Unreleased]

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

[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Meenic/mnemocyte/compare/v0.0.8...v0.1.0
[0.0.8]: https://github.com/Meenic/mnemocyte/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/Meenic/mnemocyte/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/Meenic/mnemocyte/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/Meenic/mnemocyte/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/Meenic/mnemocyte/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/Meenic/mnemocyte/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/Meenic/mnemocyte/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/Meenic/mnemocyte/releases/tag/v0.0.1
