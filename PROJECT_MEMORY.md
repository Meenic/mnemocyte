# Project Memory

## Current State

- Package `v0.2.0` has been published and tagged.
- Package `v0.1.5` is the previous patch baseline for embedder export
  discoverability.
- The test suite has been migrated fully to Vitest and TypeScript.
- Test files should not use `node:assert`, `assert.*`, `@ts-ignore`, or `@ts-nocheck`.
- `CHANGELOG.md` has a `0.2.0` section dated `2026-06-10` for configurable
  Postgres embedding dimensions and the related migration/documentation work.
- `ARCHITECTURE.md` reflects the pinned Vitest version from `package.json`.
- The current roadmap treats `0.2.0` as published; the next feature line is
  `0.3.0` `MemoryStore` / v1 stabilization.
- Postgres installs now use `mnemocyte_meta.embedding_dimensions` as the
  installation-level dimension source of truth. The default initial migration
  remains 1536-dimensional, and custom dimensions are rendered explicitly from
  `migrations/0000_initial.sql.template` with `pnpm migration:render`.
- The OpenAI helper intentionally does not depend on the OpenAI SDK. It uses
  direct `fetch` calls and keeps the root `mnemocyte` import provider-free.
- `mnemocyte/embedders` is the editor-discoverable barrel export for embedder
  helpers. Provider-specific subpaths such as `mnemocyte/embedders/openai`
  remain supported through wildcard package exports.
- For write and recall paths, Postgres schema and dimension validation must
  happen before `embedder.embed()` so configuration or migration errors fail
  before provider API usage. Before v1, split this from non-embedding
  operations so cleanup, audit reads, and diagnostics can still run during
  migration repair.

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

- Extract `MemoryStore` or equivalent shared orchestration so in-memory and
  Postgres backends do not duplicate operation flow.
- Strip internal embedding vectors from all public in-memory return paths.
- Make provider timeouts actively abort underlying requests where supported.
- Wrap expected database and migration failures in `MnemocyteError`.
- Decide whether `rememberMany(inputs)` remains positional or moves to an
  object-parameter shape.
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

- Start the `0.3.0` `MemoryStore` / v1 stabilization line.
- Keep the future monorepo direction in mind: provider adapters can later move
  from subpaths to packages such as `@mnemocyte/openai`.
