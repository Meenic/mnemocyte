# Project Memory

## Current State

- Package `v0.1.3` has been published.
- The test suite has been migrated fully to Vitest and TypeScript.
- Test files should not use `node:assert`, `assert.*`, `@ts-ignore`, or `@ts-nocheck`.
- `CHANGELOG.md` has a published `0.1.3` section dated `2026-05-21`.
- `ARCHITECTURE.md` reflects the pinned Vitest version from `package.json`.
- The current roadmap still points to `0.1.x` production hardening before larger API work.

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

- Check whether the current docs-only changes are committed and pushed.
- Check the GitHub Actions run for `v0.1.3`, especially the PostgreSQL integration job.
- Start the next roadmap item under `0.1.x` production hardening.

The most useful next implementation/doc task is HNSW and index guidance:

- document the bundled `mnemocyte_memories_embedding_hnsw_idx` index
- explain HNSW tradeoffs: approximate recall, build memory, write overhead, and filtering behavior
- document when users should benchmark alternate indexes or custom migrations
- add guidance for full-text and tag indexes without changing the default migration yet

After that, the next likely feature is the official `openaiEmbedder()` subpath export. Keep it additive and non-breaking:

- add `mnemocyte/embedders/openai`
- export `openaiEmbedder({ apiKey, model, dimensions? })`
- forward `AbortSignal`
- keep the OpenAI dependency boundary optional or narrowly scoped
- document that custom embedders remain the default integration model

Do not start `0.2.0` configurable embedding dimensions until the remaining `0.1.x` hardening/doc items are settled.
