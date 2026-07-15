# Codebase Audit

**Checkpoint:** 9/16 items closed; working on stale planning documentation.

## Validation contract

Repository scripts and CI establish these required gates:

```bash
pnpm checktypes
pnpm lint
pnpm test
pnpm build
pnpm run pack:check
pnpm run test:integration
```

- `pnpm checktypes` runs strict source and test TypeScript checks.
- `pnpm lint` runs a read-only Biome formatting, lint, and import check and
  fails on warnings; `pnpm lint:fix` applies its safe fixes.
- `pnpm test` delegates to `test:ci`, which builds and runs the Vitest `unit`
  and `package` projects with type checking.
- `pnpm build` produces the ESM root and embedder subpath artifacts through
  `tsdown`.
- `pnpm run pack:check` checks the npm tarball contents with `pnpm pack
  --dry-run`.
- `pnpm run test:integration` runs the serial Postgres project and requires a
  compatible Postgres + pgvector `DATABASE_URL`; it skips when the variable is
  absent.

Baseline on 2026-07-15:

- Strict source and test type checks passed.
- Biome formatting passed for all 53 applicable files.
- Biome lint completed with two unused-import warnings in
  `memory/client-core.ts` and `memory/postgres.ts`.
- Build passed and emitted the documented ESM root plus embedder artifacts.
- Unit/package tests passed: 14 files, 29 tests.
- Pack check passed and included only `dist/`, migrations, license, manifest,
  and README content.
- The integration project skipped its single database scenario because
  `DATABASE_URL` was not set. CI provisions pgvector/Postgres and runs it.
- The local default `node` is 22.17.0, below the declared `>=22.18` engine, so
  pnpm emitted an engine warning. CI covers Node 22.18 and 24; audit commands
  that needed a supported local runtime used the bundled Node 24.14.0.

## Structure & organization

- [x] **STR-01 (med): Split the mixed `memory/shared.ts` utility module.** The
  500-plus-line module combines defaults, runtime validation, ID/result mapping,
  embedding-provider orchestration, and backend filters. `ARCHITECTURE.md`
  already calls this boundary unclear, and `retrieval/scorer.ts` duplicates its
  public-memory clone to avoid importing the mixed module. Split these
  responsibilities into named internal modules, centralize public-memory
  cloning, and update the architecture map without changing the public API.
  Split the module into focused defaults, embeddings, filters, records,
  Postgres-record mapping, and validation leaves; all live references were
  redirected before deletion, the duplicate scorer clone was centralized, and
  the architecture map now names each responsibility. All required gates
  passed (16 test files/34 tests, with the database scenario skipped because
  `DATABASE_URL` is absent).

Evidence checked: the remaining directory layout follows responsibility
(`context`, `db`, `embedders`, `memory`, and `retrieval`), package entrypoints
are thin, and tests mirror product areas. New Postgres SQL belongs under
`db/queries`, provider helpers under `embedders`, shared orchestration under
`memory`, and output formatting under `context`.

## Naming & consistency

- [x] **NAM-01 (low): Make the batch access-update query name plural.**
  `markMemoryAccessed(db, memoryIds)` updates multiple records while the
  `MemoryStore` method and caller use `markMemoriesAccessed`; align the internal
  query name with its actual cardinality.
  Renamed the private Postgres query and its adapter import; all required gates
  passed (16 test files/34 tests, with the database scenario skipped because
  `DATABASE_URL` is absent).

Evidence checked: public APIs consistently use object parameters except the
documented `rememberMany(inputs)` compatibility exception; types use
`MemoryStore` for the planned abstraction; files and exported symbols otherwise
follow stable camelCase/PascalCase conventions.

## Duplication & dead code

- [x] **DED-01 (med): Remove confirmed orphaned internal helpers and imports.**
  Repository-wide reference counts find no callers for `getSignal`,
  `insertMemory`, `listMemories`, `deleteEventsForEntity`, the standalone
  `lexicalScore`, or `toScoredMemory`. The first migration-store refactor also
  left two unused candidate imports and one unused `Memory` import. None are
  exported from the package root or its embedder subpaths.
  Removed the helpers, their cascading private filter, and unused imports after
  a repository-wide reference check; all required gates passed (16 test
  files/34 tests, with the database scenario skipped because `DATABASE_URL` is
  absent).
- [x] **DED-02 (low): Centralize pgvector component serialization.**
  `formatVectorComponent` is duplicated byte-for-byte in `db/schema.ts` and
  `db/queries/memories.ts`. Move it to a focused database utility and add direct
  coverage for precision, negative zero, and non-finite rejection.
  Both schema and raw-query serialization now use `db/vector.ts`; five focused
  cases cover precision, negative zero, and each non-finite number category.
  All required gates passed (17 test files/39 tests, with the database scenario
  skipped because `DATABASE_URL` is absent).

Evidence checked: all package-root exports are exercised by the package runtime
or declaration tests. The duplicate public-memory clone is intentionally
resolved under `STR-01` because its current duplication is caused by the mixed
module boundary.

## Tests

- [x] **TST-01 (med): Make the Postgres retrieval benchmark initialize current
  metadata.** Its fresh-database setup applies only `0000_initial.sql`, but the
  current client requires `0001_add_mnemocyte_meta.sql`; a clean benchmark
  database therefore fails before measuring retrieval.
  The benchmark now applies both migrations and inserts only a missing default
  installation row, preserving an existing custom dimension. All required
  gates passed (17 test files/39 tests, with the database scenario skipped
  because `DATABASE_URL` is absent).

Evidence checked: Vitest has separate unit, package, and serial integration
projects; package exports and exported declarations are tested; migration
rendering, provider resilience, lifecycle, observability, pruning, duplicate
detection, consolidation, context formatting, result mapping, retrieval
quality, and Postgres metadata/error normalization have coverage. The only
skipped test is the explicit environment-gated Postgres scenario. Risky missing
coverage discovered during the audit is attached to `ERR-01` and `ERR-02`, not
easy isolated helpers.

## Documentation

- [x] **DOC-01 (high): Add a clone-to-build developer path to `README.md`.**
  The README documents consumer installation and API use, but not repository
  prerequisites, dependency installation, watch/build commands, validation
  semantics, or where new source/tests/migrations belong. A new contributor
  cannot currently follow one complete setup path.
  Resolved with prerequisites, clone/install, watch/build, validation,
  integration-shell, and responsibility-map guidance; all required gates passed
  (15 test files/31 tests, with Postgres skipped because `DATABASE_URL` is
  absent).
- [ ] **DOC-02 (med): Remove stale planning and performance sequencing.**
  `PERFORMANCE_REVIEW.md` still says work moves from 0.1.4 to 0.2.0 before the
  `MemoryStore` boundary, although 0.2.0 is published and the boundary is
  implemented locally. `ROADMAP.md` retains shipped milestone checklists despite
  its own rule that shipped details belong in `CHANGELOG.md`; architecture also
  names the removed `useDatabase` helper.
- [ ] **DOC-03 (low): Correct behavioral documentation details.**
  `TokenCounter` calls the default heuristic word-based although it is
  character-count based; `isMnemocyteError` claims cross-copy safety while its
  implementation is `instanceof`; and audit writes are intentionally
  best-effort but that failure behavior is not stated in the README audit
  section.

Evidence checked: README package exports, migrations, dimensions, HNSW
tradeoffs, provider-free OpenAI helper, error codes, and current pre-v1 surface
match the source and packed artifact. `CHANGELOG.md`, `PROJECT_MEMORY.md`, and
the main architecture status agree that 0.2.0 is published and the internal
0.3.0 `MemoryStore` work is unreleased.

## Error handling & logging

- [x] **ERR-01 (high): Reject non-finite embedder output as `EMBEDDING`.**
  `embedOne` and `embedMany` validate result count and dimensions but accept
  `NaN`/infinite components. In memory this stores invalid vectors and degrades
  scoring silently; Postgres later fails serialization and reports the wrong
  `DB` category. Add focused regression coverage before the fix.
  Resolved with single/batch regression tests and finite-component validation;
  `checktypes`, `lint`, `test` (15 files/31 tests), `build`, `pack:check`, and
  the environment-gated integration project all passed.
- [x] **ERR-02 (med): Normalize client configuration errors.** An explicitly
  empty `databaseUrl` currently selects the in-memory backend despite the
  documented validation error; a malformed URL leaks native `TypeError`; and an
  empty `embedder.model` is categorized as `VALIDATION` although malformed
  embedder configuration is documented as `CONFIG`. Add regression tests and
  preserve synchronous construction.
  Resolved with three failing-first regression cases and typed synchronous
  validation; all required gates passed (16 test files/34 tests, with the
  database scenario skipped because `DATABASE_URL` is absent).
- [ ] **ERR-03 (low): Clear the in-memory audit buffer on close.** The in-memory
  store clears memories but retains its audit array after the client is closed,
  unnecessarily retaining metadata for the remaining client lifetime.
- [ ] **BUG-01 (med): Decide `rememberMany` cancellation semantics.** Each
  `RememberInput` accepts a signal, but the batch call forwards only the first
  input's signal to the single embedder request. Record a reproduction and
  recommendation in the bug/human-input trackers rather than changing a public
  contract during cleanup.
- [ ] **BUG-02 (med): Define runtime tuning validation.** Zero/negative
  `maxTokens`, non-positive recency/access settings, negative/non-finite
  weights, and invalid candidate multipliers can produce ignored budgets,
  `NaN` scores, or invalid store limits. The accepted ranges and fallback-vs-
  rejection policy need maintainer judgment; record repros and a recommendation.
- [ ] **BUG-03 (med): Define metadata cloning/serialization semantics.**
  In-memory result cloning is shallow, so nested metadata can still alias caller
  objects, while Postgres JSONB serialization deep-copies only JSON-compatible
  values. Choosing deep-clone behavior also decides whether non-JSON metadata is
  supported; record this rather than silently changing behavior.

Evidence checked: Postgres operations normalize expected schema failures to
`MIGRATION` and other storage failures to `DB`; provider timeouts and aborts are
typed; observability hook failures are explicitly swallowed so telemetry cannot
change application behavior; audit swallowing is intentional and will be made
explicit under `DOC-03`. No console logging occurs in runtime code.

## Dependencies

- [ ] **DEP-01 (med): Align Node type declarations with the minimum tested
  runtime.** The package promises Node `>=22.18` and CI tests Node 22.18/24, but
  development currently uses `@types/node` 25.x, allowing accidental use of
  APIs unavailable on the minimum runtime. Pin the declaration major to Node 22
  and regenerate the lockfile.

Evidence checked against npm on 2026-07-15: `drizzle-orm` 0.45.2,
`postgres` 3.4.9, and `drizzle-kit` 0.31.10 are current stable releases;
Biome 2.4.15, tsdown 0.22.0, and Vitest 4.1.6 are only patch/minor releases
behind; TypeScript 7 is a new major and not a cleanup update. Every declared
dependency has a source, build, migration, test, or lint reference. Runtime
dependencies remain provider-SDK-free.

## Config & secrets

Evidence checked: no `.env` or credential file is tracked; `.env*` is ignored
except an optional example; all provider/database secrets come from caller
configuration or environment variables. The fallback Postgres URL in
`drizzle.config.ts` is an explicit localhost development default, not a
production credential. CI uses only local service credentials. No hardcoded API
keys, tokens, private keys, or production endpoints were found.

## Formatting & lint

- [x] **FMT-01 (med): Make lint a read-only, comprehensive CI gate.** The
  current `lint` script uses `--write`, so CI can mutate its checkout instead of
  proving it was clean; it also omits formatting/import-assist checks and allows
  the two unused-import warnings. Use a non-writing Biome check that fails on
  warnings, add an explicit fix script, and correct the stale command fact in
  `AGENTS.md` without restructuring that file.
  `pnpm lint` now runs `biome check --error-on-warnings .`, `pnpm lint:fix`
  owns write mode, and contributor/maintainer docs state the distinction; all
  required gates passed (16 test files/34 tests, with the database scenario
  skipped because `DATABASE_URL` is absent).

Evidence checked: `.editorconfig` and Biome agree on tabs for code and spaces
for Markdown/YAML; quote style and import organization are configured; all 53
applicable files pass the formatter; `git diff --check` and whitespace scans are
clean; no lint/type suppressions or prohibited test assertions exist.

## Deferred

Items will move here only after `BUGS_FOUND.md` and/or
`NEEDS_HUMAN_INPUT.md` contains the concrete reproduction, recommendation, and
one-line reason the decision exceeds a behavior-preserving cleanup pass.
