# Public `MemoryStore` Stabilization — Draft Proposal v3

> **Status (2026-07-20): documentation track complete.** The 12 ship-ready
> method contracts, three search-method scope notes, and cross-cutting adapter
> guidance landed in
> [`dafed57`](https://github.com/Meenic/mnemocyte/commit/dafed57fd706f14a7e502ede94486853bb331ffd).

Status: draft, patch of v2 addressing
`STABILIZATION_PROPOSAL_VERIFICATION_V2.md`'s six findings. Not a
rewrite — v2's scope, method bucketing, and both next-step tracks'
*structure and direction* are confirmed correct and unchanged. Their
*wording* is not entirely unchanged: correction 6 below fixes the
documentation track's stated method count. This patches six specific
overclaims and one path error round 2 found in v2's wording.

## What changed from v2 (six corrections, nothing structural)

1. The 8-method bucket is no longer labeled "behaviorally identical." It's
   relabeled "same verified postconditions" — round 1 confirmed matching
   functional outcomes for these methods, not identical backend execution
   or failure sources. Even within this bucket, `listAuditLog` and
   `getMemory` differ in cancellation mechanism and timing; that's fine and
   doesn't need a capability flag, but it means "identical" was the wrong
   word.
2. `insertMemories`'s ordering is now attributed to the right layer: the
   **store has no return-order obligation at all** — store order is
   explicitly untrusted, and it's shared orchestration that validates the
   complete returned ID set and restores prepared-input order. The store's
   only obligation is exact one-result-per-prepared-ID cardinality. Its
   full contract, unchanged from today, also requires detached public
   records, ownership transfer of freshly prepared rows, and rejection of
   unknown returned IDs (not just missing/duplicate ones) — restored from
   round 1, dropped by an overly narrow v2 sentence.
3. Non-dry `prune` is restored to the atomic-survivor-protection list. It
   shares the same non-interleavable check-and-mutate requirement as
   `deleteMemory` and `deleteMemoriesForEntity` — v2 only listed two of the
   three operations round 1 actually covered.
4. The claim that "cooperative and active-query cancellation are both
   acceptable" for the composite audit cursor is now marked as a **proposed
   contract decision**, not a confirmed current fact. Round 1 only
   established that the two current mechanisms differ; whether a future
   public contract should permit either, or require one, is genuinely
   undetermined and shouldn't have been folded into a "confirmed correct"
   section.
5. Path corrected: the routing mechanism for new findings is root
   `PROPOSALS.md`, not `docs/PROPOSALS.md` (which doesn't exist). Confirmed
   still live and structured to accept new entries via blank `approval`.
6. Two internal inconsistencies fixed:
   - The opening now says two things are blocked on a real decision among
     the five reclassified methods — `loadConsolidationTargets`'s
     duplicate-ID correctness fix, and `close`'s connection-ownership
     question — not one.
   - The documentation track now correctly lists **three** currently-
     documentable backend-specific methods (`ensureEmbeddingCompatibility`,
     `markMemoriesAccessed`, `addAuditEvents`), explicitly excluding both
     `loadConsolidationTargets` (routed to the decision track) and `close`
     (blocked on the roadmap's ownership question) — not four.

Everything else — the 8-method "genuinely ship as-is" bucket's membership,
the three search methods' corrected framing, the `prune`/`consolidate`
cancellation split, and both next-step tracks' structure and direction —
carries forward from v2 unchanged, since round 2 confirmed all of it as
accurate. (The documentation track's stated method count is corrected by
item 6 above, not carried forward unchanged.)

## Corrected summary (for quick reference; full detail lives in v2)

**Ship as-is, document precisely (8 methods, same verified postconditions —
not "identical"):** `ensureSchema`, `insertMemories`, `getMemoryEmbeddings`,
`deleteMemory`, `deleteMemoriesForEntity`, `listAuditLog`, `getMemory`,
`stats`.

**Document real backend-specific behavior, no flag needed (3 methods):**
`ensureEmbeddingCompatibility`, `markMemoriesAccessed`, `addAuditEvents`.

**Blocked on real decisions, not ready to document as final (2 methods):**
- `loadConsolidationTargets` — route through root `PROPOSALS.md` as a new
  entry (blank `approval`, awaiting maintainer decision): duplicate loser
  IDs currently produce different counts/audit events per backend, and
  shared validation doesn't reject duplicates today. Likely fix: reject
  duplicate `supersededIds` in shared validation — but that's a decision to
  approve, not something to implement inside a documentation pass.
- `close` — current behavior (destroys all in-memory state; closes the pool
  it created for a `databaseUrl`-configured Postgres client) is final and
  documentable as-is for both existing adapters, since `mnemocyte` owns
  every connection it currently creates. The only forward-looking
  constraint — not an open question — is `ROADMAP.md`'s already-stated
  principle for `drizzleStore(db)`: connection lifecycle ownership stays
  with the caller when a database instance is supplied, so a future
  caller-owned-connection adapter's `close()` must not close resources it
  doesn't own. Document current behavior now, and carry that constraint
  forward as a stated requirement on the next adapter's design, not as a
  gap in this one.

**Needs explicit, per-method scope framing (3 methods, three different
situations, not one pattern):** `vectorSearch` (the only one with a bundled
index — HNSW, planner-dependent, approximate), `lexicalSearch` (no bundled
index in either backend; differs in candidates/ranking, not just latency),
`findDuplicatePairs` (pairwise scan in both backends — no indexed
nearest-neighbor pair generation anywhere, though the planner may still use
ordinary entity/primary-key indexes while executing the self-join).

**Atomic survivor protection** (`"CONFLICT"` on referenced-survivor
deletion) applies to `deleteMemory`, `deleteMemoriesForEntity`, and non-dry
`prune` — all three, requiring a non-interleavable check-and-mutate
mechanism, not "read before write" in general.

**Cancellation boundaries differ per method, specifically in the Postgres
adapter** — Postgres `prune` has genuine in-flight statement cancellation;
Postgres `consolidate` checks only between steps, with a final-check-
before-commit caveat. (In-memory uses cooperative `throwIfAborted` checks
during synchronous work for both.) Document separately per backend, don't
generalize one adapter's mechanism into a method-wide contract claim.

**Capability-flag surface: still recommended to defer**, confirmed twice
now with zero counter-evidence found anywhere in source, tests, or docs.
Revisit only if a concrete performance-sensitive consumer materializes.

## Next step

This should be close enough to act on directly. Recommend moving to the two
tracks now rather than a further verification round:

1. **Documentation track** — write precise contract docs for the 11
   ship-ready methods (8 + 3), using the corrected framing above.
2. **Decision track** — open the `loadConsolidationTargets` entry in root
   `PROPOSALS.md` per its existing format (id, category, risk-tier, where,
   what-was-found, proposed, how-verified, blank approval), and note
   `close`'s ownership question as a named prerequisite for `drizzleStore(db)`
   design rather than something this pass resolves.
