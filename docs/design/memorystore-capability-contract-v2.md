# `MemoryStore` Public Contract — Revised Design (v2)

This supersedes `memorystore-capability-contract.md` and the `consolidate`
section of `sqlite-adapter-design-notes.md`. Every correction below traces to
`CONTRACT_DESIGN_VERIFICATION.md`, which is the actual evidence source — cite
that report, not this document, for file:line references.

**Framing correction up front:** SQLite is not a committed roadmap target.
The confirmed adapter sequence is public `MemoryStore` → `drizzleStore(db)` →
`@mnemocyte/mcp`; SQLite appears only as a later "local-first experiment."
Everything SQLite-specific below is exploratory design work to stress-test
the contract, not a commitment to ship it next. No capability system exists
in the codebase today — this entire document is a proposal, not a
description of current behavior.

## The real interface (verified, not reconstructed from memory)

18 methods, transcribed by the verification run from `src/memory/store.ts:127-200`:

```ts
export interface MemoryStore {
  readonly backend: MnemocyteBackend;

  ensureSchema(): Promise<void>;
  ensureEmbeddingCompatibility(embedder: Embedder): Promise<void>;

  insertMemories(memories: readonly StoredMemory[]): Promise<Memory[]>;
  vectorSearch(input: StoreVectorSearchInput): Promise<StoreVectorCandidate[]>;
  lexicalSearch(input: StoreLexicalSearchInput): Promise<StoreLexicalCandidate[]>;
  getMemoryEmbeddings(memoryIds: readonly string[]): Promise<Map<string, number[]>>;
  markMemoriesAccessed(memoryIds: readonly string[]): Promise<StoreAccessUpdate[]>;

  deleteMemory(entityId: string, memoryId: string): Promise<boolean>;
  deleteMemoriesForEntity(entityId: string): Promise<number>;
  prune(input: ValidatedPruneFilter, options?: StoreOperationOptions): Promise<StorePruneResult>;
  findDuplicatePairs(input: FindDuplicatesInput, options?: StoreOperationOptions): Promise<StoreDuplicatePair[]>;

  addAuditEvents(events: readonly AuditEvent[]): Promise<void>;
  listAuditLog(input: ListAuditLogInput, options?: StoreOperationOptions): Promise<AuditEvent[]>;

  getMemory(entityId: string, memoryId: string, options?: StoreOperationOptions): Promise<Memory | null>;
  loadConsolidationTargets(entityId: string, ids: readonly string[], options?: StoreOperationOptions): Promise<StoreConsolidationTarget[]>;
  consolidate(input: StoreConsolidateInput, options?: StoreOperationOptions): Promise<StoreConsolidateResult>;

  stats(input: { entityId?: string } | undefined, now: Date): Promise<EntityStats | GlobalStats>;
  close(): Promise<void>;
}
```

Note: `backend` is currently `"in-memory" | "postgres"` (`src/types.ts:59-65`).
Any new backend needs this union extended before it can report its identity —
a real prerequisite the earlier draft missed entirely.

`forget`/`forgetAll` are **not** `MemoryStore` methods — they're public client
methods that shared orchestration maps to `deleteMemory`/
`deleteMemoriesForEntity`. Don't design store-level capability flags around
public API names; design them around the 18 methods above.

## Corrected bucketing

### Core — every adapter implements these unconditionally, no flag

All 18 methods are currently mandatory with no degraded path — the real
interface has zero optionality today. That's the honest starting point:
"capability-gated" is a *new* concept this design introduces, not something
that already exists to extend. Treat every flag below as adding a documented
exception to an otherwise-uniform requirement, not formalizing something
already implicit.

Methods that clearly stay core regardless of backend, because every current
implementation (including in-memory, which has no database engine at all)
already satisfies them without special-casing:

- `insertMemories` — exact cardinality/ordering contract (`STORE-01`).
- `getMemory`, `loadConsolidationTargets` — keyed lookups; no backend-specific
  difficulty.
- `markMemoriesAccessed` — scalar update; `RETRIEVAL-02`'s real-post-update
  contract.
- `deleteMemory`, `deleteMemoriesForEntity`, `prune` — including their
  `"CONFLICT"` rejection. The in-memory backend already proves this doesn't
  require a database referential-integrity engine (see below).
- `addAuditEvents`, `listAuditLog` — including composite-cursor pagination
  (`beforeCursor`/`afterCursor`). Confirmed to need no transaction — a stable
  event ID, comparable timestamp, strict tuple filtering, and matching tuple
  order are sufficient, and both current adapters achieve it without wrapping
  inserts in a transaction.
- `ensureSchema`, `ensureEmbeddingCompatibility`, `getMemoryEmbeddings`,
  `close` — no evidence either current adapter treats these as anything but
  mandatory, and `getMemoryEmbeddings` specifically is a required companion
  to `vectorSearch` for lexical-only recall rescoring, not an optional extra.

### Capability-gated — genuinely differ by backend, with real evidence

- **`supportsIndexedVectorSearch`** — gates whether `vectorSearch` is
  accelerated (pgvector) or scan-and-score in JS (in-memory today; a future
  SQLite-without-`sqlite-vec` adapter would also be `false`). This is the one
  flag with a real current example on both sides — keep it.

- **Statement cancellation — needs to be operation-scoped, not one boolean.**
  The verification found Postgres's actual cancellation coverage is uneven:
  `prune` (both dry-run and delete), `findDuplicatePairs`, and `listAuditLog`
  use real mid-statement cancellation; `consolidate`, `getMemory`, and
  `loadConsolidationTargets` only check between steps; `vectorSearch`,
  `lexicalSearch`, `getMemoryEmbeddings`, and `stats` use no cancellation at
  all. A single `supportsStatementCancellation: boolean` would misdescribe
  the adapter that already exists. If this is worth modeling at all, it needs
  to be a per-operation capability, not adapter-wide — or dropped in favor of
  just documenting, per adapter, which specific operations support
  mid-statement cancellation versus between-step checks only.

### Dropped from the previous draft — no evidence, no planned consumer

- **`supportsTransactions`** — the real interface has no generic transaction
  API; atomicity is expressed as postconditions on individual methods
  (`consolidate`, `prune`). There's nothing today for this flag to describe.
  Drop it. If a future adapter needs a genuinely different atomicity
  strategy, model that directly on the specific method's contract, not
  through a generic boolean nothing currently reads.

- **`supportsReferentialIntegrity: false`** — dropped. No adapter on the
  actual roadmap needs this path: the next store (`drizzleStore(db)`) is
  still Postgres/pgvector-based, and even the unconfirmed SQLite exploration
  assumes `BEGIN IMMEDIATE` can enforce the invariant. The in-memory backend
  already proves the guarantee doesn't require a database engine's FK
  support at all — it's a check-the-full-candidate-set-first pattern, doable
  by any backend that can read before it writes. Keep the "CONFLICT on live
  survivor reference" rule as an unconditional core requirement, full stop,
  unless and until a genuinely eventually-consistent backend is actually
  proposed — at which point design the fallback against that adapter's real
  constraints, not speculatively now.

- **`supportsFullTextSearch`** — dropped as a flag; not dropped as a real
  distinction. `lexicalSearch` is mandatory for every adapter, and both
  current adapters already implement it differently (Postgres: SQL
  `to_tsvector`/`ts_rank`; in-memory: JS lexical scoring) without any
  client-side branching existing or being needed. A future adapter without
  native full-text support just implements `lexicalSearch` with JS scoring,
  the same way in-memory already does. This was never actually a capability
  gap — every adapter is already required to produce a lexical score by
  whatever means it has.

- **Surfacing capabilities through `stats()`** — dropped. `stats()`'s current
  return shape is entity/global counts only; treating this as an available
  extension point overstated what exists. If capabilities need to be
  queryable at all, that's new API surface to design deliberately, not a
  reuse of an existing mechanism.

## `consolidate` — the corrected SQLite design (fixes the survivor race)

The verification found a real gap in the prior SQLite notes: shared core
reads the survivor **before** any store-level transaction begins. Current
Postgres covers the resulting race with an `ON DELETE NO ACTION` FK backstop
— if the survivor is deleted between shared preflight and lock acquisition,
the foreign key constraint prevents the dangling write. The prior SQLite
design only re-checked *losers* inside `BEGIN IMMEDIATE`, never re-validated
the survivor, and proposed no equivalent backstop. That's a real hole:
without one, a SQLite adapter could write `supersededBy` pointing at a
survivor no longer in the table.

**Corrected sequence**, still using `BEGIN IMMEDIATE`, now closing that gap:

1. `BEGIN IMMEDIATE`.
2. Re-read the survivor's current existence and state inside the
   transaction — not just the losers. If the survivor no longer exists,
   `ROLLBACK` and reject (matching what Postgres's FK would enforce
   automatically).
3. Re-read each requested loser's current `supersededBy`, same as before.
4. Apply `CONSOLIDATION-01`'s policy: same-survivor retry is a zero-count
   no-op per loser; a loser pointing at a different survivor rejects the
   **entire call** with `"CONFLICT"` before any row changes.
5. If SQLite foreign keys are enabled and a `supersededBy` FK with
   `ON DELETE NO ACTION`-equivalent behavior is part of the schema, that's
   the preferred mechanism — mirroring Postgres exactly rather than
   reimplementing the guarantee at the application level. Whether the
   chosen SQLite driver/schema actually supports and enables this is listed
   below as still undetermined; the re-read in step 2 is the fallback if it
   doesn't.
6. Update newly-changed losers' `supersededBy`/`supersededAt`/`updatedAt`
   using the shared `now`, merge survivor tags only from losers actually
   changed in this call and only when requested, write one
   `"memory.superseded"` audit event per newly-changed loser when auditing
   is enabled, all inside the same transaction.
7. Final abort check immediately before the transaction commits, matching
   Postgres's own cancellation boundary — same between-steps-only guarantee,
   not mid-statement.
8. `COMMIT`.

Return exactly `{ supersededIds: readonly string[] }` — the real
`StoreConsolidateResult` shape — containing only IDs newly superseded by this
call, not merged with data from prior no-op calls.

## What's still genuinely undetermined

These are real open questions the verification confirmed source can't answer
— maintainer decisions, not things to guess at:

- Whether a queryable capabilities surface is worth building at all, given
  only one flag (`supportsIndexedVectorSearch`) currently has real backing.
- Whether per-operation cancellation granularity is worth modeling formally
  or just documenting per-adapter in prose.
- SQLite driver/runtime choice, transaction API, busy-timeout policy, BLOB
  codec, and whether the chosen driver supports foreign keys and mid-query
  cancellation at all.
- Whether FTS5 is available in whatever SQLite distribution gets chosen, or
  whether `lexicalSearch` ships as JS scoring from the start (consistent with
  in-memory's existing approach either way).
- Whether SQLite graduates from roadmap experiment to a real versioned
  target, and if so, what workload scale it's officially positioned for —
  this needs to be a deliberate product decision, not backed into by
  implementation momentum.

## Net effect of this revision

The capability system shrinks from five proposed flags to one with real
justification (`supportsIndexedVectorSearch`), plus an acknowledgment that
statement cancellation needs finer granularity than a boolean if it's worth
modeling at all. That's a better outcome than it sounds — most of what the
original draft tried to solve with capability flags turns out to already be
achievable as an unconditional core requirement, proven by the fact that
in-memory (a backend with zero database engine underneath it) already meets
every one of them. The contract is simpler and stricter than first designed,
not weaker.
