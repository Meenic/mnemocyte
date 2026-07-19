# `MemoryStore` Public Contract — Capability-Flag Design

This extends the four-method design notes to the full interface. Where a
method's exact current signature isn't something I have verified against
source, that's flagged explicitly — check against `MONOREPO_READINESS_REPORT.md`
section 2 or the actual `src/memory/store.ts` before finalizing.

## Governing principle

Split every `MemoryStore` method into one of two buckets:

- **Core** — every adapter must implement this correctly, full stop. If a
  backend genuinely cannot do it, it doesn't qualify as a `MemoryStore`
  adapter.
- **Capability-gated** — adapters declare support via a flag object; the
  shared client branches on the flag rather than assuming every adapter
  behaves identically. A missing capability degrades to a documented,
  narrower guarantee — it never silently pretends to be the strong version.

This mirrors better-auth's `createAdapterFactory` pattern (adapters declare
what they support, the factory adapts) rather than forcing a lowest-common-
denominator interface that would gut features already hardened in Postgres
(transactional consolidation, `CONFLICT` rejection, composite cursors).

## Proposed capability flags

```ts
interface MemoryStoreCapabilities {
  /** Indexed/accelerated vector search vs. scan-and-score in the adapter. */
  supportsIndexedVectorSearch: boolean;
  /** Real multi-statement transactions with rollback. */
  supportsTransactions: boolean;
  /** Enforced FK-style referential integrity (backs CONSOLIDATION-DELETE-01 / CONSOLIDATION-01). */
  supportsReferentialIntegrity: boolean;
  /** Mid-statement query cancellation, not just between-step checks. */
  supportsStatementCancellation: boolean;
  /** Native full-text search vs. in-JS lexical scoring. */
  supportsFullTextSearch: boolean;
}
```

Every adapter exports one static `capabilities` object. The shared client
reads it once at construction and branches internally — callers never see
adapter-specific logic leak into `client-core.ts`.

## Method-by-method bucketing

### Core (required, no flag — every adapter must get these right)

- **Insert (single/batch)** — the `STORE-01` contract (exact cardinality,
  input-order-restored results) applies unconditionally. No backend gets a
  pass on returning the wrong count or wrong order.
- **Get / list by scalar filter** (entity, type, tags, date range, no
  vector component) — every backend can filter rows by plain fields; this
  is not where backends genuinely differ.
- **Delete (single/batch)**, gated only by referential-integrity capability
  (see below) for the survivor-conflict case specifically — the delete
  operation itself is core, its conflict-rejection strength is not.
- **markMemoriesAccessed** — `RETRIEVAL-02`'s "return real post-update
  state" contract. This is a scalar update; every backend can do it
  correctly.
- **Basic audit write/read** (non-cursor, simple time-ordered list) — core.
  The *composite cursor* specifically is capability-gated (below); a plain
  "give me recent events" is not.

### Capability-gated

- **`vectorSearch` acceleration** — gated on `supportsIndexedVectorSearch`.
  Every adapter must implement `vectorSearch` (it's semantically core — you
  can't be a memory store without vector search), but *how* it's computed
  differs. `false` means scan-and-score in JS (in-memory and SQLite v1's
  approach from the design notes); `true` means the adapter delegates to a
  native index (pgvector, future `sqlite-vec`). The client doesn't need to
  branch on this one directly — it's informational, surfaced via `stats()`
  or similar, mainly so callers can make informed scale decisions
  (`DOCS-DEF-01`'s existing guidance already does this qualitatively; the
  flag makes it queryable instead of documentation-only).

- **`findDuplicatePairs` acceleration** — same shape as above, same flag.

- **Referential-integrity-backed rejection** — gated on
  `supportsReferentialIntegrity`. When `true`, `forget`/`forgetAll`/`prune`
  reject with `"CONFLICT"` on a live survivor reference, exactly like
  Postgres today (FK backstop) and the SQLite design (explicit preflight
  check inside the transaction — this is still `true` for SQLite even
  though it's not FK-enforced, since it achieves the same guarantee via
  application-level check-then-act inside a lock). When `false` (a
  hypothetical adapter with no way to enforce this atomically — e.g. a
  fully async/eventually-consistent store), the client must not silently
  allow dangling references either: it falls back to a documented weaker
  behavior, most likely "the client itself does the same preflight check
  the adapter can't guarantee atomically, accepting a known TOCTOU race
  under concurrent access." This must be stated plainly in that adapter's
  docs, never left implicit.

- **Transactional consolidation** — gated on `supportsTransactions`.
  `consolidate`'s mixed-batch atomicity (`CONSOLIDATION-01`) needs this.
  `true`: real transaction, exactly like Postgres and the SQLite
  `BEGIN IMMEDIATE` design. `false`: the client-level orchestration must
  either refuse to offer atomic mixed-batch semantics for that adapter
  (documented, honest) or implement a manual multi-step compensating
  rollback (higher engineering cost, only worth it if a real
  non-transactional backend is actually planned — don't build this
  speculatively).

- **Composite audit cursor** — gated on whatever capability backs
  `(timestamp, event ID)` tuple ordering (likely folds into
  `supportsTransactions` or deserves its own flag if a backend can do plain
  writes but not guarantee stable ordering — verify against how
  `AUDIT-02` actually implemented this before finalizing which flag owns
  it). `false` falls back to timestamp-only filtering with the same
  "strict filter, not a complete cursor" disclosure already shipped in
  `CHANGELOG.md` for `AUDIT-02`.

- **Statement-level cancellation** — gated on
  `supportsStatementCancellation`. `true`: postgres.js-style mid-query
  cancellation. `false`: between-step checks only, exactly as documented
  for both Postgres's own `consolidate` and the SQLite design notes above.
  This is the one place SQLite and Postgres actually land on the *same*
  value (`false` in practice for the transactional maintenance operations,
  even though Postgres's driver technically supports statement
  cancellation for reads) — worth being precise about which operations
  this flag actually covers rather than treating it as one blanket
  Postgres-good/SQLite-bad axis.

- **Full-text search** — gated on `supportsFullTextSearch`. Postgres has
  `to_tsvector`; in-memory does JS lexical scoring already; SQLite has
  FTS5 available but it's a *build-time extension choice*, not guaranteed
  present, so SQLite v1 likely ships `false` and falls back to the same JS
  lexical scoring in-memory already uses, exactly like the vector-search
  decision. This keeps the "no new dependency for v1" line consistent
  across both the vector and text search axes.

## What this buys you

- The client can make informed decisions and give honest error messages
  ("this adapter doesn't support atomic mixed-batch consolidation") instead
  of either crashing unexpectedly or silently behaving differently per
  backend with no way for a caller to know why.
- New adapters don't need to fake capabilities they don't have to satisfy
  the interface — they declare `false` and get a real, working, honestly-
  weaker implementation path instead of being blocked entirely.
- The conformance test suite (next piece of prerequisite work) can be
  written *against the capability flags*: core behavior tests run
  unconditionally for every adapter; capability-gated tests run only when
  the relevant flag is `true`, and a parallel "degraded behavior" test runs
  when it's `false`. This is exactly how better-auth's adapter test suite
  handles per-adapter differences (declared capabilities → factory adapts
  → same test suite, conditional assertions).

## What still needs verification before this is final

- The exact current `MemoryStore` method list and signatures, pulled from
  source rather than memory — re-check against
  `MONOREPO_READINESS_REPORT.md` section 2 or `src/memory/store.ts`
  directly.
- Whether `AUDIT-02`'s composite cursor genuinely needs its own capability
  flag or folds cleanly into `supportsTransactions` — this affects the flag
  count and should be settled by looking at what the Postgres
  implementation actually required to ship it.
- Whether a `supportsReferentialIntegrity: false` adapter is a real planned
  target or purely hypothetical. If nothing on the roadmap needs it, don't
  build the fallback path — document the flag as "true for all current and
  planned adapters" and revisit only if a genuinely eventually-consistent
  backend gets proposed later.
