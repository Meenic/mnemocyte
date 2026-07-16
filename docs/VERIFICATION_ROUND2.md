# Verification Round 2

Date: 2026-07-16

Scope: independent re-verification of the cleanup checkpoint, the three
approved bug fixes, the `0.3.0` release notes, and the documentation move.
Historical summaries were used only to enumerate claims; results below come
from current source, executable reproductions, fresh searches, Git/npm state,
and gate output from this run.

## Verdict

- The code at `main`, tag `v0.3.0`, and the npm `latest` version is the same
  `0.3.0` release. `HEAD` and `v0.3.0` both resolve to
  `5770c431d89823d6c108604b1d4763af8030d7be`.
- The shipped behavior matches `README.md` and all 16 bullets in the
  `CHANGELOG.md` `[0.3.0]` section.
- All 16 entries in `CODEBASE_AUDIT.md` remain implemented. One documentation
  entry had new post-checkpoint drift: four canonical docs still described
  `0.3.0` as unreleased after the release commit. This round corrected those
  release-status facts.
- BUG-01, BUG-02, and BUG-03 demonstrate the approved behavior in fresh
  executable reproductions. BUG-03 was exercised against both in-memory and
  real Postgres/pgvector backends.
- The documentation move is intact: only `AGENTS.md`, `CHANGELOG.md`, and
  `README.md` are at repository root; no real obsolete root-doc path remains;
  and every detected relative Markdown link resolves.

## Environment and validation gates

Environment observed for this run:

- Node `v24.15.0`
- pnpm `11.1.1`
- Docker client/server `28.5.1`
- Postgres/pgvector image `pgvector/pgvector:pg17`
- `DATABASE_URL` was initially absent. A local container was started, the
  documented `CREATE EXTENSION vector` prerequisite was applied, and the
  integration project was rerun against it.

| Gate | What was actually run | Current result |
| --- | --- | --- |
| TypeScript | `pnpm checktypes` | Passed: source and test TypeScript checks exited 0. |
| Lint/format/imports | `pnpm lint` | Passed: 66 files checked, no fixes applied, no warnings. |
| Unit/package | `pnpm test` | Passed: build completed; 20 test files and 71 tests passed. |
| Standalone build | `pnpm build` | Passed: 14 ESM/declaration/map artifacts emitted. |
| Package contents | `pnpm run pack:check` | Passed for `mnemocyte@0.3.0`; tarball contained the documented `dist/`, migrations, license, manifest, and README files. |
| Postgres integration | `pnpm run test:integration` | Initial environment-preparation run failed because the installed pgvector extension was not enabled (`type "vector" does not exist`). After applying the documented prerequisite, the exact gate passed: 1 file and 1 test. This is a real Postgres pass, not a skip. |

## The 16 audit entries

Each row is claim -> fresh check -> result.

| Claim | What was actually checked | Result |
| --- | --- | --- |
| STR-01: split `memory/shared.ts` | Confirmed `src/memory/shared.ts` is absent; inspected the 11 focused files under `src/memory/`; confirmed `retrieval/scorer.ts` imports the shared `cloneMemory` mapper from `memory/records.ts`. | Confirmed. The split and centralized public-memory clone remain present. |
| NAM-01: plural access-update name | Searched current source/tests for both `markMemoryAccessed` and `markMemoriesAccessed`; inspected the query definition, store interface, both adapters, and caller. | Confirmed. Only the plural operation name is used. |
| DED-01: remove orphaned helpers/imports | Re-ran searches for `getSignal`, `insertMemory`, `listMemories`, `deleteEventsForEntity`, callable `lexicalScore`, and `toScoredMemory`; inspected public root/subpath exports. | Confirmed. Zero removed-helper matches in source/tests/package metadata and no public export. |
| DED-02: centralize pgvector serialization | Inspected `src/db/vector.ts`, both import sites, and `test/db/vector.test.ts`. | Confirmed. One serializer is shared; precision, negative zero, `NaN`, and both infinities are covered. |
| TST-01: benchmark initializes metadata | Inspected `ensureMigrations()` in `test/benchmarks/retrieval.bench.ts`. | Confirmed. It applies both migrations and uses `ON CONFLICT (key) DO NOTHING`, so an existing custom dimension is not overwritten. |
| DOC-01: contributor clone-to-build path | Read the current README development section and compared commands/paths with `package.json` and the tree. | Confirmed. Prerequisites, install, watch/build, validation, integration, and responsibility guidance are present and accurate. |
| DOC-02: remove stale planning/performance sequencing | Re-read architecture, roadmap, performance review, and project memory against current Git/npm release state. | Drift found. The cleanup-era corrections existed, but four canonical docs had become stale after `0.3.0` shipped. Their release-status wording was corrected in this round. |
| DOC-03: correct behavioral docs | Checked the `TokenCounter` comment, `isMnemocyteError` comment/implementation, README audit-failure behavior, and Postgres dimension-check scope. | Confirmed. Character-count, same-copy `instanceof`, best-effort audit writes, transaction exception, and embedding-dependent dimension checks all match implementation. |
| ERR-01: reject non-finite embeddings | Inspected `validateEmbedding()` and the single/batch regression tests; the full suite reran them. | Confirmed. Non-finite components throw `EMBEDDING` before storage in both single and batch paths. |
| ERR-02: normalize client configuration errors | Inspected synchronous constructor validation and focused tests for empty/malformed database URLs and empty embedder models. | Confirmed. Empty URL is `VALIDATION`; malformed URL and embedder model are `CONFIG`. |
| ERR-03: clear in-memory audit data on close | Inspected `createInMemoryStore().close()` and its store lifecycle regression test. | Confirmed. Both memories and the audit array are cleared. |
| DEP-01: Node 22 declarations | Checked `package.json`, `pnpm-lock.yaml`, and installed `node_modules/@types/node/package.json`. | Confirmed. Manifest is `^22.18.0`; lockfile and installed version are `22.20.1`. |
| FMT-01: read-only comprehensive lint | Checked package scripts and contributor guidance, then reran lint. Also ran `git diff --check` and searched for prohibited test assertions/suppressions. | Confirmed. Lint is read-only and warning-failing; 66 files passed; prohibited patterns had zero matches. |
| BUG-01 audit entry | Inspected both overload declarations and current orchestration, then ran the historical/approved signal scenarios and real Postgres positional batch use. | Confirmed; detailed reproduction below. |
| BUG-02 audit entry | Inspected tuning/max-token validation and ran the historical invalid values against the built package. | Confirmed; detailed reproduction below. |
| BUG-03 audit entry | Inspected JSON validation/cloning at client ingress, store boundaries, Postgres row mapping, audit mapping, and public result cloning; ran both backends. | Confirmed; detailed reproduction below. |

Fresh supporting searches also found:

- zero callable matches for the removed DED-01 helpers;
- zero public declaration matches for `MemoryStore`;
- zero runtime `console.*` statements;
- zero prohibited test assertion/type-suppression patterns;
- zero tracked `.env` files and zero matches for the secret patterns checked;
- zero provider-SDK imports in the root/core graph.

## BUG-01 reproduction: batch cancellation

The historical positional scenario was rerun with an embedder that waits for
its supplied signal.

Observed output:

```text
BUG01_POSITIONAL_SECOND_ABORT=result:completed returned:2 stored:2
BUG01_POSITIONAL_FIRST_ABORT=result:ABORTED
BUG01_POSITIONAL_FIRST_ABORT_STORED=0
BUG01_OBJECT_BATCH_ABORT=result:ABORTED
BUG01_OBJECT_BATCH_ABORT_STORED=0
```

Result:

- The deprecated positional `rememberMany(inputs)` path works end to end and
  persists both records.
- Aborting a later positional item's signal does not cancel the batch.
- The first positional item's signal remains the compatibility batch signal.
- The canonical object form uses its explicit batch signal and stores nothing
  when aborted.
- The real Postgres integration scenario also exercised the positional overload
  and completed successfully.

## BUG-02 reproduction: tuning and token budgets

The historical invalid values were rerun independently so each approved
boundary could be observed.

Observed output:

```text
BUG02_CONFIG_nan_weight=CONFIG
BUG02_CONFIG_zero_half_life=CONFIG
BUG02_CONFIG_negative_access_saturation=CONFIG
BUG02_CONFIG_fractional_candidate_multiplier=CONFIG
BUG02_MAXTOKENS_OMITTED=result:success type:string
BUG02_MAXTOKENS_ZERO=VALIDATION
```

Result: construction rejects invalid retrieval tuning with `CONFIG`; an omitted
`maxTokens` uses the default path; an explicitly invalid value is rejected with
`VALIDATION` before embedding.

## BUG-03 reproduction: JSON value semantics and deep cloning

The mutation-after-return scenario was run against both storage backends.

Observed output:

```text
BUG03_IN-MEMORY=returned:gold firstRecall:gold secondRecall:gold
BUG03_POSTGRES=returned:gold firstRecall:gold secondRecall:gold
```

For each backend, the check:

1. remembered metadata with nested objects and arrays;
2. mutated caller input after `remember()` returned;
3. mutated the returned `Memory.metadata`;
4. recalled and verified the stored nested value was still `"gold"`;
5. mutated recalled metadata and recalled again;
6. verified the stored nested value was still `"gold"`.

Result: ingress and egress are independently cloned in both backends. The real
Postgres result confirms behavior across the JSONB serialization boundary.
Focused tests also confirm unsupported/cyclic metadata is rejected before
embedding and in-memory audit metadata is cloned at ingress and egress.

## `CHANGELOG.md` 0.3.0 verification

The section contains 16 release bullets: 3 breaking changes, 8 changed items,
and 5 fixes. Each was checked against current code/tests rather than accepted
from the release notes.

| Release-note group | Current evidence | Result |
| --- | --- | --- |
| BUG-03 JSON metadata | Exported declarations use `JsonObject`/`JsonValue`; shared runtime validation rejects unsupported/cyclic data; both backend reproductions preserved nested values after mutations. | Matches shipped code. |
| BUG-02 tuning validation | Constructor validation and `buildContext` validation produce the documented codes; reproduction covered representative invalid values and omission. | Matches shipped code. |
| BUG-01 batch cancellation | Object and deprecated positional overloads exist; reproduction confirmed signal ownership and return/storage behavior. | Matches shipped code. |
| Internal `MemoryStore` and shared orchestration | Private `MemoryStore` interface exists; both adapters feed `createMemoryClient`; no `MemoryStore` appears in public declarations. | Matches shipped code. |
| Narrower Postgres metadata checks | Compatibility checks occur on embedding-dependent paths; focused tests show non-embedding operations do not read metadata. | Matches shipped code. |
| Provider timeout aborts | `runAttempt()` aborts a per-attempt controller on timeout; focused resilience coverage observes the provider signal abort. | Matches shipped code. |
| Read-only lint and focused memory modules | Package scripts, current layout, and the fresh lint gate match the descriptions. | Matches shipped code. |
| Benchmark metadata and Node declarations | Benchmark applies both migrations without overwriting an existing row; Node declarations resolve to `22.20.1`. | Matches shipped code. |
| Non-finite embeddings and config errors | Source checks, focused regressions, and the full suite match the documented error categories. | Matches shipped code. |
| In-memory close and public result mapping | Close clears audit state; `cloneMemory` omits internal embeddings; remember/recall/duplicate tests verify public results. | Matches shipped code. |
| Postgres error normalization | Expected migration codes map to `MIGRATION`; other expected query/storage failures map to `DB`; focused tests and real integration passed. | Matches shipped code. |

No behavioral or release-note mismatch was found in `[0.3.0]`.

## Documentation move verification

Moved files checked:

```text
ARCHITECTURE.md
BUGS_FOUND.md
CODEBASE_AUDIT.md
NEEDS_HUMAN_INPUT.md
PERFORMANCE_REVIEW.md
PROJECT_MEMORY.md
ROADMAP.md
SUMMARY.md
```

Fresh grep/link results:

- Full filename grep produced only valid `docs/` paths, valid same-directory
  references inside `docs/`, and explicitly historical prose.
- Obsolete root Markdown links outside `docs/`: 0.
- Moved-doc filename references in non-Markdown source/config/test files: 0.
- Obsolete `../MOVED_FILE.md` or root-absolute links inside `docs/`: 0.
- Before this report was added, the repository contained 12 Markdown files.
  The completed tree contains 13.
- Root Markdown files: exactly 3 (`AGENTS.md`, `CHANGELOG.md`, `README.md`).
- Relative local links detected and checked in the completed tree: 9; broken:
  0. External URLs and anchor-only links skipped by the local-path check: 31.

## Drift and corrections

Fresh drift found:

1. `docs/ARCHITECTURE.md` called `0.2.0` current and `0.3.0` locally
   unreleased.
2. `docs/ROADMAP.md` still used `0.3.0` as the future public-store milestone.
3. `docs/PROJECT_MEMORY.md` called `0.3.0` unreleased and described release
   preparation as pending.
4. `docs/PERFORMANCE_REVIEW.md` called the internal-store line unreleased.
5. Adding this report would make `docs/DOCS_AUDIT.md`'s unqualified 12-file
   inventory stale.

Corrections made:

- Updated the four canonical status/planning documents to state that `0.3.0`
  is published while the public `MemoryStore` contract remains future work.
- Marked `DOCS_AUDIT.md` as the historical 12-file move-audit snapshot and
  identified this report as a later addition.

No code, public API, migration, dependency, or package-export change was made.

## Deferred items

`CODEBASE_AUDIT.md` has no unresolved small cleanup item; its three behavior
deferrals are BUG-01 through BUG-03 and remain resolved.

The four entries under `DOCS_AUDIT.md` Deferred remain genuine judgment calls:

- acceptable per-entity scale for quadratic in-memory duplicate detection;
- performance priority/risk/threshold choices without production workload data;
- possible future provider-package/monorepo direction;
- future adapter milestone numbering and ordering.

They were not decided during this verification pass. They are logged fresh
under the round-two section of `NEEDS_HUMAN_INPUT.md`.

## Published-package/documentation assessment

Plain result:

- The `0.3.0` implementation matches the behavior documented in the shipped
  README and the released changelog.
- The repository at the release tag had no behavior-documentation mismatch,
  but it did have stale release-status wording in four repository-only
  architecture/planning documents.
- Those status facts are corrected in this round. After the corrections, the
  current working tree's canonical documentation and the published `0.3.0`
  behavior agree.
