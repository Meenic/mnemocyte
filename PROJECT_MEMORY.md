# Project Memory

## Current State

- Package `v0.1.3` has been published.
- Package `v0.1.4` is being prepared as the final `0.1.x` hardening release.
- The test suite has been migrated fully to Vitest and TypeScript.
- Test files should not use `node:assert`, `assert.*`, `@ts-ignore`, or `@ts-nocheck`.
- `CHANGELOG.md` has a `0.1.4` section dated `2026-05-21` for the current
  HNSW/index docs, `openaiEmbedder()` subpath export, direct-fetch OpenAI
  implementation, and retry-status heuristic changes.
- `ARCHITECTURE.md` reflects the pinned Vitest version from `package.json`.
- The current roadmap treats `0.1.x` as maintenance after `0.1.4`; the next
  planned feature line is `0.2.0` configurable embedding dimensions.
- The OpenAI helper intentionally does not depend on the OpenAI SDK. It uses
  direct `fetch` calls and keeps the root `mnemocyte` import provider-free.
- After `0.1.4` is published, start `0.2.0` work fresh from configurable
  embedding dimensions.

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

- Run `pnpm run test:integration` when a compatible local Postgres + pgvector
  database is available.
- Release `0.1.4` after verification, tagging, and publishing.
- Begin the `0.2.0` configurable embedding-dimensions design from a fresh
  post-release baseline.
- Keep the future monorepo direction in mind: provider adapters can later move
  from subpaths to packages such as `@mnemocyte/openai`.
