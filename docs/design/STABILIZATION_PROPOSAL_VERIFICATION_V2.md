# Stabilization Proposal Verification v2

## Verification scope

This report verifies
`docs/design/public-memorystore-stabilization-v2.md` against round 1
(`docs/design/STABILIZATION_PROPOSAL_VERIFICATION.md`) and the repository at
commit `d92c6ccf01421f1a8c5ebc34e75d11ade54918cb`.

The v2 proposal was treated as the subject of verification, not as evidence.
The primary evidence is the current `MemoryStore` interface, shared
orchestration and validation, both concrete stores, the Postgres query layer,
tests, roadmap, and the current root `PROPOSALS.md` register. Neither proposal
was edited and no stabilization behavior was implemented.

The labels used for round 1 findings are:

- **Fixed**: v2 now states the finding at the precision supported by source.
- **Partially fixed**: the central correction is present, but v2 narrows,
  broadens, or adds to what round 1 established.
- **Still wrong**: the round 1 contradiction remains.

## 1. Round 1 findings checked one at a time

### The five methods removed from the behaviorally-identical bucket

#### `ensureEmbeddingCompatibility` — Fixed

V2 accurately says that the in-memory hook always resolves while Postgres
validates persistent installation metadata and may throw `"MIGRATION"` or
`"CONFIG"` (`public-memorystore-stabilization-v2.md:60-65`).

That matches the adapters. In-memory defines an empty async hook
(`src/memory/in-memory.ts:84-87`). Postgres reads installation metadata,
records or infers the first model when permitted, and rejects missing or mixed
metadata and model/dimension mismatches
(`src/memory/postgres.ts:205-290`). Describing the unconditional contract as
requiring each backend to enforce compatibility meaningful to its persistence
model also follows round 1; this difference does not require a capability flag.

#### `markMemoriesAccessed` — Fixed

V2 accurately preserves both halves of round 1's finding
(`public-memorystore-stabilization-v2.md:67-71`):

- Shared recall currently supplies distinct IDs and normalizes returned access
  rows by ID (`src/memory/client-core.ts:481-528`).
- At the store boundary, duplicate IDs diverge. In-memory iterates the input,
  increments the same row twice, and returns two updates
  (`src/memory/in-memory.ts:134-151`); Postgres uses `WHERE id IN (...)`, so
  the row is updated and returned once
  (`src/db/queries/memories.ts:617-646`).

V2's distinct-ID precondition is a proposed public-contract choice, not a
description of the current interface: the current comment still promises one
post-update record per input ID without stating distinctness
(`src/memory/store.ts:148-154`). V2 presents the precondition as work to
document, so it does not falsely claim that the precondition already exists.

#### `addAuditEvents` — Fixed

V2 correctly distinguishes successful persistence from failure atomicity
(`public-memorystore-stabilization-v2.md:73-79`). In-memory clones the complete
batch before one `push`, so a cloning failure leaves the audit array unchanged
(`src/memory/in-memory.ts:250-252`). Postgres awaits individual inserts without
a wrapping transaction, so earlier events can remain after a later insert
rejects (`src/memory/postgres.ts:429-440`).

The recommendation to document possible partial persistence is consistent with
the current public best-effort rule: an audit storage failure does not fail the
primary operation, and audit reads expose only successfully persisted events
(`README.md:410-414`; `src/memory/client-core.ts:332-340`). V2 no longer claims
identical batch failure behavior.

#### `close` — Fixed

V2 now separates the shared client lifecycle from backend resource effects and
correctly leaves the future ownership rule blocked
(`public-memorystore-stabilization-v2.md:81-89`).

Shared core drains admitted work, rejects new admission while closing, shares
the close promise, and reopens admission after a failed store close
(`src/memory/client-core.ts:836-852`; `test/lifecycle/close.test.ts:117-220`).
The in-memory store clears memories and audit events
(`src/memory/in-memory.ts:421-424`), whereas Postgres closes its owned handle
and leaves database rows persistent (`src/memory/postgres.ts:577-579`;
`src/db/index.ts:41-61`). The roadmap both requires lifecycle review before
the public contract and states that a future supplied Drizzle database remains
caller-owned (`docs/ROADMAP.md:76-88,96-106`). V2 is therefore right not to
treat `close` as ready for final contract documentation.

### `loadConsolidationTargets` duplicate-ID divergence — Fixed

V2 accurately describes the caller-visible divergence
(`public-memorystore-stabilization-v2.md:93-105`):

- Shared validation rejects an empty list, a survivor in the loser list, and
  empty IDs, but does not reject repeated loser IDs
  (`src/memory/validation.ts:455-478`).
- In-memory target loading walks the supplied IDs and repeats a duplicated
  target (`src/memory/in-memory.ts:301-315`). Its later consolidation path
  builds `newlySuperseded` from that repeated target list before mutation, so
  it returns the loser ID twice and creates two audit events when auditing is
  enabled (`src/memory/in-memory.ts:317-388`).
- Postgres target loading and its transactional reload use `IN (...)`, so each
  stored row appears at most once. The update, returned ID list, and audit loop
  consequently count the loser once
  (`src/db/queries/memories.ts:518-564`;
  `src/memory/postgres.ts:471-555`).
- Shared core derives the public `supersededCount` from the store result length
  and returns the store's ID list (`src/memory/client-core.ts:813-829`).

Elevating this from documentation wording to an actual correctness fix matches
round 1's severity. The current public result says it counts memories actually
marked and returns IDs newly superseded (`src/types.ts:782-791`); one stored
memory cannot satisfy that postcondition twice merely because its input ID was
repeated.

### Postgres `prune` versus `consolidate` cancellation — Fixed

V2 correctly gives the two methods separate boundaries
(`public-memorystore-stabilization-v2.md:139-156`).

- `consolidate` checks the signal before the transaction, between statements,
  and immediately before the transaction callback returns. It does not pass
  the signal into those Drizzle statements, and an abort after the final check,
  including during commit, may leave the transaction committed
  (`src/memory/postgres.ts:483-555`;
  `test/integration/cancellation.test.ts:251-282`).
- Both dry and non-dry Postgres `prune` routes pass the signal to one
  cancelable SQL statement (`src/memory/postgres.ts:370-398`;
  `src/db/queries/memories.ts:274-357`). The helper attaches an abort listener
  and calls postgres.js `query.cancel()` on the active query
  (`src/db/cancellation.ts:14-58`), and the blocked-delete integration test
  demonstrates prompt `"ABORTED"` rejection
  (`test/integration/cancellation.test.ts:230-249`).

The statement that prune has no consolidate-style final between-step check is
accurate for the store query. Shared orchestration can subsequently perform
best-effort audit work after a successful non-dry prune
(`src/memory/client-core.ts:653-669`), so v2's wording should be read as the
mutation/query cancellation boundary, not as a claim that the entire public
operation contains only one action.

### The three search methods

#### `vectorSearch` — Fixed

V2 limits the bundled-index claim to `vectorSearch` and retains the necessary
qualifications (`public-memorystore-stabilization-v2.md:112-116`). The schema
bundles HNSW on the embedding column (`src/db/schema.ts:63-69`), Postgres orders
by pgvector cosine distance (`src/db/queries/memories.ts:667-715`), and
in-memory scans candidates (`src/memory/in-memory.ts:96-109`). V2 also
correctly notes that planner/filter choices can prevent index use and that HNSW
is approximate (`docs/ARCHITECTURE.md:475-482`).

#### `lexicalSearch` — Fixed

V2 accurately says that there is no bundled full-text expression index,
Postgres computes English full-text matching/ranking in the query, and
in-memory uses JavaScript lexical scoring
(`public-memorystore-stabilization-v2.md:117-122`;
`src/db/queries/memories.ts:719-765`;
`src/memory/in-memory.ts:111-122`; `src/db/schema.ts:62-69`).

Those are different matching and scoring systems, so the difference can change
which candidates are returned and their order; it is not merely a latency
difference. This is the correction round 1 required.

#### `findDuplicatePairs` — Fixed

V2 correctly describes both adapters as pairwise rather than nearest-neighbor
search (`public-memorystore-stabilization-v2.md:123-128`). In-memory uses nested
loops over each unordered candidate pair
(`src/memory/in-memory.ts:212-248`). Postgres joins rows on `a.id < b.id`,
computes cosine for the pairs, and filters/orders that result
(`src/db/queries/memories.ts:386-461`). The HNSW nearest-neighbor index is not
used to generate those pairs.

“No indexed/scanned distinction” is accurate in that specialized-search sense.
It should not be expanded into a claim that PostgreSQL cannot use ordinary
entity or primary-key indexes while executing the self-join; round 1
established the absence of indexed nearest-neighbor pair generation, not the
absence of every possible planner index access.

## 2. New inaccuracies or overgeneralizations in v2

### Duplicate `supersededIds` rejection is a supported recommendation

V2 does not overlook a source-supported reason to repeat a loser in one
consolidation call.

The current validator's checks correspond to malformed or contradictory
inputs, but its lack of a uniqueness check is not documented as intentional
permission (`src/memory/validation.ts:455-478`). Public semantics speak in
terms of memories actually superseded, one audit event per newly superseded
memory, and a returned list of newly superseded IDs
(`src/types.ts:743-760,782-791,978-998`). Tag merging is a set union, and
same-survivor idempotency concerns state from a prior call, not duplicate
occurrences within one call.

Shared validation rejecting duplicate IDs therefore looks like a coherent fix
and is consistent with the existing validation boundary. Source does not prove
that rejection is the only possible policy, so round 1 was right to call the
choice a maintainer decision. V2 preserves that status by saying to reproduce,
decide, and obtain approval before fixing it
(`public-memorystore-stabilization-v2.md:100-105`).

### The eight-method membership is exact; its label is too broad

The eight methods listed by v2 are exactly the eight rows in round 1's
“Confirmed accurate” table, in the same order:

1. `ensureSchema`
2. `insertMemories`
3. `getMemoryEmbeddings`
4. `deleteMemory`
5. `deleteMemoriesForEntity`
6. `listAuditLog`
7. `getMemory`
8. `stats`

Nothing was added or dropped
(`public-memorystore-stabilization-v2.md:30-33`;
`STABILIZATION_PROPOSAL_VERIFICATION.md:57-68`).

The new heading “behaviorally identical” and the statement that the methods
have identical observable postconditions are not equivalent. Round 1 confirmed
the listed functional postconditions for the current shared-client contract,
then explicitly warned that this does not establish identical backend
execution strategies or failure sources
(`STABILIZATION_PROPOSAL_VERIFICATION.md:70-72`). Even inside this bucket,
`listAuditLog` uses cooperative versus active-query cancellation and
`getMemory` checks cancellation at different points. The membership is exact,
but “same verified postconditions” is the supported label; unqualified
“behaviorally identical” is a new overgeneralization.

### Insert ordering — Partially preserved

V2 correctly retains the decisive rule: store return order is untrusted,
shared orchestration validates the returned ID set, and shared orchestration
restores prepared-input order
(`public-memorystore-stabilization-v2.md:41-43`;
`src/memory/client-core.ts:156-184,423-440`).

The sentence that the store's “only obligation” is one result per prepared ID
is broader than round 1. The current store contract also requires detached
public records, transfers ownership of freshly prepared rows, and rejects
unknown as well as missing/duplicate returned IDs
(`src/memory/store.ts:133-140`). The sentence is accurate only if read as “its
only ordering obligation”; as a complete `insertMemories` obligation it is
too narrow.

### Atomic survivor protection — Partially preserved

V2 correctly retains the non-interleavable check-and-mutate requirement for
`deleteMemory` and `deleteMemoriesForEntity`
(`public-memorystore-stabilization-v2.md:44-47`). It narrows round 1's confirmed
finding by omitting non-dry `prune`, which uses the same invariant. Round 1
explicitly covered all three operations
(`STABILIZATION_PROPOSAL_VERIFICATION.md:119-139`), and current architecture
still documents atomic whole-batch rejection for matching prune candidates
(`docs/ARCHITECTURE.md:365-382`).

### Composite audit cursor — Requirements preserved; cancellation policy added

V2 accurately preserves the composite-cursor requirements: a stable ID,
comparable timestamp, strict tuple filtering, matching tuple order, and no
transaction requirement (`public-memorystore-stabilization-v2.md:48-50`;
`src/types.ts:670-696`; `src/db/queries/events.ts:33-65`;
`test/fixtures/audit-cursor.ts:41-109`).

Its added statement that cooperative and active-query cancellation “are both
acceptable” is not a round 1 confirmed fact. Round 1 said current mechanisms
differ but classified the strength of a future public cancellation conformance
rule as undetermined
(`STABILIZATION_PROPOSAL_VERIFICATION.md:222-228`). Permitting either is a
reasonable proposed contract decision, but v2 presents it as settled inside a
confirmed-correct summary rather than identifying it as a new decision.

### Deferred capability flag — Preserved, with a path error

V2 accurately preserves the current recommendation to defer a capability-flag
surface. The store has no capability object/query, shared recall and duplicate
search do not branch on capabilities, and the roadmap names no consumer
(`src/memory/store.ts:127-200`;
`src/memory/client-core.ts:447-480,680-696`;
`docs/ROADMAP.md:76-106`). V2 also says to revisit if a concrete
performance-sensitive consumer appears, so it does not turn present deferral
into a permanent prohibition
(`public-memorystore-stabilization-v2.md:130-137`).

The evidence-list path is wrong: the repository has root `PROPOSALS.md`, not
`docs/PROPOSALS.md` (`public-memorystore-stabilization-v2.md:134`). There is no
tracked `docs/PROPOSALS.md` in current history. Round 1 cited the root file
correctly (`STABILIZATION_PROPOSAL_VERIFICATION.md:325-329`).

### Two additional internal inconsistencies

- V2's opening says only one of the five reclassified methods needs an actual
  decision (`public-memorystore-stabilization-v2.md:14-17`), but its `close`
  section also says final documentation is blocked on a roadmap ownership
  decision (`public-memorystore-stabilization-v2.md:81-89`). The duplicate-ID
  issue is the one current correctness fix; it is not the only decision among
  those five.
- The documentation track says to document all four intentional
  backend-specific methods and then excludes `close`
  (`public-memorystore-stabilization-v2.md:172-176`). Excluding
  `loadConsolidationTargets` and `close` leaves the eight confirmed methods
  plus three, not plus four. Current `close` behavior can be recorded as
  evidence, but its final public ownership contract is blocked by v2's own
  classification.

## 3. Is `PROPOSALS.md` still the routing mechanism?

Yes. The live file is root `PROPOSALS.md`; `docs/PROPOSALS.md` does not exist.
The current register is closed with respect to its dated 22-item audit cohort,
but it is still explicitly structured to accept a new finding.

The current source says:

- The preface identifies a dated audit snapshot, states that all 22 current
  entries are approved and resolved, and explicitly instructs that “future
  additions should leave approval blank until the maintainer decides them”
  (`PROPOSALS.md:3-17`).
- Every entry uses a reusable approval record: `id`, `category`, `risk-tier`,
  `where`, `what-was-found`, `proposed`, `how-verified`, `approval`, and
  `status`. All current approval fields are affirmative and every current
  status links a resolution commit (`PROPOSALS.md:30-638`).
- The final listed entries are the resolved low-risk `CONTEXT-02`,
  `CONFIG-02`, and `OPENAI-01` records (`PROPOSALS.md:570-638`). There is no
  open placeholder, but the preface supplies the rule for adding one.
- The staleness sweep calls the existing 22-entry cohort a closed register
  (`docs/DOCS_AUDIT.md:147-151`;
  `docs/PROJECT_MEMORY.md:198-200`). That does not close the mechanism:
  `docs/BUGS_FOUND.md:3-7` routes later findings and approval/status records to
  `PROPOSALS.md`, while `docs/NEEDS_HUMAN_INPUT.md:8-11` says it has no open
  item and retains proposal history in the same register.

No current file defines a replacement approval process. The
`loadConsolidationTargets` duplicate-ID issue therefore fits the existing root
`PROPOSALS.md` mechanism: it is a newly reproduced behavior change requiring
an explicit blank/pending approval rather than inferred authorization. V2's
process choice is supported; only its `docs/PROPOSALS.md` path and any
implication that the issue should be added without approval are wrong. This
report does not add the entry.

## Overall verdict

V2 fixes every substantive round 1 behavioral correction: the four
backend-specific methods are described accurately, `loadConsolidationTargets`
is correctly elevated to a caller-visible correctness decision, cancellation
is separated per method, and the three search methods no longer share a false
indexed-versus-scanned narrative. The duplicate-rejection recommendation has
source support, and the eight-method membership is exact.

V2 is **mostly verified, but not fully accurate as written**. Its proposed two
tracks are sound:

- The documentation track has an accurate factual basis for the eight verified
  methods, the three currently documentable backend-specific methods, and the
  three separately framed search methods.
- The decision track correctly routes duplicate loser IDs through the existing
  root proposal/approval register and correctly keeps public `close` ownership
  tied to the caller-owned Drizzle lifecycle decision.

Before treating v2 itself as the authoritative basis for those tracks, its
narrow round-2 issues should be corrected: replace the blanket “behaviorally
identical” label, scope the insert obligation, restore non-dry `prune` to the
atomic survivor-protection finding, mark cancellation-conformance permissiveness
as a proposal decision, use root `PROPOSALS.md`, and make the documentation
track's method count consistent. These corrections do not change v2's proposed
stabilization scope or ordering.
