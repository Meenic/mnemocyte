# Contract Design Verification V2

## Scope and overall verdict

This report verifies
`docs/design/memorystore-capability-contract-v2.md` against the current
worktree at commit `7f15653d545c188e12246c0513ebb463f601784a` and against
the findings in `CONTRACT_DESIGN_VERIFICATION.md`.

The tracked source is still at the same commit used by round 1. No
`MemoryStore` source, caller, or implementation has changed since that report.

**Overall verdict:** v2 is a substantial correction and is reliable as a
source-informed direction document, but it is not yet an implementation-ready
capability contract. It fixes the interface inventory, public/store method
confusion, audit-cursor reasoning, dropped flags, and `stats()` claim. It is
still partially inaccurate or underspecified in four material places:

1. It calls `insertMemories` an ordering contract even though store return
   order is explicitly untrusted.
2. It overgeneralizes the in-memory referential check to any backend that can
   read before writing, omitting the required atomicity/serialization.
3. Its Postgres cancellation breakdown is correct for every operation it
   names but is not a full 18-method breakdown.
4. Its SQLite survivor re-read closes the deletion race, but “current state,”
   race-time error behavior, tag-source behavior, and exact audit-event fields
   remain underspecified.

The “one flag with real justification” conclusion is only partially
source-backed. Source proves an indexed-versus-scanned implementation
distinction; it does not prove that a capability flag or queryable capability
surface is needed.

## 1. Interface transcription

### Confirmed accurate

The v2 code block at
`docs/design/memorystore-capability-contract-v2.md:18-48` still matches
`src/memory/store.ts:127-200`. Line wrapping differs, but names, parameter
types, optional options, and return types are exact:

```ts
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
```

The required property is also exact:

```ts
readonly backend: MnemocyteBackend;
```

`MnemocyteBackend` remains `"in-memory" | "postgres"` at
`src/types.ts:59-65`, exactly as v2 says. A SQLite backend still requires that
union to be extended.

There are still 18 methods. Nothing has been added, removed, or changed since
round 1.

### Needs correction

The interface transcription itself needs no correction.

One later summary of a transcribed method does: v2 line 74 calls
`insertMemories` an “exact cardinality/ordering contract.” The actual store
contract requires exactly one detached result for every expected ID, but
**does not trust store return order**. Shared orchestration validates IDs and
restores input order (`src/memory/store.ts:133-140`,
`src/memory/client-core.ts:156-184`). This is a new inaccurate shorthand in
v2, not a source change.

## 2. Round-1 findings, checked one at a time

| Round-1 finding | V2 status | Verification |
| --- | --- | --- |
| Invented scalar-list and generic batch-delete methods; omitted real methods | **Confirmed fixed** | V2 transcribes all 18 methods and no longer presents a generic scalar list, generic batch delete, or separate single insert as store members. The five methods named in the objective—`ensureSchema`, `ensureEmbeddingCompatibility`, `getMemoryEmbeddings`, `loadConsolidationTargets`, and `close`—are present at v2 lines 24-46 and discussed at lines 75-90. |
| `forget` / `forgetAll` were treated as store methods | **Confirmed fixed** | V2 lines 54-57 correctly identify them as public client methods mapped to `deleteMemory` and `deleteMemoriesForEntity`. The mapping remains at `src/memory/client-core.ts:582-636`. |
| Composite audit cursor was tied to transactions | **Confirmed fixed** | V2 lines 82-86 correctly say tuple ordering does not require a transaction. Postgres uses one tuple-filtered ordered query; in-memory uses the same timestamp/ID ordering without a database transaction. Round-1 evidence remains at `CONTRACT_DESIGN_VERIFICATION.md`, section 2.1. |
| A speculative `supportsReferentialIntegrity: false` path was proposed | **Partially fixed** | Dropping the unused `false` path is consistent with the roadmap, and the in-memory backend genuinely enforces the current rule without FK/database-engine support. V2 overgeneralizes why that works; details follow below. |
| Postgres statement cancellation was described as one adapter-wide boolean | **Partially fixed** | V2 accurately lists the operations it names and correctly rejects one blanket boolean. It does not provide a complete per-operation account across all 18 methods. |
| `supportsTransactions` and `supportsFullTextSearch` were retained despite no matching generic API/capability gap | **Confirmed fixed** | The reasoning at v2 lines 113-140 matches source: there is no generic transaction API, atomicity is method-specific, `lexicalSearch` is mandatory, and adapters already implement lexical scoring differently without a shared-client fallback branch. The decision to drop flags is still a proposed contract decision rather than a fact forced by TypeScript. |
| Existing `stats()` could surface capabilities | **Confirmed fixed** | V2 lines 142-146 explicitly retract that claim. Current `stats()` returns only entity/global counts (`src/memory/store.ts:196-200`). |

### Referential-integrity claim

#### Confirmed fixed

V2 is right that the in-memory adapter enforces survivor protection without a
database FK:

- `assertNoDependentMemories` scans the full map
  (`src/memory/in-memory.ts:69-77`).
- `deleteMemory`, `deleteMemoriesForEntity`, and non-dry `prune` call it before
  mutation (`src/memory/in-memory.ts:153-210`).
- The check and subsequent mutations are synchronous, with no `await` between
  them. Other JavaScript work cannot interleave inside that critical section.

It is also right that the roadmap names no adapter needing a deliberately
weaker, racy fallback. Round 1 section 2.2 remains valid.

#### Still wrong

V2 lines 123-126 say the invariant is “doable by any backend that can read
before it writes.” That is too broad. A read followed by a write is subject to
TOCTOU races when another writer can interleave. In-memory succeeds not merely
because it can read first, but because its full check and mutation execute as
one non-interleavable synchronous operation. Postgres instead uses one guarded
statement plus the FK backstop.

The source supports “no database FK is inherently required”; it does not
support “ordinary read-before-write is sufficient for any backend.”

#### Maintainer decision

Dropping the flag and keeping `"CONFLICT"` unconditional is a defensible design
choice based on the current roadmap. It is not a conclusion source can force
for all future adapters. V2 appropriately defers reconsideration until a real
weaker backend exists, but “drop it” remains a maintainer decision.

### Statement-cancellation breakdown

#### Confirmed fixed

Every operation v2 names is characterized correctly:

- `prune` dry-run and non-dry statements, `findDuplicatePairs`, and
  `listAuditLog` pass a signal to `executeCancelableSql`
  (`src/db/queries/memories.ts:274-374,386-461`,
  `src/db/queries/events.ts:33-65`).
- `consolidate` checks before and between transaction statements and just
  before the transaction callback returns; it does not cancel an in-flight
  statement (`src/memory/postgres.ts:483-555`).
- `getMemory` and `loadConsolidationTargets` check immediately before and
  after their single queries, not during them
  (`src/memory/postgres.ts:463-481`).
- `vectorSearch`, `lexicalSearch`, `getMemoryEmbeddings`, and `stats` do not
  wire database-statement cancellation
  (`src/memory/postgres.ts:306-333,558-575`).

“Between steps” is accurate for `consolidate`; for `getMemory` and
`loadConsolidationTargets`, “pre/post query checks” is the more exact wording.

#### Partially fixed

V2 presents this as a per-operation breakdown but leaves eight methods
unclassified:

- `ensureSchema`
- `ensureEmbeddingCompatibility`
- `insertMemories`
- `markMemoriesAccessed`
- `deleteMemory`
- `deleteMemoriesForEntity`
- `addAuditEvents`
- `close`

None accepts or propagates a caller cancellation signal through the current
`MemoryStore` signature. The guarded query helper used by `deleteMemory` and
`deleteMemoriesForEntity` is called without a signal, so its postgres.js
promise is not connected to caller cancellation.

The v2 conclusion that one adapter-wide boolean is inaccurate remains correct.
The inventory is just incomplete when judged against the full 18-method
interface.

### Dropped transaction/full-text flags and `stats()`

#### Confirmed fixed

The factual reasoning is accurate:

- `MemoryStore` exposes no transaction handle or generic transaction method.
  It expresses atomicity in the `consolidate` comment and observed
  delete/prune postconditions.
- `lexicalSearch` is required from every adapter. In-memory performs JS
  scoring inside the adapter, while Postgres performs SQL full-text search
  inside the adapter; `client-core.ts` does not branch on native full-text
  support.
- Current `stats()` cannot carry capability information without a new return
  shape.

#### Maintainer decision

Source demonstrates that those three proposed flags are unnecessary for
current behavior. Whether a future public contract reserves any of them is
still a design decision. V2 generally presents the removals as design choices,
but its “there's nothing today” reasoning should not be read as proving that no
future consumer can exist.

## 3. Corrected SQLite `consolidate` design

### The survivor-deletion race is closed

The new survivor re-read at v2 lines 162-177 closes the specific race found in
round 1, conditional on `BEGIN IMMEDIATE` successfully starting a write
transaction:

1. If another writer deletes the survivor before this connection obtains the
   write transaction, the transaction's survivor query sees the committed
   deletion and rejects.
2. If this connection obtains the write transaction first, SQLite permits only
   one simultaneous writer, so another connection cannot delete the survivor
   between the re-read and loser updates.

There is therefore no unsafe gap merely because shared core's first read
remains outside the transaction. The second read is the concurrency-relevant
one.

This depends on actual SQLite transaction behavior, not Mnemocyte source.
SQLite's official transaction documentation says `BEGIN IMMEDIATE` starts a
write transaction immediately and may return `SQLITE_BUSY` when another write
transaction is active:
<https://www.sqlite.org/lang_transaction.html#deferred_immediate_and_exclusive_transactions>.
V2 correctly keeps driver choice, busy handling, and transaction API in its
undetermined list.

### Sequencing versus the real inputs and caller

| V2 step | Verification |
| --- | --- |
| Re-read survivor after `BEGIN IMMEDIATE` | **Correct for the deletion race.** Shared core's earlier `getMemory` is at `src/memory/client-core.ts:758-775`; it is not a lock. |
| Re-read losers and reject a different survivor | **Correct.** `StoreConsolidateInput.supersededIds` includes all requested IDs, including same-survivor no-ops. The store must recheck before mutation. |
| Update only newly changed losers with `input.now` | **Correct.** This accounts for `supersededBy`, `supersededAt`, and `updatedAt`. |
| Merge tags only from newly changed losers when requested | **Correct in intent.** It matches current store behavior and `input.mergeTags`. The source of the survivor's base tag set is still ambiguous in v2. |
| Write enabled audit events in the same transaction | **Correct in intent.** It preserves transaction coupling. Exact event contents remain underspecified. |
| Final abort check | **Correct boundary if the driver transaction wrapper commits only after the callback/step completes.** As with Postgres, an abort after this check or during commit can still leave the change committed. |
| Return `{ supersededIds }` with newly changed IDs only | **Correct.** Shared core derives `supersededCount` from its length at `src/memory/client-core.ts:825-829`. |

### Still missing or ambiguous

1. **“Current existence and state” is not fully defined.** Step 2 explicitly
   rejects only a missing survivor. Shared core also rejects a survivor whose
   `supersededBy` is non-null with `"VALIDATION"`
   (`src/memory/client-core.ts:770-774`). If another writer supersedes the
   survivor between shared preflight and `BEGIN IMMEDIATE`, the transaction
   re-read must say whether that changed state also rejects. The wording
   “and state” hints at the check but does not specify it.

2. **The race-time missing-survivor error code is unspecified.** Shared
   preflight uses `"NOT_FOUND"` when the first read misses. A Postgres FK race
   currently reaches the Postgres operation wrapper rather than that preflight
   branch. Source does not define a portable error code for this exact race,
   so v2 should treat it as a maintainer decision instead of only saying
   “reject.”

3. **The survivor tag source is ambiguous.** `StoreConsolidateInput` supplies
   `survivorTags` from shared core's pre-transaction snapshot
   (`src/memory/client-core.ts:813-823`), and current Postgres starts its union
   from that field (`src/memory/postgres.ts:533-548`). V2 now re-reads the
   survivor “state” inside the SQLite transaction but does not say whether tag
   merging uses the re-read tags or `input.survivorTags`. The two choices
   differ if tags changed between preflight and lock acquisition.

4. **Exact audit-event contents are omitted.** Current Postgres writes
   description `"memory.superseded"`, metadata
   `{ memoryId, supersededBy }`, and timestamp `input.now`
   (`src/memory/postgres.ts:519-531`). V2 specifies event count and audit
   gating, but not metadata or timestamp.

5. **The final-abort wording is slightly stronger than the actual boundary.**
   Current Postgres checks before its transaction callback returns; the driver
   commits afterward. V2's “immediately before the transaction commits” is
   accurate only as a conceptual sequence, not a promise that cancellation can
   interrupt commit. The round-1 caveat still applies.

6. **Optional SQLite FK support remains genuinely undetermined.** V2 calls it
   the “preferred mechanism” while also correctly admitting that no driver or
   schema has been selected. Preference is a maintainer design choice, not a
   fact established by current source.

Subject to those clarifications, the proposed order—survivor check, loser
checks, mutation, audit/tag work, final abort check, commit—is consistent with
`StoreConsolidateInput`, `StoreConsolidateResult`, and shared orchestration.

## 4. General accuracy pass on v2

### Confirmed accurate

- SQLite is not a committed next adapter; it is a later roadmap experiment.
- No capability system exists today.
- The backend union lacks SQLite.
- All 18 methods are mandatory today, with no degraded path.
- Composite audit ordering does not depend on transactions.
- Lexical scoring already differs by adapter without client branching.
- Current `stats()` does not expose capabilities.
- A single statement-cancellation boolean cannot truthfully summarize
  Postgres.
- The v2 “genuinely undetermined” list correctly treats capability exposure,
  cancellation modeling, SQLite driver/runtime/FTS5 choices, and SQLite product
  status as maintainer decisions.

### New inaccuracies or overcorrections introduced in v2

1. **Store ordering:** v2 newly describes `insertMemories` as an ordering
   contract. Store order is intentionally untrusted; shared core owns order
   restoration.

2. **Read-before-write generalization:** v2 newly claims any backend that can
   read before writing can preserve referential integrity. Atomic exclusion,
   locking, a conditional write, or an equivalent non-interleavable mechanism
   is also required.

3. **Incomplete “core” list:** v2 first says all 18 methods are mandatory, but
   the explicit core bullets at lines 74-90 name only 13. `vectorSearch`,
   `lexicalSearch`, `findDuplicatePairs`, `consolidate`, and `stats` are not
   listed there. Later sections discuss them, so this is an internal bucketing
   ambiguity rather than another interface-inventory omission.

4. **Incomplete cancellation inventory:** v2 correctly classifies ten
   methods, not all 18. Calling it operation-scoped without accounting for the
   remaining methods makes the summary incomplete.

5. **“One flag with real justification” overstates the evidence.** Source
   proves Postgres has a pgvector/HNSW-capable path and in-memory scans in
   JavaScript. It does not prove that callers need a flag, where it should
   live, or that Postgres's planner will use the HNSW index for every filtered
   query. V2 itself lists whether any queryable capability surface is worth
   building as undetermined. The supported conclusion is “one candidate flag
   describes a real implementation distinction,” not “one flag is already
   justified as API.”

6. **The corrected survivor-state check remains only half-specified.** V2
   claims the survivor race is fixed while explicitly handling disappearance
   but not an intervening change to `supersededBy`.

### Facts versus maintainer decisions

The following are source-confirmed facts:

- current method signatures and mandatory postconditions;
- current backend implementations and cancellation call sites;
- absence of a generic transaction API, capability surface, or capability
  fields in `stats()`;
- current roadmap ordering.

The following remain maintainer decisions even where v2 recommends one:

- whether to add `supportsIndexedVectorSearch` at all;
- whether capability information is public, internal, or absent;
- whether cancellation is modeled formally or documented;
- whether the dropped flags are reserved for future use;
- whether SQLite uses an FK, an application-level locked recheck, or both;
- SQLite driver, error mapping, busy policy, lexical implementation, release
  timing, and workload positioning.

## Final assessment

V2 fixes the central round-1 factual failures and is accurate enough to guide
the next design discussion. It is **not yet an accurate implementation
specification** because the surviving capability has no defined surface or
consumer, the core/cancellation inventories are incomplete, and the corrected
SQLite consolidation sequence leaves several race-time semantics unstated.

Before implementation planning can treat it as authoritative, the document
would need to resolve or explicitly defer the items listed above. No different
contract design is proposed here; this report only identifies where v2's
existing claims are confirmed, partial, incorrect, or still a maintainer
decision.
