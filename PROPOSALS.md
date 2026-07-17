# Mnemocyte Improvement Proposals

Fresh audit date: 2026-07-16
Audited revision: `16c2d13`

The findings and baseline counts below are the dated audit snapshot from that
revision. Approval and status fields are maintained afterward: blank approval
fields remain pending, while resolved entries link their implementation
commits.

This pass inspected the current source, tests, migrations, package boundary,
CI, prior audit records, and the `0.3.0` release changes. Resolved items from
`docs/CODEBASE_AUDIT.md`, `docs/BUGS_FOUND.md`, and `CHANGELOG.md` are not
re-proposed. Existing workload-dependent performance questions in
`docs/PERFORMANCE_REVIEW.md` and `docs/NEEDS_HUMAN_INPUT.md` are also not
duplicated.

Baseline checks passed before this document was written:

- `pnpm checktypes`
- `pnpm test` — 20 files / 71 tests
- `pnpm audit --prod` — no known vulnerabilities

Targeted reproductions used the built package and, where noted, an isolated
Postgres 17 + pgvector container with a two-dimensional rendered migration.
The containers were removed after the reproductions. No scratch source or test
files were retained.

## High risk

### PRUNE-01 — Reject malformed selectors before a destructive prune

- id: `PRUNE-01`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/memory/validation.ts`, `src/memory/filters.ts`,
  `src/memory/postgres.ts`, `src/db/queries/memories.ts`
- what-was-found: `validatePruneInput()` checks only that a selector-shaped
  property is present, not that its runtime value is valid. In an executable
  in-memory reproduction, `prune({ createdBefore: new Date("invalid") })`
  matched and deleted both stored memories because every comparison with
  `NaN` fell through as a match. The same call on Postgres failed with `"DB"`
  and deleted nothing, so the backends disagree. More severely,
  `prune({ maxImportance: "bogus" as never })` deleted every memory in both
  backends: the in-memory rank comparison used `undefined`, while the Postgres
  adapter converted the unknown ceiling to an empty filter and issued an
  unbounded delete. The Postgres reproduction deleted five rows spanning
  unrelated entities.
- proposed: Exhaustively validate every `PruneInput` field before calling the
  store: finite valid `Date` instances, known importance/type values, arrays of
  valid strings/enums, and actual booleans for `expired`, `superseded`, and
  `dryRun`. Build a validated internal prune filter and reject if that filter
  has no effective selector after normalization. The store adapters should
  accept only that validated filter rather than the public input.
- how-verified: Add failing-first parity tests for invalid dates, unknown
  importance/type values, malformed arrays, and non-boolean flags. For every
  case, assert a `"VALIDATION"` error occurs before store access and that
  memory counts remain unchanged in both backends. Add a direct adapter test
  proving an empty normalized Postgres filter cannot reach `DELETE`.
- approval: yes
- status: resolved in
  [`e99a1d3`](https://github.com/Meenic/mnemocyte/commit/e99a1d3c15ace4feb3af9e3c0249d4c64288217e)

### EMBED-01 — Reject zero-norm embeddings used with cosine distance

- id: `EMBED-01`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/memory/embeddings.ts`, `src/retrieval/scorer.ts`,
  `src/db/queries/memories.ts`
- what-was-found: Embedding validation accepts all-zero vectors even though
  cosine similarity is undefined for them. pgvector returned `NaN` for
  `'[0,0]'::vector <=> '[1,0]'::vector`; PostgreSQL also evaluated the derived
  `NaN >= 0.95` predicate as true. Through the public Postgres client, two
  zero-vector memories made `findDuplicates({ threshold: 0.95 })` return one
  pair with reported `similarity: 0`, which is below the requested threshold.
  A forced HNSW query also omitted the stored zero vector from the index result,
  while the in-memory backend retains and scans zero vectors.
- proposed: Extend shared embedding validation to reject vectors whose norm is
  zero, for both stored content and recall queries, with error code
  `"EMBEDDING"` before any storage or vector comparison. Keep the check in the
  shared embedding boundary so both adapters and every provider helper inherit
  the same rule.
- how-verified: Add single and batch zero-vector tests that assert
  `"EMBEDDING"` before storage. Add a Postgres regression showing zero vectors
  never reach duplicate or recall SQL, plus an in-memory parity test. Retain
  near-zero but nonzero coverage so the check does not become an arbitrary
  magnitude threshold.
- approval: yes
- status: resolved in
  [`1e8a512`](https://github.com/Meenic/mnemocyte/commit/1e8a51233081bf9607431c85fab8aeb68c454cb7)

### EMBED-02 — Enforce embedding-model compatibility, not dimensions alone

- id: `EMBED-02`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/memory/postgres.ts`, `src/db/queries/meta.ts`,
  `src/db/schema.ts`, `migrations/`, `src/types.ts`
- what-was-found: Every memory stores `embeddingModel`, and the `Embedder`
  documentation says model/dimension metadata is used to detect incompatible
  vectors, but the Postgres compatibility check reads only installation
  dimensions. A real Postgres reproduction wrote a memory with `"model-a"` and
  then opened a new client using `"model-b"` with the same dimensions. Recall
  succeeded, compared the two incompatible vector spaces, and returned the
  `"model-a"` row to the `"model-b"` query. `findDuplicates()` can likewise
  compare rows produced by different models.
- proposed: Add installation-level embedding-model identity alongside
  dimensions and validate both before writes, recall, and duplicate scans.
  Define a migration/repair path for databases that already contain one or
  more model values: infer and record the single existing model when
  unambiguous, and fail with `"MIGRATION"` or `"CONFIG"` when mixed rows need
  explicit operator action. Continue storing the model per row for diagnosis
  and future re-embedding workflows.
- how-verified: Create a Postgres database with model A data, then assert a
  same-dimension model B client fails before calling its embedder. Cover
  matching-model success, empty installations, mixed historical rows, and
  non-embedding recovery operations. Verify migration rendering and package
  contents include the new metadata change.
- approval: yes
- status: resolved in
  [`e0b80a5`](https://github.com/Meenic/mnemocyte/commit/e0b80a5ec0bca2cb77f0a5d778f9d1e5c6530f93)

### RETRIEVAL-01 — Align negative cosine candidate handling across backends

- id: `RETRIEVAL-01`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/memory/client-core.ts`, `src/memory/in-memory.ts`,
  `src/db/queries/memories.ts`, `src/retrieval/scorer.ts`
- what-was-found: Shared scoring clamps negative vector similarity to zero, and
  the in-memory vector search does the same before candidate selection.
  Postgres instead applies `1 - distance >= 0` before shared scoring. With a
  stored vector `[-1, 0]` and query `[1, 0]`, the in-memory backend returned the
  memory with `scores.vector: 0` and a positive final score from the other
  components, while Postgres returned no candidate at all. This is a confirmed
  backend-parity failure on the core recall path.
- proposed: Give `MemoryStore.vectorSearch()` one explicit candidate-score
  contract. In Postgres, compute a finite clamped vector component equivalent
  to the in-memory `max(0, cosine)` rule and apply any vector cutoff to that
  value, rather than filtering raw negative cosine values before fusion.
  Keep final-score filtering in shared orchestration.
- how-verified: Add the signed-vector reproduction to both backend suites and
  assert identical IDs, vector components, and final scores. Include cosine
  values at `-1`, just below `0`, `0`, and `1`, with and without a positive
  final `minScore`.
- approval: yes
- status: resolved in
  [`542cf4c`](https://github.com/Meenic/mnemocyte/commit/542cf4c8c40fa1e9c8a816378ab39caad2d74a28)

### SERIALIZATION-01 — Preserve small finite vector components in Postgres

- id: `SERIALIZATION-01`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/db/vector.ts`, `src/db/schema.ts`,
  `src/db/queries/memories.ts`, `test/db/vector.test.ts`
- what-was-found: The centralized serializer uses `value.toFixed(17)`.
  `formatVectorComponent(1e-20)` and `formatVectorComponent(1e-18)` both
  produce `"0.00000000000000000"`, changing nonzero values to zero. A public
  Postgres reproduction remembered `[1e-20, 0]`; direct inspection showed the
  stored pgvector value was `[0,0]`. pgvector itself accepts `[1e-20,0]`, so
  the loss occurs in Mnemocyte's serializer. This can change cosine results
  and can turn a valid nonzero vector into the zero-vector case described in
  `EMBED-01`.
- proposed: Replace fixed-decimal formatting with a round-trip-safe finite
  number serializer. If scientific notation must remain excluded, expand the
  canonical number string to decimal form without rounding away significant
  digits. Use the same implementation for inserts and raw query vectors.
- how-verified: Add round-trip cases covering tiny positive/negative values,
  zero, negative zero, ordinary decimals, and large finite values. Run a real
  Postgres test that stores and reads representative float4-range components
  and compares them with pgvector's expected float4 rounding rather than exact
  JavaScript double equality. Confirm recall parity for a vector whose ranking
  depends on a small component.
- approval: yes
- status: resolved in
  [`5d779c0`](https://github.com/Meenic/mnemocyte/commit/5d779c0b372185f56b15142d21e0a017c3390742)

### CANCELLATION-01 — Make every advertised operation signal observable

- id: `CANCELLATION-01`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/memory/client-core.ts`, `src/memory/store.ts`,
  `src/memory/in-memory.ts`, `src/memory/postgres.ts`, `src/resilience.ts`
- what-was-found: `PruneInput`, `FindDuplicatesInput`, `ListAuditLogInput`, and
  `ConsolidateInput` expose `signal`, but shared orchestration and both stores
  ignore it. With one already-aborted signal, an executable reproduction
  successfully previewed prune matches, returned duplicate pairs, returned
  audit events, and superseded a memory. The consolidated mutation completed
  with `supersededCount: 1` instead of throwing `"ABORTED"`. This is especially
  risky for destructive prune/consolidation calls.
- proposed: Check `throwIfAborted()` at the shared operation boundary before
  any store work. Pass a cancellation context through `MemoryStore`; check it
  periodically in in-memory scans and before transactional mutations. Use
  supported postgres.js cancellation for in-flight queries where available.
  Where a committed database mutation cannot be rolled back after caller
  cancellation, define and document the exact commit/cancellation boundary
  rather than claiming stronger semantics.
- how-verified: Add pre-aborted and mid-operation tests for all four methods on
  both adapters. Assert pre-aborted destructive calls make no changes. Use a
  deliberately slow in-memory scan and a controllable Postgres query or
  transaction to verify mid-operation behavior and error code `"ABORTED"`.
- approval: yes
- status: resolved in
  [`1591a92`](https://github.com/Meenic/mnemocyte/commit/1591a92e3323de2fe977d1a75cc67fe089c6df59)

### LIFECYCLE-01 — Coordinate `close()` with in-flight operations

- id: `LIFECYCLE-01`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/memory/client-core.ts`, `src/memory/store.ts`,
  `src/memory/in-memory.ts`, `src/memory/postgres.ts`
- what-was-found: The client tracks only a boolean checked at operation start.
  In a controlled reproduction, `remember()` paused inside the embedder,
  `close()` completed and cleared the in-memory store, then the embedder was
  released; the original `remember()` resolved successfully and inserted a new
  memory after close. On Postgres the analogous race can continue against a
  pool that is closing or closed. A failed `store.close()` also leaves the
  boolean permanently closed, preventing a retry.
- proposed: Replace the boolean with an `open` / `closing` / `closed` state and
  track active operations. Reject new calls once closing starts, have
  `close()` await already-started operations before closing the store, and
  share one close promise across concurrent/idempotent calls. Define how a
  close failure affects retryability instead of setting final state before the
  store result is known.
- how-verified: Add deterministic delayed-embedder and delayed-store tests.
  Assert close does not resolve until admitted operations settle, no write can
  occur after the store closes, new calls fail once closing starts, concurrent
  close calls share the result, and a simulated store-close failure follows
  the chosen retry policy.
- approval: yes
- status: resolved in
  [`e91e4e7`](https://github.com/Meenic/mnemocyte/commit/e91e4e7734ac724f234add514dfa6d1b5d52ec10)

### CONSOLIDATION-DELETE-01 — Decide how deleting a consolidation survivor works

- id: `CONSOLIDATION-DELETE-01`
- category: `behavior-change`
- risk-tier: `high`
- where: `src/memory/client-core.ts`, `src/memory/in-memory.ts`,
  `src/db/schema.ts`, `migrations/0000_initial.sql`,
  `migrations/0000_initial.sql.template`
- what-was-found: This is an open product/data-integrity question, not an
  implementation-only decision. After consolidating loser B into survivor A,
  the in-memory backend allows `forget(A)` and leaves B with a dangling
  `supersededBy` ID. Postgres rejects the same public call because the
  self-referencing foreign key uses `ON DELETE NO ACTION`; the client surfaces
  `"DB"`. The backends therefore disagree, and neither behavior is documented.
  No existing Round 2 entry in `docs/NEEDS_HUMAN_INPUT.md` covers survivor
  deletion.
- proposed: Open question for maintainer approval: should deleting a survivor
  (1) be rejected consistently while dependents exist, (2) cascade-delete its
  superseded chain, or (3) detach/repoint dependents? No default is selected in
  this audit. Once decided, encode the same rule in the in-memory adapter,
  Postgres foreign key/migration, typed error behavior, and public docs.
- how-verified: Add parity tests that consolidate a chain and then exercise
  `forget`, `forgetAll`, and `prune` against the survivor. Verify no dangling
  references remain and Postgres constraints implement the approved policy.
- approval: yes (option 1 — reject delete while dependents exist)
- status: resolved in
  [`a95d641`](https://github.com/Meenic/mnemocyte/commit/a95d64187e120eacec857f1bed9fcdfd5e525a43)
- resolution: Deletion now rejects atomically with `"CONFLICT"` while any
  memory references the selected survivor. No cascade, detach, or repoint
  behavior was added.

## Medium risk

### RETRIEVAL-02 — Return access metadata after the successful access update

- id: `RETRIEVAL-02`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/memory/client-core.ts`, `src/memory/store.ts`,
  `src/memory/in-memory.ts`, `src/memory/postgres.ts`,
  `src/db/queries/memories.ts`
- what-was-found: Recall scores and clones candidates before
  `markMemoriesAccessed()`, then returns those stale clones. In both backends,
  the first recall returned `accessCount: 0` and `lastAccessedAt: null` even
  though the row had already been updated before the promise resolved. A
  second recall returned count `1` and a timestamp, while storage had advanced
  to count `2`. Returned `Memory` state is therefore consistently one recall
  behind.
- proposed: Have the access-update store operation return the exact update
  timestamp and resulting counts, or pass one shared timestamp and patch the
  selected public results after the update succeeds. Keep ranking based on the
  pre-access count so a recall does not change its own ordering.
- how-verified: On the first and second recall, assert returned access counts
  are `1` and `2`, timestamps are present, and direct stored state matches.
  Cover multiple returned IDs and confirm scoring still uses the count from
  before the current recall.
- approval: yes
- status: resolved in
  [`caefcda`](https://github.com/Meenic/mnemocyte/commit/caefcda0485ab37d332fd5995b982ddb4d178dfc)

### AUDIT-01 — Audit global prune mutations per affected entity

- id: `AUDIT-01`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/memory/client-core.ts`, `src/memory/store.ts`,
  `src/memory/in-memory.ts`, `src/memory/postgres.ts`
- what-was-found: Audit documentation says enabled audit records every
  state-changing operation, but prune writes `"memory.pruned"` only when the
  caller supplied `entityId`. A confirmed reproduction pruned one expired
  memory from each of two entities with `prune({ expired: true })`; two rows
  were deleted and neither entity received a prune audit event. The missing
  provenance cannot be reconstructed afterward.
- proposed: Make the prune store result include per-entity deleted counts (or
  deleted IDs that shared orchestration aggregates), then write one
  best-effort `"memory.pruned"` event per affected entity. Preserve the
  existing no-event behavior for dry runs and zero-deletion runs.
- how-verified: Run entity-scoped and global prune against multiple entities in
  both backends. Assert one correctly counted event per affected entity, no
  events for unaffected entities/dry runs, and primary deletion still succeeds
  when best-effort audit insertion fails.
- approval: yes
- status: resolved in
  [`3a16c09`](https://github.com/Meenic/mnemocyte/commit/3a16c092ed425172a82d5b1dab2d4d95f5ce56a0)

### AUDIT-02 — Use a stable composite cursor for equal-timestamp events

- id: `AUDIT-02`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/types.ts`, `src/memory/in-memory.ts`,
  `src/db/queries/events.ts`, `src/memory/postgres.ts`
- what-was-found: Audit paging exposes only strict `before` / `after`
  timestamps. Consolidation deliberately creates all events in one call with
  the same `Date`. A public reproduction created three supersede events, read
  `limit: 1`, then requested `before: first.timestamp`; the next page
  contained zero supersede events even though two remained. Postgres also
  orders only by timestamp, so equal-timestamp ordering is nondeterministic,
  while in-memory uses insertion position as an unexposed tie-breaker.
- proposed: Introduce an experimental composite cursor containing timestamp
  and event ID (or another stable sequence), order by both columns in the same
  direction, and apply tuple comparison for subsequent pages. Retain
  timestamp-only filters as filters if compatibility is needed, but do not use
  them as the sole pagination cursor.
- how-verified: Insert more same-timestamp events than the page limit and page
  through all of them without duplicates or omissions in both backends.
  Repeat with mixed timestamps and verify deterministic newest-first ordering.
- approval: yes
- status: resolved in
  [`dbe655e`](https://github.com/Meenic/mnemocyte/commit/dbe655ea622d4c2dc1d16ce7a130e6b8940e678f)

### CONSOLIDATION-01 — Decide whether idempotency is survivor-specific

- id: `CONSOLIDATION-01`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/memory/client-core.ts`, `src/memory/in-memory.ts`,
  `src/memory/postgres.ts`, `src/types.ts`
- what-was-found: This is an open semantic question. If loser L is already
  superseded by survivor A, calling `consolidate({ survivorId: B,
  supersededIds: [L] })` returns a successful no-op with count zero, although L
  still points to A and the requested state was not achieved. The reproduction
  confirmed the returned `supersededCount: 0` and the unchanged, different
  `supersededBy`. Current wording says already-superseded entries are skipped
  for idempotency, but does not say whether a different survivor is a conflict.
  No existing Round 2 human-input entry covers this case.
- proposed: Open question for maintainer approval: should an
  already-superseded loser be a no-op only when it already points to the
  requested survivor, or should every already-superseded loser remain a no-op
  regardless of target? No answer is assumed here. If target-specific, return
  a typed conflict/validation error and keep true retries to the same survivor
  idempotent.
- how-verified: Test same-survivor retry, different-survivor retry, mixed
  batches, and concurrent consolidation in both backends. Assert the result
  truthfully represents the approved postcondition.
- approval: yes (target-specific — reject with CONFLICT when the loser already points to a different survivor; same-survivor retries stay idempotent)
- status: resolved in
  [`c44c01d`](https://github.com/Meenic/mnemocyte/commit/c44c01dc27f4ee4759d526ef31954b9fcf3afc77)

### INPUT-01 — Snapshot all mutable remember inputs before awaiting

- id: `INPUT-01`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/memory/client-core.ts`, `src/memory/records.ts`,
  `src/memory/validation.ts`
- what-was-found: The BUG-03 fix snapshots metadata at call time, but tags and
  `Date` values remain aliased until after asynchronous embedding. With a
  delayed embedder, mutating `tags[0]` and changing `expiresAt` while
  `remember()` was pending caused the mutated tag and year 2040 date to be
  stored instead of the original tag and 2030 date. This makes call semantics
  timing-dependent and inconsistent across fields.
- proposed: Add one synchronous `prepareRememberInput()` step that validates
  and owns copies of every mutable value before the first await: metadata,
  normalized tags, and cloned dates. Apply it to every item in `rememberMany`
  before provider or observability awaits, and have later layers consume only
  the prepared internal type.
- how-verified: Use a gated embedder, mutate all caller-owned arrays, nested
  metadata, and dates after method invocation, then assert stored/public values
  reflect the original call-time snapshot in both backends and both single and
  batch paths.
- approval: yes
- status: resolved in
  [`33ba44a`](https://github.com/Meenic/mnemocyte/commit/33ba44a69a0848a71b6549e8eb4fd7badebed171)

### INPUT-02 — Validate stored enums and date fields at runtime

- id: `INPUT-02`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/memory/validation.ts`, `src/memory/client-core.ts`,
  `src/retrieval/scorer.ts`, `src/types.ts`
- what-was-found: `validateRememberInput()` validates only strings, metadata,
  and confidence. A JavaScript reproduction stored
  `importance: "bogus"`. Recall then produced `undefined` for the importance
  score, the final score became `NaN`, and the memory disappeared from results.
  Unknown memory types, malformed tags/source values, and invalid `expiresAt`
  values similarly reach normalization, storage, or backend-specific failures
  without a typed boundary error.
- proposed: Validate `type` and `importance` against their exported domains;
  require tags to be an array of strings, source to be a string when supplied,
  and `expiresAt` to be a finite valid `Date`. Reject malformed runtime input
  with `"VALIDATION"` before embedding. Reuse the same enum validators for
  recall, duplicate, and prune filter arrays.
- how-verified: Add JavaScript-style invalid-input cases for every field and
  assert `"VALIDATION"` before embedder/store calls. Add accepted-domain tests
  to ensure all documented enum values still store and score correctly.
- approval: yes
- status: resolved in
  [`000043f`](https://github.com/Meenic/mnemocyte/commit/000043f9e5cc3104a8ce60376d18620141f2961b)

### OBSERVABILITY-01 — Include preparation and validation failures in operation events

- id: `OBSERVABILITY-01`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/memory/client-core.ts`, `src/observability.ts`,
  `src/memory/json.ts`
- what-was-found: `remember()` and `rememberMany()` clone metadata before
  calling `observe()`. Cyclic metadata therefore throws `"VALIDATION"` with no
  `"start"` or `"error"` event, contradicting the observation lifecycle
  contract. The same ordering changes error precedence: after `close()`, a
  call with cyclic metadata returned `"VALIDATION"` instead of the normal
  closed-client `"DB"` error because input preparation ran before
  `assertOpen()`.
- proposed: Route synchronous snapshot/preparation, open-state checks, and
  validation through one shared operation wrapper that always emits the
  documented lifecycle. Establish one consistent precedence rule—client state
  before input validation is the current behavior of most methods—and preserve
  call-time snapshots without awaiting user hooks first.
- how-verified: For every public method, trigger validation, closed-client,
  provider, and store failures and assert exactly one start plus one terminal
  event with the same thrown value. Add explicit cyclic-metadata and
  closed-plus-invalid-input cases for single and batch remember.
- approval: yes
- status: resolved in
  [`e159618`](https://github.com/Meenic/mnemocyte/commit/e1596181d4b62d1963bb7abcdcb167d054a5a9f7)

### STORE-01 — Make batch insert cardinality and ordering an explicit store contract

- id: `STORE-01`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/memory/store.ts`, `src/memory/client-core.ts`,
  `src/memory/in-memory.ts`, `src/memory/postgres.ts`
- what-was-found: Hypothesis/risky gap rather than a reproduced failure in the
  two current adapters: public `rememberMany()` guarantees results in input
  order, but `MemoryStore.insertMemories()` returns a plain `Memory[]` with no
  documented cardinality or ordering invariant. Shared orchestration returns
  that array directly and does not detect missing, extra, duplicate, or
  reordered rows. The in-memory adapter preserves order by construction;
  Postgres relies on `INSERT ... RETURNING` order. A future public adapter can
  silently violate the public guarantee while still satisfying the TypeScript
  interface.
- proposed: Return inserted records keyed by the pre-generated memory IDs, or
  have shared orchestration validate the returned ID set and reorder records
  according to the prepared input IDs. Reject missing, duplicate, or unknown
  IDs with `"DB"`. Document this invariant in the internal contract before
  exporting `MemoryStore`.
- how-verified: Add contract tests using fake stores that reverse rows, omit a
  row, duplicate a row, and return an unknown ID. Assert reversed complete
  results are normalized to input order and malformed cardinality fails
  predictably. Run the same contract suite against both real adapters.
- approval: yes
- status: resolved in
  [`ee557b4`](https://github.com/Meenic/mnemocyte/commit/ee557b47be698fefd96fbb0d386dd423bdde62ef)

### CONTEXT-01 — Prevent plain-text memory content from spoofing frame boundaries

- id: `CONTEXT-01`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/context/formatter.ts`, `test/context/builder.test.ts`
- what-was-found: Memory content is documented as untrusted, but plain output
  uses fixed `--- MEMORY N START/END ---` delimiters without escaping. A memory
  containing `--- MEMORY 1 END ---` produced two end markers and placed
  attacker-controlled text between them, visually outside the intended frame.
  XML escapes content and Markdown chooses a dynamic fence, so plain format is
  the weaker boundary.
- proposed: Use a deterministic delimiter that is guaranteed not to occur in
  the query or included memory content, or escape delimiter-looking content
  lines with a documented reversible rule. Keep whole-memory boundaries and
  omission markers unambiguous.
- how-verified: Add adversarial content containing every fixed start/end marker,
  multiline marker variants, omission text, and repeated delimiters. Assert a
  parser—or focused structural test—can identify exactly the memories emitted
  and no content can terminate its own frame.
- approval: yes
- status: resolved in
  [`26b5beb`](https://github.com/Meenic/mnemocyte/commit/26b5beb2456a8ccf0453e3505e0dcaf992357e1f)

### CONFIG-01 — Validate provider resilience numbers synchronously

- id: `CONFIG-01`
- category: `behavior-change`
- risk-tier: `medium`
- where: `src/client.ts`, `src/memory/validation.ts`, `src/resilience.ts`,
  `src/types.ts`
- what-was-found: `ProviderResilienceConfig` has no construction-time runtime
  validation. With `retries: NaN`, the retry loop computed `maxAttempts: NaN`,
  called the embedder zero times, and `remember()` surfaced an `"EMBEDDING"`
  wrapper with an undefined cause. Fractional/infinite retries and non-finite
  timeout/delay values can likewise create nonsensical loop/timer behavior
  instead of a typed configuration error.
- proposed: Validate provider configuration in `createMnemocyte()`: retries
  must be a non-negative integer; timeout and delays must be finite
  non-negative numbers; `shouldRetry`, when supplied, must be callable.
  Preserve or explicitly document the existing `maxDelayMs < baseDelayMs`
  normalization policy.
- how-verified: Add synchronous config tests for `NaN`, infinities, negatives,
  fractions, and malformed predicates. Assert `"CONFIG"` at construction and
  zero provider calls, plus boundary success cases for zero and valid positive
  values.
- approval: yes
- status: resolved in
  [`e586024`](https://github.com/Meenic/mnemocyte/commit/e58602487294d7c9a0b781f594809982ab761dd9)

### REFACTOR-01 — Remove redundant metadata clone/validation passes

- id: `REFACTOR-01`
- category: `pure-refactor`
- risk-tier: `medium`
- where: `src/memory/client-core.ts`, `src/memory/validation.ts`,
  `src/memory/records.ts`, `src/memory/in-memory.ts`,
  `src/memory/postgres.ts`, `src/memory/postgres-records.ts`
- what-was-found: A successful remember currently deep-clones the same metadata
  repeatedly: preparation clones it; validation clones it again only to
  discard the result; `createStoredMemory()` clones again; each adapter clones
  at its ingress/row boundary; and the client clones the returned memory again.
  Large metadata therefore pays several full recursive traversals per write.
  The first preparation clone already yields an owned, validated plain JSON
  object, so later validation clones are redundant.
- proposed: Introduce an internal prepared/validated JSON object type and an
  ownership contract: clone and validate once at public ingress, pass that
  owned value through storage serialization, and clone once at each public
  egress where caller isolation is required. This is provably
  behavior-preserving because the initial rejection rules and call-time
  snapshot remain unchanged, and public results remain independently cloned;
  only repeated cloning of already-owned internal values is removed.
- how-verified: Keep all metadata mutation/unsupported-value tests unchanged
  for both backends. Add focused instrumentation or an injected clone helper in
  an internal test to assert one ingress validation traversal and one public
  egress clone per result, including batch and audit paths.
- approval: yes
- status: resolved in
  [`a2fcf8b`](https://github.com/Meenic/mnemocyte/commit/a2fcf8b5f27a39d5f7d6c8c5b5fbaa5b2942f693)

## Low risk

### CONTEXT-02 — Guarantee the returned context fits `maxTokens`

- id: `CONTEXT-02`
- category: `behavior-change`
- risk-tier: `low`
- where: `src/context/builder.ts`, `src/context/tokens.ts`
- what-was-found: When no nonempty truncation marker fits the budget,
  `trimToTokenBudget()` returns `"[truncated to fit token budget]"` without
  checking it. With one memory and `maxTokens: 1`, the default heuristic
  returned that marker at an estimated eight tokens. The method therefore
  violates its explicit positive token budget for small values.
- proposed: Make `tokenCounter.count(result) <= maxTokens` a hard postcondition.
  If neither formatted content nor a truncation marker fits, return the longest
  marker fragment that fits or an empty string. Prefer an empty string over
  knowingly exceeding the caller's model budget.
- how-verified: Parameterize tests over tiny budgets and custom counters,
  including counters where even one character costs more than the budget.
  Assert the postcondition for markdown, plain, and XML outputs.
- approval: yes
- status: resolved in
  [`47931e2`](https://github.com/Meenic/mnemocyte/commit/47931e216640be2025bb2576f655b18afe481b94)

### CONFIG-02 — Reject non-Postgres database URL protocols

- id: `CONFIG-02`
- category: `behavior-change`
- risk-tier: `low`
- where: `src/db/index.ts`, `src/client.ts`,
  `test/config/client-config.test.ts`
- what-was-found: `createDatabase()` checks only whether `new URL()` succeeds.
  `createMnemocyte({ databaseUrl: "https://example.com/db", ... })` was accepted
  as a Postgres client and failed only later when the driver tried to use it.
  The constructor documentation promises malformed database URLs fail
  synchronously with `"CONFIG"`.
- proposed: Require protocol `postgres:` or `postgresql:` after URL parsing and
  reject other protocols synchronously with `"CONFIG"`. Leave driver-specific
  host/database credential validation to postgres.js unless a value is
  unambiguously unusable.
- how-verified: Add accepted tests for both Postgres protocol spellings and
  rejected tests for HTTP(S), file, relative, and protocol-less values. Assert
  no connection handle is created for rejected inputs.
- approval: yes
- status: resolved in
  [`da1bea9`](https://github.com/Meenic/mnemocyte/commit/da1bea9d44aa4fe30a68b33bc9dabfa0472faf40)

### OPENAI-01 — Reject duplicate and malformed response indices

- id: `OPENAI-01`
- category: `behavior-change`
- risk-tier: `low`
- where: `src/embedders/openai.ts`, `test/embedders/openai.test.ts`
- what-was-found: The OpenAI helper casts response JSON and fills an output
  array by index, but does not reject duplicate indices or extra response
  items. A mocked response containing indices `0, 0, 1` for two inputs was
  accepted; the second index-0 embedding silently overwrote the first and the
  helper returned `[[0,1],[1,1]]`. This violates the embedder's
  one-result-per-input contract without an `"EMBEDDING"` error.
- proposed: Validate that `data` is an array of exactly the requested length,
  every item has a unique in-range integer index, and every embedding is an
  array before restoring order. Let the shared embedding boundary continue to
  validate dimensions and finite components.
- how-verified: Add mocked duplicate-index, extra-item, missing-item,
  non-array-data, malformed-item, and valid-out-of-order cases. Assert malformed
  responses fail with `"EMBEDDING"` and valid responses retain index order.
- approval: yes
- status: resolved in
  [`021c1e4`](https://github.com/Meenic/mnemocyte/commit/021c1e4aee63de415b85cefa238fb6bf44cf1ee0)
