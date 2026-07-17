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

## Historical Deferred Register — Resolved 2026-07-17

These judgments were correctly deferred during the original source-verification
pass. Maintainer direction later resolved them in
[`NEEDS_HUMAN_INPUT.md`](./NEEDS_HUMAN_INPUT.md):

- **DEF-01 (`DOC-03`):** The in-memory backend is for development and
  prototyping. Its quadratic duplicate scan degrades noticeably past roughly a
  few thousand memories per entity; Postgres is recommended beyond that scale.
- **DEF-02 (`DOC-08`):** Performance priority is qualitative: correctness and
  data integrity, hot-path `recall` / `buildContext` latency, write throughput,
  then tooling and benchmarks. No global numeric thresholds were invented.
- **DEF-03 (`DOC-09`):** Provider helpers remain on package subpaths until a
  second provider or a heavy/conflicting SDK dependency triggers a fresh
  package-boundary review.
- **DEF-04 (`DOC-10`):** The confirmed sequence is public `MemoryStore`
  stabilization, `drizzleStore(db)` at `0.4.0`, then `@mnemocyte/mcp` at
  `0.5.0`.

## 2026-07-17 Full Staleness Sweep

Scope: all 14 Markdown files in the repository after `CONSOLIDATION-01` and the
four `DOCS-DEF` decisions landed. Current claims were checked against source,
public types, migrations, package metadata and exports, CI configuration,
tests, Git history/tags, the packed artifact, and the npm registry. Historical
counts and environment observations were retained only where their files
clearly label them as dated snapshots.

Repository-wide checks found 14 Markdown files, no broken relative Markdown
links, no missing local commits among the linked Mnemocyte commit URLs, and no
obsolete moved-document path in live source, test, package, migration, or CI
configuration.

### Current File Checklist

- [x] **SWEEP-01 — `AGENTS.md`:** Verified repository boundaries, required
  reading paths, ESM/provider/storage rules, validation commands, test
  restrictions, and manual-release policy against the tree, package scripts,
  source imports, CI, and release workflow constraints. No correction was
  needed.
- [x] **SWEEP-02 — `CHANGELOG.md`:** Compared `[Unreleased]` with
  `v0.3.0..HEAD`, current behavior, migrations, and focused tests. Confirmed
  `CONSOLIDATION-01` documents survivor-specific idempotency, atomic mixed
  rejection, and concurrent Postgres locking; published sections remain
  historical release records. No additional sweep correction was needed.
- [x] **SWEEP-03 — `PROPOSALS.md`:** Verified all 22 proposal headings have
  approvals, resolution statuses, and valid local commit targets. Updated the
  current preface to say the register is closed, noted the later resolution of
  the four documentation judgments, and added the concrete
  `CONSOLIDATION-01` resolution.
- [x] **SWEEP-04 — `README.md`:** Verified install/migration paths, root and
  embedder exports, public method examples, validation/error behavior,
  consolidation conflict semantics, cancellation boundaries, backend
  limitations, development commands, and source-placement guidance. The Phase
  1 and Phase 2 edits already supplied the needed consolidation and in-memory
  scale corrections.
- [x] **SWEEP-05 — `docs/ARCHITECTURE.md`:** Verified module and public-surface
  maps, error model, schema/index baseline, current query/storage behavior,
  lifecycle, limitations, and future adapter boundaries. Distinguished the
  published `v0.3.0` tag from newer `[Unreleased]` source/migration `0002`,
  clarified idempotent close versus post-close operation rejection, and
  replaced a nonexistent event-pruning API implication with explicit database
  maintenance guidance.
- [x] **SWEEP-06 — `docs/BUGS_FOUND.md`:** Rechecked the three historical
  reproductions, current approved behavior, error codes, compatibility
  overload, JSON semantics, and linked commits. The file is explicitly
  historical and required no correction.
- [x] **SWEEP-07 — `docs/CODEBASE_AUDIT.md`:** Verified current command/path
  statements and all resolved item outcomes against source and Git history.
  Dated baseline counts, runtime versions, and dependency observations remain
  clearly scoped to their 2026-07-15/16 checkpoint, so no rewrite was needed.
- [x] **SWEEP-08 — `docs/DOCS_AUDIT.md`:** Preserved the original move-audit
  checklist as history, marked its four deferred judgments resolved, and added
  this complete current 14-file checklist and evidence record.
- [x] **SWEEP-09 — `docs/NEEDS_HUMAN_INPUT.md`:** Verified the three behavior
  decisions against public types/tests and the four documentation decisions
  against their affected current docs. Corrected the preface to state that no
  entry remains open.
- [x] **SWEEP-10 — `docs/PERFORMANCE_REVIEW.md`:** Checked every active item
  against current query and adapter mechanics. Confirmed the backlog follows
  the decided qualitative order—correctness/data integrity, hot-path latency,
  write throughput, then tooling/benchmarks—and does not present synthetic
  fixture sizes as universal thresholds.
- [x] **SWEEP-11 — `docs/PROJECT_MEMORY.md`:** Verified release status with the
  local tag and npm registry, current implementation facts against source/tests,
  CI/runtime statements against workflow/package configuration, and roadmap
  direction. Clarified that repository source is ahead of published `v0.3.0`
  and that all 22 existing proposal entries are resolved.
- [x] **SWEEP-12 — `docs/ROADMAP.md`:** Verified shipped capabilities against
  source and kept them out of forward-looking milestone detail. Confirmed the
  settled provider-subpath policy and public `MemoryStore` →
  `drizzleStore(db)` `0.4.0` → `@mnemocyte/mcp` `0.5.0` sequence.
- [x] **SWEEP-13 — `docs/SUMMARY.md`:** Verified commit links and historical
  run boundaries, added the required account of this run, and corrected older
  paragraphs that could still read as if `CONSOLIDATION-01` were currently
  open or untouched.
- [x] **SWEEP-14 — `docs/VERIFICATION_ROUND2.md`:** Verified its tag/hash,
  move, release, and resolved-bug claims against Git and current source. Kept
  its environment/count results as an explicitly labeled 2026-07-16 snapshot
  and retained the Phase 2 note that all four then-deferred documentation
  judgments were resolved later.

### Deferred

None. Workload-specific optimization evidence is still required before
implementing performance or index changes, but that is an intentional backlog
condition rather than an unresolved documentation fact.
