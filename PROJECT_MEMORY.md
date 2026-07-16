# Project Memory

## Current State

- Package `v0.2.0` has been published and tagged.
- The local tree contains unreleased `0.3.0` hardening work: internal
  `MemoryStore` adapters, shared client orchestration, active provider timeout
  aborts, narrower Postgres dimension checks, and in-memory public-result
  vector leak fixes.
- Package `v0.1.5` is the previous patch baseline for embedder export
  discoverability.
- The test suite has been migrated fully to Vitest and TypeScript.
- Test files should not use `node:assert`, `assert.*`, `@ts-ignore`, or `@ts-nocheck`.
- `CHANGELOG.md` has a `0.2.0` section dated `2026-06-10` for configurable
  Postgres embedding dimensions and the related migration/documentation work.
- `ARCHITECTURE.md` reflects the pinned Vitest version from `package.json`.
- The current roadmap treats `0.2.0` as published and `0.3.0` as the active
  `MemoryStore` / v1 stabilization line.
- Postgres installs now use `mnemocyte_meta.embedding_dimensions` as the
  installation-level dimension source of truth. The default initial migration
  remains 1536-dimensional, and custom dimensions are rendered explicitly from
  `migrations/0000_initial.sql.template` with `pnpm migration:render`.
- The OpenAI helper intentionally does not depend on the OpenAI SDK. It uses
  direct `fetch` calls and keeps the root `mnemocyte` import provider-free.
- `mnemocyte/embedders` is the editor-discoverable barrel export for embedder
  helpers. Provider-specific subpaths such as `mnemocyte/embedders/openai`
  remain supported through wildcard package exports.
- For write, recall, and duplicate-scan paths, Postgres embedding-dimension
  validation must happen before provider usage or vector comparison.
  Non-embedding operations should remain usable when only the configured
  embedder dimension is mismatched.
- Single and batched embedder output must contain only finite vector values;
  invalid components fail with `"EMBEDDING"` before storage.
- Persisted memory and audit metadata uses the recursive public `JsonObject` /
  `JsonValue` types. Unsupported or cyclic runtime values fail with
  `"VALIDATION"`, and both storage adapters deep-clone metadata at ingress and
  egress.
- Retrieval tuning is validated synchronously at client construction and fails
  with `"CONFIG"` for invalid weights, decay/access settings, or candidate
  multipliers. A supplied non-positive or fractional `buildContext.maxTokens`
  fails per call with `"VALIDATION"`; omission keeps the default path.
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
- `MemoryStore` is the intended name for the planned storage abstraction.

Known code follow-ups before v1:

- Keep the internal `MemoryStore` private until the public adapter contract is
  stable enough for `drizzleStore(db)`.
- Continue tightening edge-case database and migration failure wrapping.
- Preserve `rememberMany(inputs)` as the compatibility exception unless a v1 API
  review decides otherwise.
- Add runtime validation for JavaScript consumers where public inputs need
  stronger guards than TypeScript declarations.

Documentation follow-ups:

- Keep migration guidance aligned across README, architecture notes, changelog,
  and package contents.
- Keep planned v1 work labeled as planned until implemented and validated.
- Move shipped roadmap items into `CHANGELOG.md` instead of letting the roadmap
  become release history.

## Release Status

`v0.2.0` is published. Track changes after `v0.2.0` under the
`CHANGELOG.md` `[Unreleased]` section and follow `AGENTS.md` release guidance
when cutting the next version.

## Suggested Next Steps

- Finish validation and release prep for the unreleased `0.3.0` `MemoryStore`
  / v1 stabilization line.
- Keep the future monorepo direction in mind: provider adapters can later move
  from subpaths to packages such as `@mnemocyte/openai`.
