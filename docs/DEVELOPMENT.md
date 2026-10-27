# Development

What is built today and how to work on it. The target design lives in
[ARCHITECTURE.md](./ARCHITECTURE.md); when one of its items lands, its section
moves here or into [features/](./features/).

User-facing documentation is `README.md` plus [guide/](./guide/): the API
reference, Postgres setup, embedders and limitations. A change users can see
updates the matching guide page in the same PR.

Feature areas:

- [features/postgres.md](./features/postgres.md): schema, migrations,
  installation metadata, connections (`SqlExecutor`, `postgresStore`,
  `drizzleStore(db)`).
- [features/retrieval.md](./features/retrieval.md): recall, scoring, access
  tracking, `buildContext`.
- [features/maintenance.md](./features/maintenance.md): forget, prune,
  duplicates, consolidation, audit log, stats.
- [features/embedders.md](./features/embedders.md): the `Embedder` contract,
  the OpenAI helper, retries, timeouts, cancellation, observability.

## Setup

- Node.js 22.18 or newer. CI runs 22.18, 24 and 26.
- pnpm 12.15.0, matching `packageManager` in `package.json`. CI reads the
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
  client.ts             backend selection (store | in-memory)
  postgres.ts           `mnemocyte/postgres` entry: postgresStore, postgresJs
  types.ts              every public type
  errors.ts             MnemocyteError and its codes
  observability.ts      onEvent lifecycle (start / success / error)
  resilience.ts         provider timeout, retry, abort
  memory/
    client-core.ts      shared orchestration for every client method
    store.ts            the internal MemoryStore contract (18 methods)
    in-memory.ts        in-memory MemoryStore
    postgres.ts         Postgres MemoryStore (runs on a SqlExecutor)
    validation.ts       runtime input and config validation
    json.ts             JSON metadata validation and deep clone
    embeddings.ts       embedder calls and output validation
    filters.ts          in-memory filter predicates
    records.ts          ids, tag normalization, cloning
  sql/
    executor.ts         SqlExecutor: query + transaction
    postgres-js.ts      postgresJs(sql): the postgres.js adapter
  db/
    schema.ts           Drizzle table definitions (drizzle-kit only)
    sql.ts              bind-parameter collector for building statements
    rows.ts             row types, column lists, row normalization
    queries/            memories, events, meta SQL on a SqlExecutor
  retrieval/scorer.ts   cosine, lexical overlap, weighted scoring
  context/              buildContext, formatters, token budget
  embedders/            openaiEmbedder (fetch only)
  stores/drizzle.ts     drizzleStore(db)
migrations/             SQL migrations, template, renderer, Drizzle journal
test/                   unit, package, integration, fixtures, benchmarks
```

`dist/` is built by tsdown from the entries in `tsdown.config.ts`:
`src/index.ts`, `src/postgres.ts`, `src/embedders/*.ts` and
`src/stores/*.ts`. The package has no runtime dependencies. `drizzle-orm` and
`postgres` are optional peer dependencies that source files import for types
only, so no built entry imports them (a package test checks this). Their
versions are also dev dependencies for the tests.

TypeScript compiles against `target` and `lib` `es2024`, the newest edition
Node 22.18 fully supports. The `.mjs` files ship with source maps that embed
their sources. The `.d.mts` files ship without maps, because a declaration
map points at `src/`, which is not published. With `sourcemap` on, rolldown
writes a `sourceMappingURL` comment into every chunk, `.d.mts` included, and
rolldown-plugin-dts drops the declaration maps without removing it; a small
plugin in `tsdown.config.ts` strips that comment.

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
- `mnemocyte/postgres`: `postgresStore({ client })`, `postgresJs(sql)` and the
  `SqlExecutor` type.
- `mnemocyte/stores/drizzle`: `drizzleStore(db)`.

`package.json` lists each subpath explicitly, with a `types` and a `default`
condition; there are no wildcard subpaths, so a new entry needs its own
`exports` line. The `default` condition lets CommonJS load the package:
since Node 22.12, `require()` loads synchronous ES modules and returns their
namespace. It throws `ERR_REQUIRE_ASYNC_MODULE` if any module in the graph
uses top-level `await`, so `dist/` must not.

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
| `package` | `test/package/*.test.ts` plus `exports-types.test-d.ts` | built `dist/` through self-reference | `pnpm test:exports` |
| `integration` | `test/integration/**/*.test.ts` | `src/` through aliases | `pnpm test:integration` |

- `unit` and `integration` map `mnemocyte` to `src/` with `resolve.alias`,
  and `tsconfig.test.json` does the same with `paths`. The `package` project
  and `test/package/tsconfig.json` have neither: `mnemocyte` resolves to
  `dist/` through the package's own `exports` (package self-reference), the
  way a consumer resolves it.

- `pnpm test` builds, then runs `unit` and `package` with type tests. This is
  what CI runs on every push.
- The package tests pack the tarball, install it into a temporary consumer
  with `drizzle-orm` and `postgres` absent, and type-check every export
  against `dist/*.d.mts`. They extract with the system `tar` using relative
  paths, so GNU tar, bsdtar and Windows' `tar.exe` all work.
- `pnpm lint:package` builds, packs once into a temporary folder and runs
  publint `--strict` and attw on that tarball. attw uses the `node16`
  profile, which skips node10 resolution (it cannot see subpath `exports`),
  and ignores `cjs-resolves-to-esm`, because attw does not model `require()`
  of ES modules (Node 22.12+). CI runs it once, on Node 24.
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
- CI runs the integration suite on Node 24 against the
  `pgvector/pgvector:0.8.7-pg17` and `0.8.7-pg18` service containers after
  `CREATE EXTENSION vector`. The tags are pinned, so pgvector upgrades are
  deliberate.
- `pnpm bench:retrieval` builds, then runs `test/benchmarks/retrieval.bench.ts`
  in the `package (bench)` project, against `dist/`. Vitest 5 adds a
  `<name> (bench)` variant of each project for `vitest bench`; it matches
  files by `benchmark.include` (`test/benchmarks/**/*.bench.ts`) instead of
  the project's `include`. Each size is seeded before timing, then
  `bench.compare` samples one `recall` per iteration with tinybench and
  prints mean and percentile latencies per size. Postgres sizes run only when
  `DATABASE_URL` is set. It is not part of CI.
- Benchmarking `dist/` avoids most of the export getters Vite's module runner
  adds to `src/` cross-module calls. One call between tsdown's shared chunks
  still goes through a getter, so Vitest prints a getter warning; the
  overhead is small next to a recall.

## Releasing

The maintainer cuts a release; `.github/workflows/release.yml` publishes it
when a `v*` tag is pushed.

1. On a `chore/release-vX.Y.Z` branch, move the `CHANGELOG.md`
   `[Unreleased]` entries under the new version and run
   `pnpm version patch --no-git-tag-version` (or `minor`), which changes only
   `package.json`.
2. Open a PR titled `chore(release): vX.Y.Z` and squash merge it once CI
   passes. The tag is created after the merge, because a squash merge gives
   the commit a new SHA.
3. Pull `main`, then `git tag -a vX.Y.Z -m vX.Y.Z` and
   `git push origin vX.Y.Z`.
4. Once npm has the version, create the GitHub release.

The release workflow runs three stages:

- `verify` fails unless the tag equals `v` + the `package.json` version and
  the tagged commit is on `main`.
- `ci` runs `ci.yml` (through `workflow_call`) on the tagged commit: the Node
  matrix, the package lint and both Postgres integration jobs.
- `publish` runs in the `npm` GitHub environment, the only job with
  `id-token: write`. It installs without a dependency cache and runs
  `pnpm publish --no-git-checks`; `prepublishOnly` builds `dist/`. A version
  with a prerelease part (`0.6.0-rc.1`) gets the `next` dist-tag, any other
  `latest`. `--no-git-checks` is needed because a tag checkout is a detached
  HEAD; `verify` does the branch check instead.
  `--publish-wait-timeout 600000` keeps the job running until the version
  is installable: npm scans each upload before it shows up, which took about
  two minutes for 0.5.1. If it is not available after 10 minutes the job
  fails with `ERR_PNPM_PUBLISH_AVAILABILITY_TIMEOUT`, but the upload stays
  accepted and can still appear later, so check npm before retrying.

Publishing uses npm trusted publishing: pnpm exchanges the job's GitHub OIDC
(OpenID Connect) token for a short-lived npm token, so no npm token is
stored in the repository. npm then attaches a provenance attestation, a
signed statement of the repository, commit and workflow that built the
tarball, because the repository and the package are public. pnpm 11 and
newer does the exchange itself and does not need the npm CLI. Releases up to
0.5.0 were published from a laptop and have no provenance.

Repository and registry settings the workflow depends on:

- GitHub environment `npm` with a deployment rule that allows only `v*`
  tags.
- npm trusted publisher for `mnemocyte`: GitHub Actions, `Meenic` /
  `mnemocyte`, workflow `release.yml`, environment `npm`. npm does not check
  it when saved; a mistake shows up as a failed publish.
- After the first trusted publish, the package's publishing access is
  "Require two-factor authentication and disallow tokens". Trusted publishing
  keeps working under that setting.

A failed publish can be retried by re-running the workflow; the tag stays.
If the fix needs a new commit, delete the tag, merge the fix and tag again.
npm never accepts the same version twice, so once a version is published a
fix needs a new version.

GitHub release title: `mnemocyte vX.Y.Z`. Description:

```markdown
### Category
- **Short label**: concise description of the change

**Full Changelog**: https://github.com/Meenic/mnemocyte/compare/vPREVIOUS...vCURRENT
```

Categories: Performance, Accuracy, Reliability, Embedders, Documentation,
Tooling, API. Keep it factual, with no validation section.
