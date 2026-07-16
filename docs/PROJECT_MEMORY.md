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
  direct `fetch` calls and keeps the root `mnemocyte` import provider-free.
- `mnemocyte/embedders` is the editor-discoverable barrel export for embedder
  helpers. Provider-specific subpaths such as `mnemocyte/embedders/openai`
  remain supported through wildcard package exports.
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
  `"VALIDATION"`, and both storage adapters deep-clone metadata at ingress and
  egress.
- Retrieval tuning is validated synchronously at client construction and fails
  with `"CONFIG"` for invalid weights, decay/access settings, or candidate
  multipliers. A supplied `buildContext.maxTokens` that is not a positive
  integer fails per call with `"VALIDATION"`; omission keeps the default path.
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
- Consolidation survivors cannot be deleted while another memory's
  `supersededBy` points to them. `forget`, `forgetAll`, and non-dry-run `prune`
  reject atomically with `"CONFLICT"` in both adapters; deleting losers and
  memories with no dependents remains valid. Postgres retains the
  `ON DELETE NO ACTION` foreign key as a race-condition backstop.
- Explicitly supplied database URLs select the Postgres path: empty values fail
  with `"VALIDATION"`, malformed URLs fail with `"CONFIG"`, and construction
  remains synchronous.
- `pnpm lint` is a read-only Biome check that fails on warnings;
  `pnpm lint:fix` applies safe formatting, lint, and import fixes.
- Memory defaults, embedding calls, filters, record mapping, and validation
  live in focused leaf modules under `src/memory/`; keep orchestration in
  `client-core.ts` and backend mechanics in the adapters.
- Ordinary audit writes are best-effort; Postgres consolidation audit events
  remain transaction-coupled to the consolidation mutation.
- Keep `@types/node` on major 22 while Node `>=22.18` is the minimum supported
  runtime; CI also covers Node 24.

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
- Add runtime validation for JavaScript consumers where public inputs need
  stronger guards than TypeScript declarations.

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
- Keep the future monorepo direction in mind: provider adapters can later move
  from subpaths to packages such as `@mnemocyte/openai`.
