# Public `MemoryStore` Stabilization — Draft Proposal

Status: draft, not yet verified against source by Codex. Written from the
now-confirmed 18-method interface (`CONTRACT_DESIGN_VERIFICATION.md`,
`CONTRACT_DESIGN_VERIFICATION_V2.md`) and the capability-flag investigation's
conclusion: 17 of 18 methods work as unconditional requirements with no
capability gating needed; only `vectorSearch`'s indexed-vs-scanned
distinction has any real backing as a differentiator, and even that flag's
necessity and public surface remain undetermined.

This proposal is scoped narrower than the SQLite work was: it is not asking
"can a hypothetical third backend implement this," it's asking "what does
`MemoryStore` need to look like, and what needs to be documented about it,
before an external adapter author (starting with `drizzleStore(db)`, per
`ROADMAP.md`) can implement against it with confidence."

## What "stabilization" actually requires

Four separate things, easy to conflate:

1. **API stability** — the method list and signatures stop changing without
   a major/minor version bump and a documented migration path.
2. **Contract documentation** — every postcondition currently enforced only
   by tests and internal comments (exact cardinality, `"CONFLICT"` on
   referenced survivors, composite cursor ordering, cancellation boundaries)
   becomes real, public-facing documentation an external implementer can
   build against without reading `client-core.ts`.
3. **Export visibility** — the `MemoryStore` type itself becomes importable
   from the package, not just internal.
4. **Conformance verification** — a real way for an external implementer to
   check their adapter actually satisfies the contract, not just "looks
   right."

These can ship incrementally. Recommendation: do them in this order — (2)
first since it's pure documentation and lowest risk, then (1) and (3)
together as the actual API change, then (4) last since it's the most
mechanical once the contract is written down precisely.

## Per-method disposition

Grouping by what changes on the path to public, using the confirmed 18:

### Ship as-is, document thoroughly (13 methods — no design work needed)

`ensureSchema`, `ensureEmbeddingCompatibility`, `insertMemories`,
`getMemoryEmbeddings`, `markMemoriesAccessed`, `deleteMemory`,
`deleteMemoriesForEntity`, `addAuditEvents`, `listAuditLog`, `getMemory`,
`loadConsolidationTargets`, `stats`, `close`.

These already work correctly across both current adapters with no
capability gating. The only work here is writing down, per method, the
postcondition an implementer must satisfy — most importantly:

- `insertMemories`: exact one-result-per-ID, but **caller does not need to
  preserve input order** — confirmed in round 2, this was my own error in
  an earlier draft. Document this precisely so an external implementer
  doesn't over-engineer ordering guarantees the contract doesn't require.
- `deleteMemory`/`deleteMemoriesForEntity`: the `"CONFLICT"` rejection rule
  needs to be specified precisely enough that an implementer without access
  to a foreign-key engine (round 2 confirmed in-memory achieves this via
  atomic, non-interleavable check-then-mutate, not "read before write" in
  general) knows what's actually required: some mechanism that prevents any
  other write from interleaving between the dependency check and the
  mutation. Don't just say "reject if referenced" — say what atomicity
  guarantee backs it.
- `listAuditLog`: composite cursor semantics (`beforeCursor`/`afterCursor`
  vs. plain `before`/`after`) need to be spelled out as precisely as
  round 2 confirmed them for the current adapters — stable event ID +
  comparable timestamp + strict tuple filter + matching tuple order, no
  transaction required.

### Needs a documented degraded-behavior clause (2 methods)

`prune`, `consolidate` — both have the same `"CONFLICT"`-on-referenced-
survivor and/or transactional-mutation requirements as above, but also
carry the cancellation-boundary nuance round 2 detailed precisely (between-
step checks, not mid-statement, with an explicit "abort after the final
check may still leave the mutation committed" caveat). This needs to be
public-facing documentation, not just an internal comment, since an
external implementer's cancellation behavior needs to be honestly
comparable to the built-in adapters'.

### Needs explicit scope decision before documenting (3 methods)

`vectorSearch`, `lexicalSearch`, `findDuplicatePairs` — these are where the
one real capability distinction lives. Decision needed: does the public
contract require these to be *correct* only (any implementation, scan-based
or indexed, that returns the right results) with performance characteristics
left as an implementation detail an adapter documents separately — or does
it need an actual `supportsIndexedVectorSearch`-style flag as real API
surface?

**Recommendation, carried forward from the v2/round-2 investigation:**
don't build the flag yet. Round 2 was explicit that "this distinction is
real" doesn't establish "callers need a flag, or where it should live."
Ship these three as correctness-only contracts first — document the return
shape, scoring/clamping rules, and filter semantics precisely, say nothing
about required performance characteristics — and only add a capability
surface later if a real adapter with a real perf-sensitive caller actually
needs to expose the distinction. This avoids designing speculative API
surface for a problem that doesn't have a concrete consumer yet, which is
exactly the mistake the dropped flags (`supportsTransactions`,
`supportsReferentialIntegrity`, `supportsFullTextSearch`) made the first
time.

## What's explicitly out of scope for this proposal

- Redesigning any method's behavior. This is a stabilization pass, not a
  behavior-change pass — everything here should describe what already
  exists precisely enough to build against, not change it.
- SQLite. Per `docs/design/README.md`, that work is paused pending v3 and
  isn't a roadmap commitment. Nothing here should be written assuming a
  second backend's constraints; it should be written from what the two
  *existing* adapters (in-memory, Postgres) actually guarantee.
- `drizzleStore(db)`'s own design. That's the next roadmap item after this
  one, and depends on this contract being settled first — don't get ahead
  of it here.

## Suggested next step

Send this proposal, along with `MONOREPO_READINESS_REPORT.md` and both
`CONTRACT_DESIGN_VERIFICATION*.md` reports, through the same Codex
verification pattern used for the capability contract: check each method's
"ship as-is" claim against real source, confirm the `insertMemories`
ordering correction and the `"CONFLICT"` atomicity requirement are stated
precisely, and flag anything in the "needs decision" section that source
can actually settle versus what's a genuine maintainer call.

## Continuity note for a fresh conversation

If picking this up in a new chat with no memory of this one, the essential
context to bring forward is:

- This document.
- `docs/design/README.md` (the chronology index — explains why v1/v2 exist
  and what's settled vs. not).
- `MONOREPO_READINESS_REPORT.md` and both `CONTRACT_DESIGN_VERIFICATION*.md`
  files, since this proposal's method-by-method claims are built directly
  on their findings.
- `ROADMAP.md`, to confirm this is still the next committed step
  (public `MemoryStore` stabilization → `drizzleStore(db)` → `@mnemocyte/mcp`)
  and nothing has shifted since.
