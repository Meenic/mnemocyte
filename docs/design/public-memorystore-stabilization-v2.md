# Public `MemoryStore` Stabilization — Draft Proposal v2

Status: draft, corrected against
`STABILIZATION_PROPOSAL_VERIFICATION.md`'s findings on v1. Not yet
re-verified — treat this the same way `memorystore-capability-contract-v2.md`
was treated: a correction pass, still pending its own verification round
before being implementation-ready.

## What changed from v1

v1 conflated "no capability gate needed" with "identical behavior, nothing
to document." Those are different claims. Verification found:

- 5 of the 13 "ship as-is" methods have real backend-specific behavior that
  needs precise documentation (and in one case, an actual decision) before
  they're truly stabilization-ready, even though none of them need a
  capability flag.
- The `prune`/`consolidate` cancellation claim was wrong, not just
  imprecise — they use genuinely different mechanisms.
- The three-method "indexed vs. scanned" framing was wrong for two of the
  three methods; only `vectorSearch` actually has a bundled index.

None of this changes the proposal's core recommendation (ship correctness
contracts, defer a capability-flag surface, which verification fully
confirmed with no counter-evidence found anywhere in source, tests, docs,
or roadmap). It changes what "ship as-is" can honestly mean per method.

## Per-method disposition (corrected)

### Genuinely ship as-is — behaviorally identical, document and move on (8 methods)

`ensureSchema`, `insertMemories`, `getMemoryEmbeddings`, `deleteMemory`,
`deleteMemoriesForEntity`, `listAuditLog`, `getMemory`, `stats`.

Verification confirmed these have identical observable postconditions
across both current adapters. Document each precisely (return shape,
`"CONFLICT"` conditions, cursor semantics, cancellation support where
present) and they're done — no further design work needed. This includes
the two claims verification re-confirmed directly:

- `insertMemories`: store return order is untrusted; shared orchestration
  restores input order. The store's only obligation is exactly one result
  per prepared ID.
- `deleteMemory`/`deleteMemoriesForEntity`: `"CONFLICT"` rejection requires
  an atomic, non-interleavable check-then-mutate — document this as the
  actual requirement, not "read before write," since a naive read-then-write
  implementation would not satisfy it under concurrent access.
- `listAuditLog`: composite cursor semantics need a stable event ID,
  comparable timestamp, strict tuple filtering, and matching tuple order.
  No transaction required. Document the cancellation mechanism as
  implementation-defined (cooperative scan vs. active query cancellation
  are both acceptable) rather than mandating one.

### Needs precise documentation of intentional backend-specific behavior (4 methods)

These are correctly unconditional — no capability flag needed — but "ship
as-is" undersold them. Each needs its actual, currently-divergent behavior
written down as the real contract, not glossed over:

- **`ensureEmbeddingCompatibility`** — in-memory always resolves; Postgres
  performs persistent installation-level dimension/model validation and can
  throw `"MIGRATION"`/`"CONFIG"`. This divergence is intentional and correct
  (in-memory has no persistent installation to validate against) — document
  it as "each backend enforces whatever compatibility check is meaningful
  for its own persistence model," not as identical behavior.

- **`markMemoriesAccessed`** — behavior matches for the distinct-ID case
  shared recall actually supplies today, but diverges on duplicate input
  IDs (in-memory double-increments and double-returns; Postgres deduplicates
  via `IN (...)` and returns once). Document a distinct-IDs precondition
  explicitly in the public contract, since nothing currently states one.

- **`addAuditEvents`** — successful writes match, but failure atomicity
  doesn't: in-memory is all-or-nothing, Postgres inserts sequentially with
  no wrapping transaction, so a partial batch can persist after a rejection
  and later become visible through `listAuditLog`. Since ordinary audit
  writes are already documented as best-effort, document this specific
  partial-persistence possibility as part of that existing best-effort
  contract rather than treating it as a gap to close.

- **`close`** — client-level lifecycle (draining, admission blocking,
  retry-after-failure) is already consistent and fine to document as-is.
  Store-level effects are not just documented differently, they're
  substantively different: in-memory destroys all state, Postgres closes a
  pool and leaves rows intact. This is correct today because there's no
  caller-owned-connection scenario yet — but the roadmap explicitly flags
  caller-owned connection lifecycle as an open review item for
  `drizzleStore(db)`. **This one isn't ready to document as final** — it's
  blocked on that roadmap decision. Note it as blocked, not as done.

### Needs an actual decision, not just documentation (1 method)

- **`loadConsolidationTargets`** — this is the one real gap verification
  found, not just an imprecision. Duplicate IDs in a `supersededIds` list
  currently produce different observable results per backend: in-memory can
  count and audit a duplicated loser twice, Postgres counts it once, and
  shared validation doesn't currently reject duplicate `supersededIds` at
  all. This is a caller-visible correctness divergence, not a documentation
  gap — the same category of issue the project's earlier `PROPOSALS.md`
  process was built to catch and fix, not just describe. **Recommendation:
  route this through that process** (reproduce it, decide whether shared
  validation should reject duplicate `supersededIds` outright — which
  looks like the obvious fix, since nothing legitimate seems to need
  duplicate losers in one call — get it approved, then fix it) rather than
  trying to resolve it inside a documentation-only stabilization pass.

### Needs explicit scope decision, corrected framing (3 methods, not one pattern)

v1 treated `vectorSearch`, `lexicalSearch`, and `findDuplicatePairs` as
three examples of the same "indexed vs. scanned" story. They're not:

- **`vectorSearch`** — the one method with an actual bundled index (HNSW
  on the vector column). Postgres can use it; in-memory always scans. Even
  here, index usage is planner- and filter-dependent and HNSW is
  approximate — document performance characteristics as non-guaranteed,
  not as a hard indexed/scanned binary.
- **`lexicalSearch`** — no bundled full-text index in either backend.
  Postgres computes `to_tsvector` in-query (a scan, just SQL-side);
  in-memory uses JS lexical scoring. These can produce different
  *candidates and rankings*, not just different latency — document this as
  a real behavioral difference between backends' relevance scoring, which
  matters more than the performance framing v1 gave it.
- **`findDuplicatePairs`** — pairwise self-join in both backends (SQL vs.
  JS loops), not an indexed nearest-neighbor operation in either one. No
  indexed/scanned distinction exists here at all. Document current
  algorithmic complexity (effectively quadratic per entity in both
  backends) and point at the existing `DOCS-DEF-01` guidance rather than
  inventing new scale language.

**Recommendation, unchanged from v1 and now more strongly confirmed:**
don't build a capability-flag surface. Verification found zero evidence of
a planned consumer anywhere in source, tests, `README.md`,
`docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/PROJECT_MEMORY.md`,
`CHANGELOG.md`, or `docs/PROPOSALS.md`. Ship these three as
correctness-only contracts, document their real per-method behavioral
differences (not a shared indexed/scanned narrative), and revisit only if
a concrete performance-sensitive consumer actually materializes.

### Corrected: cancellation is not one shared boundary for `prune` and `consolidate`

v1 described both as "between-step checks, not mid-statement." That's only
true for `consolidate`. They need separate documentation:

- **`consolidate`** — checks before opening the transaction, between each
  step, and immediately before the transaction callback returns. Does not
  cancel an in-flight statement. The final-check caveat is real: an abort
  after that last check, including during commit, may still leave the
  transaction committed. Document exactly this boundary.
- **`prune`** — both dry-run and non-dry-run paths use genuine in-flight
  statement cancellation (postgres.js `query.cancel()` on the active
  statement). This is stronger than `consolidate`'s guarantee. Document it
  as such, don't undersell it by grouping it with the weaker boundary. The
  remaining race is narrower and different: an abort cannot undo a
  statement that has already committed, but there's no "final check between
  steps" boundary to describe for prune the way there is for consolidate,
  because prune doesn't have multiple sequential steps in the first place.

## What's explicitly out of scope for this proposal (unchanged from v1)

- Redesigning behavior, except `loadConsolidationTargets`'s duplicate-ID
  handling, which verification elevated from "document it" to "this needs
  an actual fix, routed through the normal proposal/approval process."
- SQLite — still paused, still not a roadmap commitment.
- `drizzleStore(db)`'s own design — next item after this one, and now has
  one more concrete dependency: the `close`/connection-ownership question
  this proposal found is genuinely blocking, not just adjacent.

## Suggested next step

Two parallel tracks, since they don't block each other:

1. **Documentation track** — write the precise per-method contract
   documentation for the 8 "genuinely ship as-is" methods and the 4
   "backend-specific but intentional" methods (everything except
   `loadConsolidationTargets` and `close`, which are blocked on real
   decisions).
2. **Decision track** — open a `PROPOSALS.md`-style entry for the
   `loadConsolidationTargets` duplicate-ID issue, and flag the `close`/
   connection-ownership question as a prerequisite decision for
   `drizzleStore(db)` design, not something this stabilization pass can
   resolve alone.

Send this v2 through the same verification pattern as before once both
tracks have something concrete to check.
