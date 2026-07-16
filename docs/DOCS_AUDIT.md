# Documentation Audit

Historical scope: every Markdown file in the repository immediately after the
root-document move. Each entry records the claims that were checked against
source, tests, configuration, Git history, or repository layout before the
audit was closed.

Round-two verification later added `VERIFICATION_ROUND2.md`. The 12-file count
below is therefore the completed move-audit snapshot, not the current repository
Markdown count. `PROPOSALS.md` was also added later; the current repository has
14 Markdown files, with `AGENTS.md`, `CHANGELOG.md`, `PROPOSALS.md`, and
`README.md` at the root.

## Phase 0 move verification

- [x] **MOVE-01:** Kept `AGENTS.md`, `README.md`, and, by follow-up request,
  `CHANGELOG.md` at repository root; moved `ARCHITECTURE.md`, `BUGS_FOUND.md`,
  `CODEBASE_AUDIT.md`, `NEEDS_HUMAN_INPUT.md`, `PERFORMANCE_REVIEW.md`,
  `PROJECT_MEMORY.md`, `ROADMAP.md`, and `SUMMARY.md` to `docs/` with
  `git mv`. No nested Markdown files required a tooling-location exception.
- [x] **MOVE-02:** Updated root-origin links and path facts in `README.md` and
  `AGENTS.md`, plus references from moved files back to root `AGENTS.md`,
  `README.md`, and `CHANGELOG.md`. Links among moved files remain valid because
  those files moved together.
- [x] **MOVE-03:** Searched the repository for every moved filename. Remaining
  hits are updated `docs/` paths, valid same-directory references inside
  `docs/`, or historical prose rather than an obsolete root path. No source,
  test, package, CI, migration, or script file contains an old root-doc path.

## File checklist

- [x] **DOC-01 — `AGENTS.md`:** Verified project constraints, required reading
  paths, public API conventions, validation commands, integration prerequisites,
  and release guidance against source, package scripts, CI, and repository
  layout. Corrected `MemoryStore` from wholly planned to the existing internal
  boundary whose public adapter surface remains future work.
- [x] **DOC-02 — `README.md`:** Verified installation and migration instructions,
  all public API examples/signatures, metadata and tuning validation behavior,
  error codes, provider behavior, development commands, and source-placement
  guidance against package metadata, exports, source, tests, and CI. Corrected
  provider timeout scope, the timing of Postgres dimension validation, the
  missing batch-controller declaration, and positional batch-signal behavior.
- [x] **DOC-03 — `docs/ARCHITECTURE.md`:** Verified release/status claims,
  dependency and module maps, public surface, error model, schema/query examples,
  write/retrieval/context behavior, limitations, and roadmap status against the
  actual tree, package manifest, migrations, implementation, CI, npm's reported
  `0.2.0` version, and Git tags. Corrected the 0.3 API status, Node declarations
  and support policy, module/type maps, internal filter array mutability,
  extension prerequisite, metadata write order, dimension-check scope,
  completed production tasks, and 0.3 roadmap details.
- [x] **DOC-04 — `docs/BUGS_FOUND.md`:** Verified each historical reproduction,
  current resolution description, error behavior, API shape, and linked commit
  against current source, focused regression tests, and Git history. The
  entries are accurate historical records and required no content correction.
- [x] **DOC-05 — `CHANGELOG.md`:** Verified `[Unreleased]` against the
  current branch, including breaking metadata, tuning, and `rememberMany`
  behavior and the post-`v0.2.0` commit range. Clarified that the internal
  `MemoryStore` refactor preserved the API before separate breaking changes
  landed. Published history and GitHub compare links remain untouched.
- [x] **DOC-06 — `docs/CODEBASE_AUDIT.md`:** Verified checkpoint/status,
  command and path facts, resolved follow-up links, and any claims presented as
  current against package scripts, CI, source, and Git history. Labeled the
  checkpoint as the completed cleanup checkpoint, updated root-file paths and
  `MemoryStore` / `rememberMany` status, and retained dated baseline counts and
  dependency observations as historical evidence.
- [x] **DOC-07 — `docs/NEEDS_HUMAN_INPUT.md`:** Verified the approved option,
  implemented behavior, public types/errors, compatibility decision, and commit
  link for BUG-01 through BUG-03 against source, tests, and Git history. The
  resolved decision record required no content correction.
- [x] **DOC-08 — `docs/PERFORMANCE_REVIEW.md`:** Verified benchmark commands,
  implementation-path references, shipped/planned status, measured claims, and
  performance limitations against scripts, source, package scripts, and Git
  state. Removed resolved tuning semantics from the outstanding architecture
  follow-ups; the remaining implementation descriptions match current code.
- [x] **DOC-09 — `docs/PROJECT_MEMORY.md`:** Verified current release/unreleased
  version claims, implementation and provider constraints, commands, CI/runtime
  facts, v1 notes, and suggested next steps against package metadata, source,
  workflow files, npm's reported version, Git tags, and roadmap state. Corrected
  the metadata grammar, full positive-integer `maxTokens` rule, internal/public
  `MemoryStore` status, root README and AGENTS paths, and completed-validation
  next step.
- [x] **DOC-10 — `docs/ROADMAP.md`:** Verified shipped versus planned feature
  status, API names, dependency direction, migration plans, and cross-links
  against current source, the unreleased changelog, package layout, migrations,
  and tests. Current capabilities are separated from future public
  `MemoryStore`, adapter, MCP, and runtime work; no factual correction was
  required.
- [x] **DOC-11 — `docs/SUMMARY.md`:** Verified cleanup/fix commit links,
  sequencing, historical and current file/test counts, validation/runtime
  claims, resolved tracker status, and scope statements against Git history and
  the final repository. Added the required per-file account of moves, factual
  corrections, reference updates, unchanged verified files, and final
  documentation checks.
- [x] **DOC-12 — `docs/DOCS_AUDIT.md`:** Verified this inventory contains one
  entry for each of the 12 final Markdown files, all checklist statuses match
  completed evidence, the move and local-link checks remain true, and all
  unverified judgment or planning claims are recorded under Deferred with a
  reason.

## Deferred

- **DEF-01 (`DOC-03`):** The statement that quadratic in-memory duplicate
  detection is acceptable for typical per-entity sizes is qualitative and has
  no workload threshold or benchmark in the repository. It remains unchanged
  as an explicitly unverified operational judgment.
- **DEF-02 (`DOC-08`):** Performance priority order, risk labels, and “worth
  doing” thresholds are maintainer judgments without representative production
  workload data in the repository. They remain unchanged rather than being
  guessed from synthetic benchmarks.
- **DEF-03 (`DOC-09`):** Moving provider adapters from subpaths into future
  monorepo packages is a maintainer direction with no implementation or dated
  commitment in the repository. It remains unchanged as forward-looking intent.
- **DEF-04 (`DOC-10`):** The `0.3.0` through `0.5.0` adapter milestones and
  their ordering are maintainer planning targets, not facts that current source
  or tests can prove. They remain unchanged as explicitly forward-looking
  roadmap intent.
