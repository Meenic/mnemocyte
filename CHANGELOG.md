# Changelog

All notable changes to `mnemocyte` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
package is pre-1.0; minor versions (`0.x.0`) may contain additive or
behavioural changes documented in their entries.

## [Unreleased]

### Breaking Changes

- **CONFIG-01 — Invalid provider resilience numbers reject at construction.**
  `timeoutMs`, `baseDelayMs`, and `maxDelayMs` must be finite and
  non-negative; `retries` must also be an integer; and `shouldRetry` must be
  callable. Invalid values now throw `"CONFIG"` synchronously instead of
  failing later during provider work. `maxDelayMs` below `baseDelayMs` remains
  supported and is normalized up to the base delay.

- **INPUT-02 — Malformed remember domains now reject at runtime.** Unknown
  memory types or importance levels, non-array/non-string tags, non-string
  sources, and invalid expiration dates now fail with `"VALIDATION"` before
  provider or storage work. Type filters on recall, duplicate search, and
  prune use the same runtime memory-type domain validation.

- **CONSOLIDATION-DELETE-01 — Referenced consolidation survivors cannot be
  deleted.** `forget`, `forgetAll`, and non-dry-run `prune` now reject with
  `"CONFLICT"` when a selected memory still has `supersededBy` dependents.
  Rejection happens before any row is deleted, including multi-row prune and
  `forgetAll` batches. Deleting superseded losers and memories with no
  dependents continues to work.
- **EMBED-02 — Postgres enforces one embedding model per installation.**
  `mnemocyte_meta` now records `embedding_model` alongside dimensions.
  Writes, recall, and duplicate scans reject a different configured model with
  `"CONFIG"` before provider usage or vector comparison. Migration `0002`
  infers a single historical model; mixed historical models leave the metadata
  unset and fail embedding-dependent operations with `"MIGRATION"` until an
  operator explicitly repairs or re-embeds the data.

### Changed

- **AUDIT-01 — Global prune writes per-entity audit events.** When audit is
  enabled, a successful non-dry global prune now records one
  `"memory.pruned"` event with the deleted count for each affected entity.
  Dry runs, zero-deletion runs, and unaffected entities still produce no prune
  event; audit persistence remains best-effort.
- **RETRIEVAL-02 — Recall returns post-update access metadata.** Successful
  recall results now expose the `accessCount`, `lastAccessedAt`, and
  `updatedAt` written by that recall instead of values from the preceding
  access. Ranking and score explanations still use the pre-access count, so a
  recall does not reorder or rescore itself.
- **STORE-01 — Batch inserts validate the store return contract.** Shared
  orchestration now requires exactly one returned memory for every prepared
  input ID, rejects missing, duplicate, or unknown IDs with `"DB"`, and
  restores input order before returning `rememberMany()` results.
- **REFACTOR-01 — Metadata ownership avoids redundant traversals.** Remember
  inputs now carry an internal validated/owned JSON type through record
  creation and storage, freshly created in-memory rows transfer ownership to
  the adapter, and adapter-returned detached memories/audit events are no
  longer cloned again by shared client orchestration. Public validation,
  snapshot, and mutation-isolation behavior is unchanged.
- **OBSERVABILITY-01 — Remember preparation failures emit operation events.**
  `remember` and `rememberMany` now emit exactly one `"start"` and one
  `"error"` event when synchronous snapshotting or validation fails, using the
  same thrown value exposed to the caller. Call-time snapshots still happen
  before awaiting observability hooks, and closed-client errors retain
  precedence over invalid input.
- **INPUT-01 — `remember` snapshots mutable inputs at invocation.** Single and
  batch writes now own copies of caller-supplied tags, metadata, and expiration
  dates before awaiting embedding or storage, so mutations made while a write
  is pending cannot change the stored memory.
- **Documentation reflects the current pre-v1 state.** Architecture and
  maintainer docs now include the consolidation deletion helper and complete
  metadata schema, document the current plain-text framing and tiny-token-budget
  limitations, and label dated audit counts and Git-state claims as historical
  snapshots.
- **LIFECYCLE-01 — `close()` coordinates with in-flight operations.** Closing a
  client now rejects newly started work, waits for already-started operations
  before closing the store, and shares one promise across concurrent/idempotent
  close calls. If the store close fails, operation admission reopens so callers
  can retry `close()`.
- **CANCELLATION-01 — Maintenance-operation signals are now enforced.**
  `prune`, `findDuplicates`, `listAuditLog`, and `experimental.consolidate`
  reject pre-aborted signals before store work. In-memory scans check
  cooperatively; standalone Postgres maintenance queries request postgres.js
  cancellation. Postgres consolidation checks cancellation between transaction
  steps and before its transaction callback returns, so in-flight statements
  may finish before rollback. An abort after the final check, including during
  commit, may still leave the mutation committed.
- **PRUNE-01 — Malformed prune selectors fail before storage access.** Prune
  now validates dates, enum values, arrays, booleans, and signals, then passes
  only a normalized internal filter to storage adapters. False flags and empty
  arrays do not count as selectors, and both adapters reject an empty internal
  filter before scanning or issuing SQL, preventing malformed inputs from
  becoming unbounded deletes.
- **SERIALIZATION-01 — Postgres vectors preserve small finite components.**
  Vector inserts and raw query literals now use a shortest round-trip-safe
  number representation, so finite values such as `1e-20` are no longer
  rounded to zero before pgvector applies its native float4 conversion.
- **EMBED-01 — Zero-norm embeddings are rejected.** Shared embedding
  validation now rejects exact all-zero vectors with `"EMBEDDING"` before
  storage, recall comparison, or duplicate-search participation in either
  backend. Tiny nonzero vectors remain valid.
- **RETRIEVAL-01 — Signed cosine candidates have backend parity.** The
  internal vector-search contract now returns only finite components clamped
  to `[0, 1]`. Postgres applies its vector cutoff to that clamped component,
  so negative-cosine candidates can still participate in shared score fusion;
  public `minScore` remains a final fused-score filter.

## [0.3.0] - 2026-07-16

### Breaking Changes

- **BUG-03 — Metadata uses JSON value semantics.** `Memory.metadata`,
  `RememberInput.metadata`, and `AuditEvent.metadata` now use the exported
  recursive `JsonObject` / `JsonValue` types instead of
  `Record<string, unknown>`. Unsupported or cyclic values fail with
  `"VALIDATION"`, and metadata is deep-cloned at write and read boundaries in
  both backends.
- **BUG-02 — Retrieval tuning rejects invalid values.** Client construction
  now throws `"CONFIG"` for non-finite or negative weights, a zero effective
  weight total, non-positive or non-finite recency/access settings, and a
  `candidateMultiplier` that is not an integer of at least 1. Supplying a
  `maxTokens` value that is not a positive integer now throws `"VALIDATION"`;
  omission keeps the existing default path.
- **BUG-01 — `rememberMany` has one batch cancellation signal.** The canonical
  call is now `rememberMany({ inputs, signal })`; item inputs do not own
  cancellation, and aborting `signal` cancels the whole batch without changing
  its return shape. The positional `rememberMany(inputs)` signature remains as
  a deprecated pre-v1 compatibility overload and continues treating the first
  item's signal as the batch signal.

### Changed

- **Internal `MemoryStore` boundary.** Refactored in-memory and Postgres
  backends behind internal storage adapters. That refactor preserved the public
  API; the separate pre-v1 breaking changes are listed above.
- **Shared client orchestration.** Validation, embedding calls, recall scoring,
  observability, audit opt-in behavior, context building, lifecycle checks, and
  public result mapping now run through one shared client path.
- **Postgres metadata checks are narrower.** Embedding-dimension validation now
  runs only for operations that call the embedder or compare stored embeddings,
  so non-embedding recovery operations are not blocked solely by a dimension
  mismatch.
- **Provider timeouts actively abort attempts.** Configured provider timeouts
  now abort the per-attempt `AbortSignal` passed to embedders.
- **Lint validation is read-only.** `pnpm lint` now checks formatting, lint
  rules, and import organization without modifying files, fails on warnings,
  and leaves fixes to `pnpm lint:fix`.
- **Memory internals have focused module boundaries.** Defaults, embedding
  calls, in-memory filters, record mapping, and validation now live in separate
  leaf modules, with public-memory cloning shared by storage and scoring paths.
- **Postgres benchmarks initialize current metadata.** Retrieval benchmarks now
  apply both bundled migrations and create a missing default installation row
  without overwriting an existing dimension selection.
- **Node declarations match the support floor.** Development now uses Node 22
  type declarations, reducing the chance of accidentally depending on APIs
  unavailable at the minimum supported Node `22.18` runtime.

### Fixed

- **Invalid embedding components fail before storage.** Single and batched
  embedder output now rejects `NaN` and infinite vector values with error code
  `"EMBEDDING"` before either backend can persist them.
- **Client configuration failures are consistently typed.** Explicitly empty
  database URLs fail with `"VALIDATION"`, malformed URLs fail with `"CONFIG"`,
  and malformed embedder models remain in the `"CONFIG"` category.
- **In-memory close releases audit metadata.** Closing the in-memory store now
  clears its audit-event buffer alongside stored memories.
- **In-memory results no longer leak embeddings.** Public `Memory`,
  `MemoryWithScore`, and duplicate-pair results are mapped through explicit
  public-memory clones that omit internal vectors at runtime.
- **Postgres failures are normalized more consistently.** Expected missing
  schema/migration failures are surfaced as `"MIGRATION"` and expected
  storage/query failures as `"DB"` while preserving existing typed errors.

## [0.2.0] - 2026-06-10

### Added

- **Configurable Postgres embedding dimensions.** Added
  `mnemocyte_meta.embedding_dimensions` as installation metadata via
  `0001_add_mnemocyte_meta.sql`, plus a dimension-rendered initial migration
  template and `pnpm migration:render` tooling for explicit custom pgvector
  schemas.

### Changed

- **Postgres dimension validation is metadata-backed.** `createMnemocyte`
  stays synchronous and no longer hard-rejects non-1536 Postgres embedders.
  The Postgres client validates `embedder.dimensions` against
  `mnemocyte_meta` before storage operations, and write/recall paths validate
  before calling external embedders.
- **v1 planning docs are clearer.** README, architecture notes, roadmap,
  project memory, and performance notes now separate current behavior, known
  pre-v1 limitations, planned v1 work, and future considerations.

## [0.1.5] - 2026-05-22

### Fixed

- **Embedder helper autocomplete.** Added a folder-level
  `mnemocyte/embedders` package export so editors can discover
  `openaiEmbedder` while preserving the existing
  `mnemocyte/embedders/openai` subpath.

## [0.1.4] - 2026-05-21

### Added

- **Official OpenAI embedder helper.** Added
  `mnemocyte/embedders/openai` with `openaiEmbedder({ apiKey, model,
dimensions? })`, `OPENAI_API_KEY` defaulting, `AbortSignal` forwarding,
  known OpenAI embedding dimensions, and package export/type coverage.

### Changed

- **OpenAI helper uses direct `fetch` calls.** The root package remains
  provider-SDK-free, and the OpenAI helper does not add an OpenAI SDK
  dependency.
- **Provider retry detection recognizes numeric HTTP statuses.** The default
  retry heuristic now treats provider errors with status `429`, `500`, `502`,
  `503`, or `504` as transient.
- **Documentation now includes production HNSW/index guidance.** README,
  architecture, and roadmap docs explain the bundled
  `mnemocyte_memories_embedding_hnsw_idx` index, HNSW tradeoffs, filtering
  behavior, and when to benchmark alternate full-text/tag/vector indexes.
- **Roadmap wording now uses `MemoryStore`.** Future backend abstraction docs
  now refer to the planned `MemoryStore` boundary rather than generic `Store`.

## [0.1.3] - 2026-05-21

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
- **Roadmap documentation now reflects the adapter-first direction.** The
  planning docs prioritize `0.1.x` hardening, `openaiEmbedder()`, configurable
  dimensions with `mnemocyte_meta`, `MemoryStore`, `drizzleStore(db)`,
  and `@mnemocyte/mcp`.
- **Retrieval benchmarks now cover scale curves.** `bench:retrieval` runs
  multiple in-memory sizes and optional Postgres cases when `DATABASE_URL` is
  configured.
- **Recall scoring avoids repeated per-candidate setup.** Recall paths now
  precompute lexical query terms and normalized retrieval weights once per
  request.
- **Tests now run fully through Vitest.** Runtime tests, package export checks,
  strict test type checks, and retrieval benchmarks were migrated from Node
  script-style `.mjs` files to TypeScript Vitest suites with named projects for
  unit, package, and Postgres integration coverage.

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
  threshold + limit + filters, returns `DuplicatePair[]`. _Experimental._
- **`client.listAuditLog(input)`** + **`MnemocyteConfig.audit.enabled`**:
  opt-in audit log of state changes, persisted to `mnemocyte_events` (or
  an in-memory array). Slugs: `"memory.created"`, `"memory.deleted"`,
  `"entity.cleared"`, `"memory.pruned"`, `"memory.superseded"`.
  _Experimental._
- **`client.experimental.consolidate(input)`**: mark loser memories as
  superseded by a survivor; idempotent for already-superseded losers;
  optional tag merge; emits `"memory.superseded"` audit events.
  _Experimental._
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

[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Meenic/mnemocyte/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Meenic/mnemocyte/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/Meenic/mnemocyte/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Meenic/mnemocyte/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Meenic/mnemocyte/compare/v0.1.2...v0.1.3
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
