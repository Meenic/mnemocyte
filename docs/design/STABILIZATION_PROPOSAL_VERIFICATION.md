# Stabilization Proposal Verification

## Verification scope

This report verifies
`docs/design/public-memorystore-stabilization.md` against the repository at
commit `d92c6ccf01421f1a8c5ebc34e75d11ade54918cb`.

The proposal was treated as the subject of verification, not as evidence. The
primary evidence is the current `MemoryStore` interface, both concrete stores,
the Postgres query layer, shared orchestration, tests, and the current roadmap.
The proposal was not edited and no stabilization work was implemented.

The labels used below are:

- **Confirmed accurate**: directly supported by current source.
- **Needs correction**: contradicted by current source or stated more broadly
  than the current implementations support.
- **Genuinely undetermined / maintainer decision**: current source exposes a
  gap or constraint but does not decide the future public contract.

## Overall assessment

The proposal is directionally correct that none of the current methods needs a
capability gate merely to preserve current correctness. It is not correct that
all 13 methods in the "ship as-is" bucket already have identical observable
behavior with no remaining design question.

Five of those 13 need qualification before that bucket can be treated as
verified:

- `ensureEmbeddingCompatibility` is intentionally a no-op in memory and a
  persistent dimension/model check in Postgres.
- `markMemoriesAccessed` differs for duplicate input IDs.
- `addAuditEvents` differs in batch failure atomicity.
- `loadConsolidationTargets` differs for duplicate IDs, and that difference can
  reach the current public consolidation result.
- `close` has backend-specific ownership effects, while the roadmap explicitly
  leaves caller-owned connection lifecycle for the public contract to decide.

The three highlighted documentation claims about insert ordering, atomic
survivor protection, and composite audit cursors are accurate.

The combined cancellation claim is not accurate. Postgres `consolidate` checks
between statements and before its transaction callback returns, but Postgres
`prune` requests cancellation of its one in-flight SQL statement.

The search-method bucket also needs narrower wording. Only `vectorSearch` has
the current HNSW-index-versus-in-memory-scan distinction. Postgres
`lexicalSearch` has no bundled full-text expression index, and
`findDuplicatePairs` is an all-pairs self-join rather than an indexed
nearest-neighbor operation. No current source, test, caller, TODO, or roadmap
item supplies a concrete consumer for a capability flag.

## 1. The 13-method "ship as-is" bucket

### Confirmed accurate

| Method | Verification |
| --- | --- |
| `ensureSchema` | Both concrete stores implement it as an empty async method (`src/memory/in-memory.ts:84-87`, `src/memory/postgres.ts:293-296`). Schema creation is therefore not hidden in either store. The lazy Postgres wrapper only loads and delegates to that method (`src/memory/lazy-postgres.ts:14-20`). |
| `insertMemories` | For rows prepared by shared orchestration, in-memory stores each row and returns detached clones (`src/memory/in-memory.ts:88-95`); Postgres performs one returning insert and maps every row to a public record (`src/memory/postgres.ts:297-304`, `src/db/queries/memories.ts:161-169`). Shared core validates the complete ID set and restores prepared-input order (`src/memory/client-core.ts:156-184,423-440`). No capability gate is needed. |
| `getMemoryEmbeddings` | In-memory returns copied vectors for found IDs and omits missing IDs (`src/memory/in-memory.ts:124-133`). Postgres selects the requested IDs, omits rows without an embedding, and constructs the same ID-to-vector map (`src/db/queries/memories.ts:648-665`, `src/memory/postgres.ts:330-333`). Shared core consumes the result by ID rather than position (`src/memory/client-core.ts:489-509`). |
| `deleteMemory` | Both return `false` for no entity/ID match and otherwise protect referenced survivors before deletion. In-memory checks the full map and then deletes synchronously (`src/memory/in-memory.ts:69-77,153-160`). Postgres uses the guarded delete result and maps both its dependent result and the self-FK race backstop to `"CONFLICT"` (`src/memory/postgres.ts:145-160,352-359`; `src/db/queries/memories.ts:211-220,301-374`). |
| `deleteMemoriesForEntity` | Both select the entity's complete candidate set, reject before any deletion when a candidate has a dependent, and otherwise return the deletion count. In-memory does so at `src/memory/in-memory.ts:161-171`; Postgres does so through the same guarded statement at `src/memory/postgres.ts:361-368` and `src/db/queries/memories.ts:222-230,301-374`. The shared cross-backend fixture verifies the public all-or-nothing result (`test/fixtures/consolidation-delete-policy.ts:84-89`). |
| `listAuditLog` | Successful reads have the same functional filter, strict cursor, newest-first tuple order, limit, and detached-value behavior. In-memory filters and orders at `src/memory/in-memory.ts:253-292`; Postgres applies the matching tuple predicates and order at `src/db/queries/events.ts:33-65` and maps detached events at `src/memory/postgres.ts:75-82,442-461`. Both support cancellation, although the mechanism is deliberately different: cooperative scan checks in memory versus active-query cancellation in Postgres (`src/types.ts:733-737`). That mechanism and the Postgres event index are implementation/performance differences, not a need for capability gating. |
| `getMemory` | Both return a detached memory only when both entity and memory ID match, otherwise `null` (`src/memory/in-memory.ts:294-299`; `src/db/queries/memories.ts:171-184`; `src/memory/postgres.ts:463-469`). In-memory checks cancellation before the synchronous lookup; Postgres checks immediately before and after its query. This is a timing boundary, not a different lookup postcondition. |
| `stats` | Both use the supplied `now`, count all selected memories, treat active as neither expired nor superseded, count expired and superseded independently, and return zero counts for an empty scope (`src/memory/in-memory.ts:390-419`; `src/memory/filters.ts:5-8`; `src/db/queries/memories.ts:130-159,186-209`; `src/memory/postgres.ts:558-575`). |

These eight methods support the proposal's no-capability-gating conclusion for
their current shared-client contract. They do not establish that every
backend's execution strategy or failure source is identical.

### Needs correction

| Method | Verification |
| --- | --- |
| `ensureEmbeddingCompatibility` | The adapters do not have identical observable behavior. In-memory always resolves (`src/memory/in-memory.ts:86-87`). Postgres reads installation metadata, can record the first model, and throws `"MIGRATION"` or `"CONFIG"` for missing/mixed metadata, dimension mismatch, or model mismatch (`src/memory/postgres.ts:205-290`). Shared core deliberately invokes this hook before writes, recall, and duplicate search (`src/memory/client-core.ts:328-329,351-355,408-417,453-462,687-695`). This still does not justify a capability flag: the unconditional contract can require each backend to reject incompatibility relevant to that backend. The claim of identical current behavior is what needs correction. |
| `markMemoriesAccessed` | Behavior matches for the distinct ID list that shared recall currently supplies: the merged candidate map produces unique results, and shared core normalizes returned rows by ID (`src/memory/client-core.ts:481-528`). The method itself diverges for duplicate IDs, however. In-memory loops the input, increments twice, and returns the same ID twice (`src/memory/in-memory.ts:134-151`); Postgres uses `WHERE id IN (...)`, increments the row once, and returns it once (`src/db/queries/memories.ts:617-646`). The interface says one post-update record for every input ID but does not state that IDs must be distinct (`src/memory/store.ts:148-154`). "No design work needed" is therefore too strong until the public contract either states the distinct-ID precondition or defines duplicate behavior. |
| `addAuditEvents` | Successful unique-event writes have the same persisted-value effect, including metadata cloning (`src/memory/in-memory.ts:45-52,250-252`; `src/memory/postgres.ts:429-440`). Failure atomicity is not the same. In-memory clones the whole mapped batch before one `push`, while Postgres inserts events sequentially without a wrapping transaction, so an early event can remain stored if a later insert fails. Shared core swallows the rejection because ordinary audit writes are best effort (`src/memory/client-core.ts:332-340`). That partial result can later be observed through `listAuditLog`. No capability flag follows from this, but a public postcondition cannot claim identical batch behavior without defining the failure case. |
| `loadConsolidationTargets` | Missing IDs are omitted by both implementations, but duplicate and ordering behavior differs. In-memory walks the input and therefore preserves order and repeats duplicate IDs (`src/memory/in-memory.ts:301-315`). Postgres uses `WHERE id IN (...)` without an order, so it returns each stored row at most once in database-chosen order (`src/db/queries/memories.ts:518-540`; `src/memory/postgres.ts:471-481`). Shared validation does not reject duplicate `supersededIds` (`src/memory/validation.ts:460-477`), and shared core passes the original list into `consolidate` after this load (`src/memory/client-core.ts:776-824`). Consequently a duplicated loser can be counted/audited twice by the in-memory consolidation path but once by Postgres (`src/memory/in-memory.ts:325-388`; `src/memory/postgres.ts:489-555`). This is a current caller-visible divergence, not merely a private query-order detail. |
| `close` | Shared client lifecycle is consistent because core drains active operations, blocks later admission, memoizes a successful close, and reopens admission after a failed close so it can be retried (`src/memory/client-core.ts:836-852`; `test/lifecycle/close.test.ts:117-220`). Store effects are backend-specific: in-memory destroys all memory and audit state (`src/memory/in-memory.ts:421-424`; `test/memory/in-memory-store.test.ts:4-20`), while Postgres closes its owned pool and leaves persistent rows intact (`src/memory/postgres.ts:577-579`; `src/db/index.ts:41-61`). More importantly for stabilization, the roadmap explicitly requires review of caller-owned connection lifecycle and says a supplied Drizzle connection remains caller-owned (`docs/ROADMAP.md:76-88,96-106`). The proposal's "no design work needed" classification for `close` conflicts with that still-open public lifecycle responsibility. |

### Genuinely undetermined / maintainer decision

Source shows the edge differences above but cannot decide the future public
preconditions and post-error guarantees:

- whether `markMemoriesAccessed` and `loadConsolidationTargets` require distinct
  IDs or define duplicate handling;
- whether `addAuditEvents` promises all-or-nothing batch persistence, explicitly
  permits partial persistence after rejection, or exposes only its existing
  best-effort caller semantics;
- whether a public store's `close` owns the underlying connection, only releases
  adapter-local resources, or is configured by construction mode.

Those are contract decisions. None is evidence for a capability-flag surface.

## 2. The three specific documentation claims

### Confirmed accurate

#### `insertMemories` return order belongs to shared orchestration

The proposal is correct. The interface comment explicitly says store return
order is not trusted and shared orchestration restores input order after
validating missing, duplicate, and unknown returned IDs
(`src/memory/store.ts:133-140`). `normalizeStoreRows` builds an ID map and then
maps over the expected rows (`src/memory/client-core.ts:156-184`), and both
single and batch remember paths use it around `insertMemories`
(`src/memory/client-core.ts:360-381,423-440`).

The unit test reverses a complete store result and confirms the public batch is
restored to input order; it separately rejects missing, duplicate, and unknown
returned IDs (`test/memory/store-insert-contract.test.ts:45-99`). The shared
fixture checks public cardinality and order for both built-in adapters
(`test/fixtures/store-insert-contract.ts:4-21`).

#### Referenced-survivor rejection needs a non-interleavable check and mutation

The proposal is correct. A general read followed later by a write is not what
the current implementations rely on.

In-memory computes the complete candidate set, scans all memories for a
dependent, and mutates without any `await` between the check and deletion
(`src/memory/in-memory.ts:69-77,153-210`). That synchronous critical section is
why another JavaScript write cannot interleave.

Postgres performs candidate selection, dependent detection, and conditional
deletion in one writable CTE statement
(`src/db/queries/memories.ts:301-374`). The schema's self-reference supplies an
additional concurrency backstop (`src/db/schema.ts:48-50`), and violation of
that named FK is normalized to the same `"CONFLICT"` error
(`src/memory/postgres.ts:145-160`). Architecture documentation describes the
same division of responsibility (`docs/ARCHITECTURE.md:365-382`).

This evidence covers `deleteMemory`, `deleteMemoriesForEntity`, and non-dry
`prune`; "read before write" alone would not preserve their current all-or-
nothing invariant.

#### Composite audit cursors need a stable tuple, not a transaction

The proposal is correct.

- Audit events have a unique ID and timestamp (`src/types.ts:670-683`), and
  cursors are the `{ timestamp, id }` tie-breaking tuple
  (`src/types.ts:686-696`).
- In-memory compares timestamps and then IDs, uses strict inequalities for both
  cursor directions, and sorts by the reverse of the same comparator
  (`src/memory/in-memory.ts:55-67,253-292`).
- Postgres uses strict row-value `<`/`>` predicates on `(timestamp, id)` and
  orders by `timestamp DESC, id DESC` in the same single `SELECT`
  (`src/db/queries/events.ts:33-65`).
- The cross-backend fixture pages through same-timestamp events without gaps or
  duplicates (`test/fixtures/audit-cursor.ts:41-62,75-109`).

No transaction is used or needed for the tuple semantics. In particular,
ordinary Postgres event batches are sequential inserts without a transaction
(`src/memory/postgres.ts:429-440`), while the read itself remains one ordered
statement.

### Needs correction

None of these three documentation claims needs correction.

### Genuinely undetermined / maintainer decision

Source does not decide snapshot-consistent pagination across writes occurring
between separate page requests. The proposal does not claim such a snapshot,
and the verified no-transaction tuple contract only guarantees deterministic
positioning of successfully persisted events. No additional decision is needed
to accept the proposal's narrower claim.

## 3. Postgres cancellation boundaries for `prune` and `consolidate`

### Confirmed accurate

The proposal's wording is accurate for Postgres `consolidate`.

The adapter checks before opening the transaction, before and after locking
targets, after the superseding update, around each audit insert, around tag
work, and immediately before the transaction callback returns
(`src/memory/postgres.ts:483-555`). Those checks do not pass the signal into the
Drizzle statements themselves. A blocked statement therefore remains in flight
until it finishes; the next check can then throw and roll the transaction back.

The integration test demonstrates that boundary: aborting while the target-lock
`SELECT` is blocked does not settle the operation; after the lock is released,
the next check rejects with `"ABORTED"` and no memory is superseded
(`test/integration/cancellation.test.ts:251-282`).

The final caveat is also accurate for `consolidate`. The last check is inside
the transaction callback, while the driver commits after the callback returns.
An abort after that check, including during commit, may leave the transaction
committed. Current architecture documentation says exactly that
(`docs/ARCHITECTURE.md:398-406`).

### Needs correction

The same "between-step checks, not mid-statement" characterization is false for
Postgres `prune`.

Non-dry prune passes the caller signal into `pruneMemories`; dry-run passes it
into `countPruneMatches` (`src/memory/postgres.ts:370-398`). Both routes call
`executeCancelableSql` (`src/db/queries/memories.ts:274-299,301-357`).
`executeCancelableSql` attaches an abort listener to the active postgres.js
query and calls `query.cancel()` when the signal aborts
(`src/db/cancellation.ts:14-39,42-58`). This is explicitly an in-flight
statement-cancellation mechanism, not a check between multiple mutation steps.

The integration test holds a row lock, starts prune's delete statement, aborts
while that statement is blocked, and observes prompt `"ABORTED"` rejection with
the target still present (`test/integration/cancellation.test.ts:230-249`).

There remains an unavoidable race after the query has completed: aborting after
the statement's commit cannot undo the mutation. That is not the proposal's
"abort after the final check" boundary because prune has no final
between-statement check. The combined `prune`/`consolidate` statement at
`docs/design/public-memorystore-stabilization.md:72-81` therefore needs to
distinguish the two current Postgres mechanisms.

### Genuinely undetermined / maintainer decision

Source proves the current built-in boundaries but does not decide whether a
future public conformance contract must require active query cancellation,
permit cooperative boundaries, or document cancellation as best effort per
method. That policy is genuinely undetermined. It does not change the factual
correction above.

## 4. The three-method "needs explicit scope decision" bucket

### Confirmed accurate

The proposal correctly identifies three methods whose search semantics and
performance need especially careful documentation:

- `vectorSearch` differs between a full in-memory scan with JavaScript cosine
  scoring and a Postgres pgvector distance query
  (`src/memory/in-memory.ts:96-109`;
  `src/db/queries/memories.ts:667-717`).
- `lexicalSearch` differs between the shared JavaScript lexical scorer and
  PostgreSQL English full-text parsing/ranking
  (`src/memory/in-memory.ts:111-122`;
  `src/db/queries/memories.ts:719-765`). This can change candidates and ranking,
  not merely latency.
- `findDuplicatePairs` differs between nested JavaScript loops and a pgvector
  SQL self-join (`src/memory/in-memory.ts:212-248`;
  `src/db/queries/memories.ts:386-461`). Tie order and pair orientation are not
  given a shared secondary ordering.

It is therefore accurate not to describe these methods as having identical
backend algorithms.

### Needs correction

They are not three examples of an indexed-versus-scanned capability
distinction.

Only `vectorSearch` has the bundled specialized index: the schema defines HNSW
on the vector column (`src/db/schema.ts:63-69`), and Postgres orders by the
pgvector distance operator (`src/db/queries/memories.ts:671-715`). In-memory
scans every matching memory (`src/memory/in-memory.ts:96-109`). Even here, use
of HNSW is planner- and filter-dependent, and HNSW is approximate
(`docs/ARCHITECTURE.md:475-482`).

`lexicalSearch` currently computes `to_tsvector` in the query, but the bundled
schema has no full-text expression index (`src/db/schema.ts:62-69`).
Architecture documentation explicitly warns that current large lexical
queries are scans unless an operator adds and benchmarks such an index
(`docs/ARCHITECTURE.md:490-495`).

`findDuplicatePairs` joins every unordered pair using `a.id < b.id` and filters
the computed cosine value (`src/db/queries/memories.ts:433-458`). It is not a
K-nearest-neighbor query over the HNSW index. Both built-in implementations are
pairwise scans, though one runs in SQL.

Nor are these the only methods with implementation differences that can matter
to a caller:

- `listAuditLog` scans and sorts the in-memory array
  (`src/memory/in-memory.ts:253-292`), while Postgres has an
  `(entity_id, timestamp)` index (`src/db/schema.ts:72-88`) and active query
  cancellation (`src/db/queries/events.ts:33-65`).
- `ensureEmbeddingCompatibility`, duplicate-ID access updates, audit batch
  failure atomicity, duplicate consolidation-target loading, and close/resource
  ownership have the observable differences documented in section 1.
- `deleteMemoriesForEntity` scans the in-memory map to build its candidates
  (`src/memory/in-memory.ts:161-171`), while Postgres can use the entity index
  and one guarded statement (`src/db/schema.ts:63-64`;
  `src/db/queries/memories.ts:222-230,301-374`).

These ordinary storage-mechanism differences do not imply that more capability
flags are needed. They do mean the factual claim that the named three are the
only caller-relevant implementation differences is not supported by source.

### Genuinely undetermined / maintainer decision

Source cannot decide how much performance information a future public adapter
contract should require beyond correctness and method-specific behavioral
documentation. It also cannot promise that a Postgres planner will choose HNSW
for every filtered vector query. The current source settles the narrower fact:
an indexed-vector distinction exists for `vectorSearch`; an API surface for
querying it is not established.

## 5. Deferring a capability-flag surface

### Confirmed accurate

There is no counter-evidence for the recommendation to defer a
`supportsIndexedVectorSearch`-style flag.

- The complete current `MemoryStore` surface has only `backend` plus its 18
  methods; it has no capabilities property or capability query
  (`src/memory/store.ts:121-200`).
- Shared recall calls `vectorSearch` and `lexicalSearch` unconditionally and in
  parallel, with no backend/capability branch
  (`src/memory/client-core.ts:447-480`).
- Shared duplicate search calls `findDuplicatePairs` unconditionally
  (`src/memory/client-core.ts:680-696`).
- `store.backend` is used for observability metadata, not feature selection
  (`src/memory/client-core.ts:447-452,680-686`).
- The roadmap asks for public contract tests, store-provision and lifecycle
  decisions, then `drizzleStore(db)`; it does not name a capability consumer or
  a capability-flag deliverable (`docs/ROADMAP.md:76-106`).
- A repository search across `src/`, `test/`, `README.md`,
  `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/PROJECT_MEMORY.md`,
  `CHANGELOG.md`, and `PROPOSALS.md` finds no
  `supportsIndexedVectorSearch`, capability object, capability branch, TODO, or
  comment planning such a consumer.

The existing caller behavior is a correctness-oriented unconditional contract.
The real HNSW-versus-scan distinction does not by itself create a consumer for
a flag or determine where one would live.

### Needs correction

No correction is needed to the proposal's recommendation to avoid building a
capability surface now. The recommendation remains consistent with current
source and roadmap evidence.

### Genuinely undetermined / maintainer decision

The absence of a consumer today cannot prove that a later external adapter or
performance-sensitive application will never need such metadata. Whether to
add a flag later, its location, and its exact meaning remain future maintainer
decisions. Current source supports deferral, not a permanent prohibition.

## Final verification result

The proposal is **partially verified**:

- **Confirmed accurate:** no current method needs capability gating for
  correctness; insert return order belongs to shared orchestration; survivor
  deletion needs an atomic/non-interleavable check-and-mutate mechanism;
  composite audit cursors require a stable ordered tuple and no transaction;
  Postgres consolidation has the documented between-statement/final-check
  cancellation boundary; and there is no present consumer for a capability
  flag.
- **Needs correction:** five "ship as-is" methods are not literally behavior-
  identical at their current edges; Postgres prune does support active
  mid-statement cancellation; only vector search has the built-in
  indexed-versus-scan distinction; and caller-relevant implementation
  differences are not confined to the three search methods.
- **Genuinely undetermined:** duplicate-ID preconditions, audit failure
  atomicity, public close ownership, future cancellation conformance strength,
  and any eventual capability surface remain contract decisions that current
  source cannot settle.

No alternative stabilization scope or ordering is proposed here.
