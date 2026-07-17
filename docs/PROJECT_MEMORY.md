# Project Memory

## Current State

- Package `v0.3.0` has been published, tagged, and is the npm `latest` release.
- The `0.3.0` release includes internal `MemoryStore` adapters, shared client
  orchestration, active provider timeout aborts, narrower Postgres dimension
  checks, JSON metadata value semantics, runtime tuning validation, batch-level
  `rememberMany` cancellation, and in-memory public-result vector leak fixes.
- Package `v0.2.0` is the previous minor baseline for configurable Postgres
  embedding dimensions.
- The test suite has been migrated fully to Vitest and TypeScript.
- Test files should not use `node:assert`, `assert.*`, `@ts-ignore`, or `@ts-nocheck`.
- `../CHANGELOG.md` has a `0.3.0` section dated `2026-07-16` for the internal
  store refactor, approved pre-v1 behavior changes, and hardening fixes.
- `ARCHITECTURE.md` reflects the pinned Vitest version from `package.json`.
- The current roadmap treats `0.3.0` as published and public `MemoryStore`
  stabilization as the next architectural decision.
- Postgres installs now use `mnemocyte_meta.embedding_dimensions` as the
  installation-level dimension source of truth. The default initial migration
  remains 1536-dimensional, and custom dimensions are rendered explicitly from
  `migrations/0000_initial.sql.template` with `pnpm migration:render`.
- The OpenAI helper intentionally does not depend on the OpenAI SDK. It uses
  direct `fetch` calls, keeps the root `mnemocyte` import provider-free, and
  rejects response data that is not exactly one uniquely indexed array
  embedding per input. Shared embedding validation retains dimension and
  finite-component checks.
- `mnemocyte/embedders` is the editor-discoverable barrel export for embedder
  helpers. Provider-specific subpaths such as `mnemocyte/embedders/openai`
  remain supported through wildcard package exports.
- Provider helpers stay on package subpaths for the near term. Reconsider
  separate packages only after a second provider exists or one requires a
  heavy or conflicting SDK dependency; root imports remain provider-free.
- For write, recall, and duplicate-scan paths, Postgres embedding model and
  dimension validation must happen before provider usage or vector comparison.
  Empty installations atomically record the first configured model; a single
  historical model is inferred and recorded, while mixed historical models
  fail with `"MIGRATION"` until explicitly repaired. Non-embedding operations
  remain usable when metadata is incompatible.
- Single and batched embedder output must contain only finite vector values and
  at least one nonzero component. Invalid or exact zero-norm vectors fail with
  `"EMBEDDING"` before storage or comparison; tiny nonzero vectors remain
  valid.
- Postgres vector inserts and raw query literals share a shortest
  round-trip-safe finite-number formatter. Do not use fixed decimal precision:
  it can collapse valid small components to zero before pgvector's float4
  conversion.
- `MemoryStore.vectorSearch()` returns a finite vector component clamped to
  `[0, 1]` in both adapters. Postgres filters that clamped component rather
  than raw signed cosine; public recall `minScore` remains a shared final-score
  filter.
- Persisted memory and audit metadata use the recursive public `JsonObject` /
  `JsonValue` types. Unsupported or cyclic runtime values fail with
  `"VALIDATION"`. Memory metadata is validated/cloned once at public ingress,
  transferred through the internal owned-value contract, and cloned once in
  the detached adapter result. Audit adapters retain independent ingress and
  egress clones.
- `remember` and `rememberMany` snapshot mutable tags, metadata, and expiration
  dates before awaiting. Their shared runtime boundary rejects unknown memory
  types or importance levels, malformed tags/source values, and invalid
  expiration dates with `"VALIDATION"` before provider or store work. Recall,
  duplicate-search, and prune type filters share the same memory-type domain
  validator.
- Remember snapshot and validation failures emit the documented observability
  lifecycle: exactly one `"start"` plus one `"error"` carrying the caller's
  thrown value. Snapshotting still completes before awaiting user hooks, while
  closed-client admission errors retain precedence over malformed input.
- `MemoryStore.insertMemories()` must return exactly one detached memory for
  every prepared input ID. Shared orchestration rejects missing, duplicate, or
  unknown IDs with `"DB"` and restores prepared-input order before returning
  single or batched remember results.
- Recall scoring uses pre-access counts, then
  `MemoryStore.markMemoriesAccessed()` returns the exact post-update count and
  timestamps for every selected ID. Shared orchestration validates the ID set
  and patches `accessCount`, `lastAccessedAt`, and `updatedAt` before returning
  without rescoring the result.
- Retrieval tuning is validated synchronously at client construction and fails
  with `"CONFIG"` for invalid weights, decay/access settings, or candidate
  multipliers. A supplied `buildContext.maxTokens` that is not a positive
  integer fails per call with `"VALIDATION"`; omission keeps the default path.
- Provider resilience numbers are also validated synchronously at construction:
  timeouts and delays must be finite and non-negative, retries must be a
  non-negative integer, and `shouldRetry` must be callable. Invalid values fail
  with `"CONFIG"` before provider work; `maxDelayMs` below `baseDelayMs`
  remains accepted and is normalized to the base delay.
- `rememberMany({ inputs, signal })` is the canonical batch API, with one
  cancellation signal for the entire operation. The positional form remains a
  deprecated pre-v1 overload and maps its first item signal to the batch.
- `prune`, `findDuplicates`, `listAuditLog`, and
  `experimental.consolidate` reject pre-aborted signals before store work.
  In-memory scans check cooperatively; standalone Postgres maintenance queries
  request postgres.js cancellation. Postgres consolidation checks between
  transaction steps and before its transaction callback returns, so an
  in-flight statement may finish before rollback. An abort after the final
  check, including during commit, may still leave the mutation committed.
- `prune` exhaustively validates runtime selectors and normalizes them into an
  internal filter before the `MemoryStore` boundary. Invalid dates, enums,
  arrays, booleans, or signals fail with `"VALIDATION"`; false flags and empty
  arrays do not count as selectors. Both adapters reject an empty internal
  filter before scanning or issuing SQL.
- Store prune results include validated per-entity deletion counts. Shared
  orchestration emits one best-effort `"memory.pruned"` event for every
  affected entity in entity-scoped and global non-dry runs; dry runs and
  zero-deletion runs emit none.
- Consolidation survivors cannot be deleted while another memory's
  `supersededBy` points to them. `forget`, `forgetAll`, and non-dry-run `prune`
  reject atomically with `"CONFLICT"` in both adapters; deleting losers and
  memories with no dependents remains valid. Postgres retains the
  `ON DELETE NO ACTION` foreign key as a race-condition backstop.
- Consolidation idempotency is survivor-specific. Retrying a loser against its
  existing survivor returns a zero-count no-op; requesting a different
  survivor rejects the entire call with `"CONFLICT"` before loser state,
  survivor tags, or audit events change. Postgres locks requested loser rows
  inside the consolidation transaction so concurrent calls preserve this
  rule.
- Markdown context chooses a content-safe backtick fence, plain context chooses
  a deterministic `=` fence longer than every run in the query, rendered
  metadata, and included content, and XML escapes content. Untrusted plain text
  cannot reproduce its active frame delimiter.
- `buildContext.maxTokens` rejects invalid values and is a hard postcondition
  for valid budgets. When no formatted context or full truncation marker fits,
  the builder returns the longest fitting marker fragment or an empty string.
- Explicitly supplied database URLs select the Postgres path: empty values fail
  with `"VALIDATION"`; malformed or non-`postgres:` / `postgresql:` URLs fail
  synchronously with `"CONFIG"` before a connection handle is created. Finer
  host and credential validation remains with postgres.js.
- `pnpm lint` is a read-only Biome check that fails on warnings;
  `pnpm lint:fix` applies safe formatting, lint, and import fixes.
- Memory defaults, embedding calls, filters, record mapping, and validation
  live in focused leaf modules under `src/memory/`; keep orchestration in
  `client-core.ts` and backend mechanics in the adapters.
- Retrieval scoring and duplicate-pair mapping still retain separate public
  clones because their multi-candidate ownership paths were not proven
  redundant by the remember/audit metadata traversal audit.
- Ordinary audit writes are best-effort; Postgres consolidation audit events
  remain transaction-coupled to the consolidation mutation.
- Audit-log ordering uses `(timestamp, event ID)` descending in both adapters.
  Experimental `beforeCursor` / `afterCursor` inputs use the same tuple for
  stable pagination across equal timestamps. Timestamp-only `before` / `after`
  remain strict filters and are not complete tie-safe cursors.
- Keep `@types/node` on major 22 while Node `>=22.18` is the minimum supported
  runtime; CI also covers Node 24.
- The adapter milestone sequence is confirmed: stabilize the public
  `MemoryStore` contract, ship `drizzleStore(db)` at `0.4.0`, then ship
  `@mnemocyte/mcp` at `0.5.0`. Do not reorder these as an implementation
  shortcut.

## Important Commands

```sh
pnpm checktypes
pnpm lint
pnpm test
pnpm run test:ci
pnpm run test:integration
pnpm run pack:check
pnpm run bench:retrieval
```

Use this command when you specifically want to see strict test TypeScript errors:

```sh
pnpm tsc -p tsconfig.test.json
```

## CI Notes

- CI uses `pnpm run test:ci`.
- The PostgreSQL integration job provisions a `pgvector/pgvector:pg17` service and enables the `vector` extension.
- Local `test:integration` may fail if `DATABASE_URL` points to an unavailable database. That is expected unless a compatible local PostgreSQL + pgvector database is running.

## v1 Review Notes

Current behavior to preserve:

- Root `mnemocyte` imports stay provider-free.
- Provider helpers such as `mnemocyte/embedders/openai` stay no-SDK and
  `fetch`-based.
- Schema setup stays explicit; constructors must not create hidden tables,
  extensions, or indexes.
- The shared internal storage abstraction is named `MemoryStore`; the planned
  public adapter contract should retain that name.

Known code follow-ups before v1:

- Keep the internal `MemoryStore` private until the public adapter contract is
  stable enough for `drizzleStore(db)`.
- Continue tightening edge-case database and migration failure wrapping.
- Preserve the deprecated positional `rememberMany(inputs)` overload through
  pre-v1; new code uses `rememberMany({ inputs, signal })`.
- Continue adding runtime validation for JavaScript consumers where public
  inputs beyond the remember and memory-type-filter boundaries need stronger
  guards than TypeScript declarations.
- Resolve or explicitly defer the unapproved findings tracked in
  `../PROPOSALS.md`; do not infer approval from their presence.

Documentation follow-ups:

- Keep migration guidance aligned across `../README.md`, architecture notes,
  changelog, and package contents.
- Keep planned v1 work labeled as planned until implemented and validated.
- Move shipped roadmap items into `../CHANGELOG.md` instead of letting the roadmap
  become release history.

## Release Status

`v0.3.0` is published. Track changes after `v0.3.0` under the
`../CHANGELOG.md` `[Unreleased]` section and follow `../AGENTS.md` release
guidance when cutting the next version.

## Suggested Next Steps

- Decide when the internal `MemoryStore` contract is stable enough to become a
  public adapter surface.
- Keep provider helpers on subpaths until a second provider or a
  heavy/conflicting provider SDK creates a concrete reason to review separate
  packages.
