# Development

What is built today and how to work on it. The target design lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); when one of its items lands, its section
moves here or into [features/](./features/).

Feature areas:

- [features/postgres.md](./features/postgres.md): schema, migrations,
  installation metadata, connections, `drizzleStore(db)`.
- [features/retrieval.md](./features/retrieval.md): recall, scoring, access
  tracking, `buildContext`.
- [features/maintenance.md](./features/maintenance.md): forget, prune,
  duplicates, consolidation, audit log, stats.
- [features/embedders.md](./features/embedders.md): the `Embedder` contract,
  the OpenAI helper, retries, timeouts, cancellation, observability.

## Setup

- Node.js 22.18 or newer. CI runs 22.18 and 24.
- pnpm 11.28.8, matching `packageManager` in `package.json`. CI reads the
  version from that field.
- Postgres with pgvector only for the integration suite.

```bash
pnpm install --frozen-lockfile
pnpm dev     # tsdown in watch mode
pnpm build   # writes dist/
```

Mnemocyte is a library; there is no app to run. Try changes through the tests
or from a consuming project.

## Structure

```txt
src/
  index.ts              root entry: createMnemocyte, errors, public types
  client.ts             backend selection (store | databaseUrl | in-memory)
  types.ts              every public type
  errors.ts             MnemocyteError and its codes
  observability.ts      onEvent lifecycle (start / success / error)
  resilience.ts         provider timeout, retry, abort
  database-url.ts       postgres:/postgresql: URL check
  memory/
    client-core.ts      shared orchestration for every client method
    store.ts            the internal MemoryStore contract (18 methods)
    in-memory.ts        in-memory MemoryStore
    postgres.ts         Postgres MemoryStore
    lazy-postgres.ts    loads the Postgres runtime on first use
    validation.ts       runtime input and config validation
    json.ts             JSON metadata validation and deep clone
    embeddings.ts       embedder calls and output validation
    filters.ts          in-memory filter predicates
    records.ts          ids, tag normalization, cloning
  db/
    schema.ts           Drizzle table definitions
    index.ts            postgres.js + Drizzle handle creation
    cancellation.ts     cancelable raw SQL through postgres.js
    queries/            memories, events, meta SQL
  retrieval/scorer.ts   cosine, lexical overlap, weighted scoring
  context/              buildContext, formatters, token budget
  embedders/            openaiEmbedder (fetch only)
  stores/drizzle.ts     drizzleStore(db)
migrations/             SQL migrations, template, renderer, Drizzle journal
test/                   unit, package, integration, fixtures, benchmarks
```

`dist/` is built by tsdown from `src/index.ts`, `src/embedders/*.ts` and
`src/stores/*.ts`. The root entry imports nothing from `drizzle-orm` or
`postgres` statically; the Postgres runtime is loaded through a dynamic
`import()` the first time a Postgres store is used.

## Conventions

- Shared behavior goes in `memory/client-core.ts`; backend mechanics stay in
  the `MemoryStore` implementations. Both backends must pass the same shared
  fixtures in `test/fixtures/`.
- Validation runs before any embedder or storage call. Invalid input throws
  `MnemocyteError` with code `"VALIDATION"`; invalid configuration throws
  `"CONFIG"` synchronously from `createMnemocyte`.
- Caller-owned values (tags, metadata, dates) are snapshotted when a method is
  called. Returned records are detached copies.
- Metadata is JSON value data (`JsonObject`). Anything else is rejected.
- Store results are not trusted: shared code rejects missing, duplicate or
  unknown ids from `insertMemories` and `markMemoriesAccessed` and restores
  input order.
- Vectors are written with the shortest round-trip number format
  (`db/vector.ts`). Fixed decimal precision would turn small components into
  zero.
- Driver errors are mapped to `MnemocyteError`: missing tables or columns
  become `"MIGRATION"`, everything else `"DB"`.
- `@types/node` stays on the major of the minimum supported Node version.

## Public API

Exports:

- `mnemocyte`: `createMnemocyte`, `MnemocyteError`, `isMnemocyteError` and
  the public types.
- `mnemocyte/embedders` and `mnemocyte/embedders/openai`: `openaiEmbedder`.
- `mnemocyte/stores/drizzle`: `drizzleStore(db)`.

Client methods: `remember`, `rememberMany`, `recall`, `buildContext`,
`forget`, `forgetAll`, `prune`, `findDuplicates`, `listAuditLog`, `stats`,
`experimental.consolidate` and `close`.

Design rules for the public surface:

- One object parameter per method; new options are optional fields.
- Errors are `MnemocyteError` with a stable `code`; callers branch on the
  code, never the message.
- Every long-running method accepts `signal: AbortSignal`.
- New or unproven behavior goes under `experimental` first.
- Breaking changes ship in a new minor (0.x) with a `CHANGELOG.md` entry and
  an upgrade note. Deprecated overloads (today: positional
  `rememberMany(inputs)`) are removed the same way.

## Testing

Vitest has three projects (`vitest.config.ts`):

| Project | Files | Imports | Command |
|---|---|---|---|
| `unit` | `test/**/*.test.ts` except integration, package, benchmarks | `src/` through aliases | `pnpm test:unit` |
| `package` | `test/package/*.test.ts` plus `exports-types.test-d.ts` | built `dist/` | `pnpm test:exports` |
| `integration` | `test/integration/**/*.test.ts` | `src/` | `pnpm test:integration` |

- `pnpm test` builds, then runs `unit` and `package` with type tests. This is
  what CI runs on every push.
- The package tests pack the tarball, install it into a temporary consumer
  with `drizzle-orm` and `postgres` absent, and type-check every export
  against `dist/*.d.mts`.
- Shared behavior is written once as a fixture in `test/fixtures/` and run
  against the in-memory backend in `unit` and against Postgres in
  `integration`.
- The integration suite needs a **disposable** Postgres database with
  pgvector available and a role that can create tables in `public`. Each file
  applies the bundled migrations, ignoring "already exists" errors, and uses
  random entity ids. Some tests rewrite `mnemocyte_meta` and drop tables
  inside a transaction they roll back. Files run serially with a 60 s
  timeout. When `DATABASE_URL` is unset the tests load `.env`, so set it
  explicitly.
- CI runs the integration suite against the `pgvector/pgvector:pg17` service
  container after `CREATE EXTENSION vector`.
- `pnpm bench:retrieval` runs in-memory sizes, plus Postgres sizes when
  `DATABASE_URL` is set. It is not part of CI.

## Releasing

Today releases are manual and run by the maintainer:

1. Move `CHANGELOG.md` `[Unreleased]` entries under the new version.
2. Run `pnpm checktypes`, `pnpm lint`, `pnpm test`, `pnpm run pack:check`.
3. `pnpm version patch` (or `minor`), which creates the version commit and
   tag. Do not add a separate release commit.
4. Push the commit and tag, `pnpm publish`, then create the GitHub release.

`publishConfig.provenance` is set, but npm only generates provenance when
publishing from GitHub Actions or GitLab CI, so releases published from a
laptop (including 0.5.0) have none. A tag-triggered publish workflow is on the
roadmap.

GitHub release title: `mnemocyte vX.Y.Z`. Description:

```markdown
### Category
- **Short label**: concise description of the change

**Full Changelog**: https://github.com/Meenic/mnemocyte/compare/vPREVIOUS...vCURRENT
```

Categories: Performance, Accuracy, Reliability, Embedders, Documentation,
Tooling, API. Keep it factual, with no validation section.
