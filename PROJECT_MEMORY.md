# Project Memory

## Current State

- Package `v0.1.3` has been published.
- The test suite has been migrated fully to Vitest and TypeScript.
- Test files should not use `node:assert`, `assert.*`, `@ts-ignore`, or `@ts-nocheck`.
- `CHANGELOG.md` has a published `0.1.3` section dated `2026-05-21`.
- `CHANGELOG.md` `[Unreleased]` now tracks the current HNSW/index docs,
  `openaiEmbedder()` subpath export, direct-fetch OpenAI implementation, and
  retry-status heuristic changes.
- `ARCHITECTURE.md` reflects the pinned Vitest version from `package.json`.
- The current roadmap still points to `0.1.x` production hardening before
  larger API work, but HNSW/index guidance and the first `openaiEmbedder()`
  helper are now implemented in the working tree.
- The OpenAI helper intentionally does not depend on the OpenAI SDK. It uses
  direct `fetch` calls and keeps the root `mnemocyte` import provider-free.
- Do not bump the package version yet; more changes are planned before the next
  release.

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

## Release Notes

For the next release:

1. Move entries from `CHANGELOG.md` `[Unreleased]` into a new version section.
2. Update the package version.
3. Run the verification commands above.
4. Commit the release changes.
5. Create the version tag.
6. Push branch and tags together:

```sh
git push --follow-tags origin HEAD
```

7. Publish:

```sh
pnpm publish
```

## Suggested Next Steps

- Review the current unreleased diff and decide what other changes should land
  before the next version bump.
- Run `pnpm run test:integration` when a compatible local Postgres + pgvector
  database is available.
- Decide whether the next work should stay in `0.1.x` hardening or begin the
  `0.2.0` configurable embedding-dimensions design.
- Keep the future monorepo direction in mind: provider adapters can later move
  from subpaths to packages such as `@mnemocyte/openai`.
