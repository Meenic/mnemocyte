# Stabilization Proposal Verification v3

## Verification scope

This report verifies only the changes made by
`docs/design/public-memorystore-stabilization-v3.md` relative to v2, against
`docs/design/STABILIZATION_PROPOSAL_VERIFICATION_V2.md` and the repository at
commit `54864ba458f56f59968366a1230a9ec995e05b99`.

V2's already-confirmed scope, method membership, search/cancellation findings,
and two-track direction were not re-verified. The v3 proposal was treated as
the subject of verification, not as evidence. No proposal was edited and no
behavior was implemented.

The labels below are:

- **Fixed**: v3 accurately lands the requested correction.
- **Still wrong**: the corrected wording remains contradicted by or broader
  than current source.

## 1. Six v3 corrections checked

### 1. Eight-method label and cancellation differences — Fixed

V3 replaces “behaviorally identical” with “same verified postconditions” and
explicitly says that round 1 did not establish identical execution or failure
sources (`public-memorystore-stabilization-v3.md:11-17,56-59`). That is the
distinction required by round 2
(`STABILIZATION_PROPOSAL_VERIFICATION_V2.md:209-236`).

Its two examples are also accurate:

- In-memory `listAuditLog` checks cancellation cooperatively while scanning
  (`src/memory/in-memory.ts:253-292`); Postgres passes the signal to its
  cancelable event query (`src/memory/postgres.ts:442-460`;
  `src/db/queries/events.ts:33-65`).
- In-memory `getMemory` checks before its synchronous lookup
  (`src/memory/in-memory.ts:294-299`); Postgres checks immediately before and
  after the query (`src/memory/postgres.ts:463-469`).

Those differences do not alter the verified successful lookup/log
postconditions and do not create a backend feature branch or capability
consumer. V3 no longer uses them to support an identical-behavior claim.

### 2. `insertMemories` full contract — Still wrong

V3 restores the three obligations v2 omitted: detached public records,
ownership transfer of freshly prepared rows, and unknown returned IDs as a
contract violation (`public-memorystore-stabilization-v3.md:18-23`). Those
additions match the current interface
(`src/memory/store.ts:133-140`).

The same sentence nevertheless introduces a new misstatement: it calls
“exact-ID-count-and-restored-order” the store's “only ordering obligation.”
The store has **no return-order obligation**. Store order is explicitly
untrusted; shared orchestration validates the complete ID set and restores
prepared-input order (`src/memory/store.ts:134-137`;
`src/memory/client-core.ts:156-184,423-430`). Exact one-per-input-ID
cardinality is a store result-set obligation, while restored order is a shared
orchestration postcondition. Combining them as the store's ordering obligation
still assigns responsibility to the wrong layer.

V3 therefore includes all the requested contract elements but does not yet
describe their ownership accurately.

### 3. Non-dry `prune` in atomic survivor protection — Fixed

V3 now lists `deleteMemory`, `deleteMemoriesForEntity`, and non-dry `prune`
together and requires a non-interleavable check-and-mutate mechanism
(`public-memorystore-stabilization-v3.md:24-27,81-84`).

That matches both implementations. In-memory checks the complete candidate set
and mutates without an intervening `await`
(`src/memory/in-memory.ts:153-210`). Postgres uses the same guarded writable CTE
for the two deletion methods and non-dry prune, so dependent detection prevents
the complete deletion inside one statement
(`src/memory/postgres.ts:352-398`;
`src/db/queries/memories.ts:301-373`). This restores the operation round 2 said
v2 had dropped.

### 4. Audit cancellation permissiveness as a proposal decision — Fixed

V3 now calls “cooperative and active-query cancellation are both acceptable” a
**proposed contract decision**, then separately states the verified current
fact and the unresolved future choice
(`public-memorystore-stabilization-v3.md:28-34`).

That matches round 2: the two built-in mechanisms are known, while whether
future public conformance permits either or requires a particular strength is
not decided by current source
(`STABILIZATION_PROPOSAL_VERIFICATION_V2.md:265-279`). V3 no longer presents
the proposed policy as a confirmed fact.

### 5. Root `PROPOSALS.md` path — Fixed

Every v3 reference uses root `PROPOSALS.md`, and v3 correctly says that
`docs/PROPOSALS.md` does not exist
(`public-memorystore-stabilization-v3.md:35-37,65-70,102-104`).

The live root register explicitly states that future additions should leave
`approval` blank until the maintainer decides them (`PROPOSALS.md:6-9`).
V3's summary and decision track preserve that approval boundary rather than
implying authorization to implement the finding.

### 6. The two internal inconsistencies — Fixed

Both requested counts are now internally correct:

- V3 identifies two blocked matters among the reclassified methods:
  `loadConsolidationTargets` duplicate handling and `close` connection
  ownership (`public-memorystore-stabilization-v3.md:38-47,64-73`).
- It lists exactly three currently documentable backend-specific methods:
  `ensureEmbeddingCompatibility`, `markMemoriesAccessed`, and
  `addAuditEvents`, and the next-step count is correspondingly 11 methods,
  eight plus three
  (`public-memorystore-stabilization-v3.md:43-47,61-62,100-101`).

The exclusion of `close` remains supported by the roadmap's pending lifecycle
review, while supplied Drizzle connections are planned to remain caller-owned
(`docs/ROADMAP.md:76-88,96-106`).

## 2. New issues introduced by v3

### The corrected summary overstates `findDuplicatePairs` indexing

The new quick summary says `findDuplicatePairs` has “no index anywhere”
(`public-memorystore-stabilization-v3.md:75-79`). That is broader than the
verified finding.

Postgres enumerates unordered pairs with a self-join on entity and `a.id < b.id`
and computes cosine for every surviving pair
(`src/db/queries/memories.ts:386-461`). It is not a K-nearest-neighbor query,
and HNSW does not generate or prune the pairs. However, the schema still has
ordinary entity and primary-key indexes that the planner may use while
executing the join (`src/db/schema.ts:33-37,62-69`). Round 2 explicitly warned
that the accurate statement is the absence of indexed nearest-neighbor pair
generation, not the absence of every possible planner index access
(`STABILIZATION_PROPOSAL_VERIFICATION_V2.md:170-184`).

The detailed v2 wording was defensible in that specialized-search sense; the
new absolute “no index anywhere” summary loses the qualification.

### The corrected summary drops the Postgres scope from cancellation

The quick summary says generically that `prune` has in-flight statement
cancellation and `consolidate` checks only between steps
(`public-memorystore-stabilization-v3.md:86-89`). Those are specifically the
**Postgres** boundaries.

In-memory prune and consolidation use cooperative `throwIfAborted` checks
during synchronous work (`src/memory/in-memory.ts:173-210,301-388`). Postgres
prune sends `query.cancel()` to its active statement, whereas Postgres
consolidation checks around transactional statements
(`src/memory/postgres.ts:370-398,483-555`;
`src/db/cancellation.ts:14-58`). V2's detailed discussion supplied that backend
context. The new standalone summary should retain the Postgres qualifier to
avoid turning one backend's mechanism into a method-wide contract claim.

### “Both tracks are unchanged” conflicts with v3's own correction

V3's status and carry-forward text say both next-step tracks are “unchanged”
(`public-memorystore-stabilization-v3.md:3-7,49-52`), but correction 6 changes
the documentation track's literal count from four backend-specific methods to
three (`public-memorystore-stabilization-v3.md:43-47,100-101`).

The two-track **structure and direction** are unchanged and round 2 found them
sound. Their wording is not unchanged; correcting the method count is one of
v3's stated purposes. This does not alter stabilization scope, but it is a new
internal inconsistency in v3's description of its own diff.

### The rest of the corrected summary does not drift

No new issue was found in the summary's:

- exact eight-method membership and “same verified postconditions” label;
- three currently documentable backend-specific methods;
- two blocked matters and blank-approval routing;
- `vectorSearch` and `lexicalSearch` descriptions;
- three-operation atomic survivor-protection list;
- current recommendation to defer a capability surface while no consumer
  exists; or
- 11-method documentation-track total and root-register decision track.

## Overall verdict

V3 lands **five of the six corrections accurately**. The
`insertMemories` correction is still wrong because it assigns restored order
to the store rather than shared orchestration.

V3 also introduces two factual overgeneralizations in its new corrected
summary—“no index anywhere” for `findDuplicatePairs` and backend-unqualified
Postgres cancellation boundaries—and one internal inconsistency about the
tracks being unchanged while their method count is corrected.

The underlying documentation and decision tracks remain sound, but v3 is
**not yet accurate enough as written to serve as their final basis**. The
remaining issues are narrow wording corrections; they do not reopen v2's
settled scope, method bucketing, or two-track direction.
