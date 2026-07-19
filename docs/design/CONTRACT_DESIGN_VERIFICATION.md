# Contract Design Verification

## Verification scope

This report checks:

- `docs/design/memorystore-capability-contract.md`
- `docs/design/sqlite-adapter-design-notes.md`

against the repository at commit
`7f15653d545c188e12246c0513ebb463f601784a`.

The primary evidence is the current interface, both implementations, shared
orchestration, Postgres query helpers, tests, and roadmap. The two draft design
documents were not treated as evidence, and neither was edited.

The labels used below are:

- **Confirmed accurate**: directly supported by current source.
- **Needs correction**: contradicted by source, names a contract member that
  does not exist, or omits behavior that current callers require.
- **Genuinely undetermined / maintainer decision**: current source establishes
  the constraints but cannot decide the proposed future policy or SQLite
  driver behavior.

## 1. Real `MemoryStore` interface

### Confirmed accurate

The real interface is in `src/memory/store.ts:127-200`. The path anticipated
by the capability draft happens to be correct, but the draft did not verify or
reproduce the interface. `MemoryStore` is currently internal: the comment at
`src/memory/store.ts:120-126`, `README.md:540-551`, and
`docs/ARCHITECTURE.md:204-206` all say it is not a public adapter API.

The interface has one required property and 18 methods. These are the current
signatures, transcribed from `src/memory/store.ts:127-200`:

```ts
export interface MemoryStore {
  readonly backend: MnemocyteBackend;

  ensureSchema(): Promise<void>;
  ensureEmbeddingCompatibility(embedder: Embedder): Promise<void>;

  insertMemories(memories: readonly StoredMemory[]): Promise<Memory[]>;
  vectorSearch(input: StoreVectorSearchInput): Promise<StoreVectorCandidate[]>;
  lexicalSearch(
    input: StoreLexicalSearchInput,
  ): Promise<StoreLexicalCandidate[]>;
  getMemoryEmbeddings(
    memoryIds: readonly string[],
  ): Promise<Map<string, number[]>>;
  markMemoriesAccessed(
    memoryIds: readonly string[],
  ): Promise<StoreAccessUpdate[]>;

  deleteMemory(entityId: string, memoryId: string): Promise<boolean>;
  deleteMemoriesForEntity(entityId: string): Promise<number>;
  prune(
    input: ValidatedPruneFilter,
    options?: StoreOperationOptions,
  ): Promise<StorePruneResult>;
  findDuplicatePairs(
    input: FindDuplicatesInput,
    options?: StoreOperationOptions,
  ): Promise<StoreDuplicatePair[]>;

  addAuditEvents(events: readonly AuditEvent[]): Promise<void>;
  listAuditLog(
    input: ListAuditLogInput,
    options?: StoreOperationOptions,
  ): Promise<AuditEvent[]>;

  getMemory(
    entityId: string,
    memoryId: string,
    options?: StoreOperationOptions,
  ): Promise<Memory | null>;
  loadConsolidationTargets(
    entityId: string,
    ids: readonly string[],
    options?: StoreOperationOptions,
  ): Promise<StoreConsolidationTarget[]>;
  consolidate(
    input: StoreConsolidateInput,
    options?: StoreOperationOptions,
  ): Promise<StoreConsolidateResult>;

  stats(
    input: { entityId?: string } | undefined,
    now: Date,
  ): Promise<EntityStats | GlobalStats>;
  close(): Promise<void>;
}
```

Important associated types are also part of the actual boundary:

- `StoreVectorSearchInput` is
  `Omit<RecallInput, "minScore"> & { embedding; limit; minVectorScore? }`
  (`src/memory/store.ts:17-21`). It therefore carries more than scalar
  filters, including `query`, `explain`, and `signal`.
- Vector candidates are `{ memory: Memory; vectorScore: number }`, with the
  score documented as finite and clamped to `[0, 1]`
  (`src/memory/store.ts:27-31`).
- Duplicate pairs are `{ a: Memory; b: Memory; similarity: number }`
  (`src/memory/store.ts:38-42`).
- Prune returns the public `PruneResult` fields plus
  `deletedByEntity: readonly { entityId; deletedCount }[]`
  (`src/memory/store.ts:50-56`).
- Consolidation accepts `entityId`, `survivorId`, the survivor's current tags,
  all requested loser IDs, `mergeTags`, a shared `now`, and `auditEnabled`; it
  returns only `{ supersededIds }` (`src/memory/store.ts:64-80`).
- Cancellation options are `{ signal?: AbortSignal }`
  (`src/memory/store.ts:82-84`).
- `backend` is currently restricted to `"in-memory" | "postgres"`
  (`src/types.ts:59-65`). A SQLite implementation cannot satisfy this property
  without a separate contract/type change that neither draft mentions.

The capability draft correctly recognizes these real contract areas:

| Draft area | Real `MemoryStore` member(s) | Verification |
| --- | --- | --- |
| Insert | `insertMemories` | Real. Its exact-ID/cardinality contract and caller-side input-order restoration are documented at `src/memory/store.ts:133-140` and enforced at `src/memory/client-core.ts:156-184,343-440`. |
| Get | `getMemory` | Real, but it is an entity-and-ID lookup, not a general scalar get/list operation. |
| Delete | `deleteMemory`, `deleteMemoriesForEntity`, and `prune` | Real methods, with unconditional `"CONFLICT"` guarantees in the current interface comments and implementations. |
| `markMemoriesAccessed` | `markMemoriesAccessed` | Exact name and semantic match. Caller normalization is at `src/memory/client-core.ts:524-543`. |
| Basic audit write/read | `addAuditEvents`, `listAuditLog` | Real, but there is only one audit-read method; basic timestamp filtering and composite cursors are input modes of the same method. |
| `vectorSearch` | `vectorSearch` | Exact method name. Indexed versus scanned execution is not represented in the current interface. |
| `findDuplicatePairs` | `findDuplicatePairs` | Exact method name. |
| Referentially safe deletion | `deleteMemory`, `deleteMemoriesForEntity`, `prune` | Real behavior. It is currently mandatory, not capability-gated. |
| Transactional consolidation | `consolidate` | Real method. Its interface comment requires one atomic consolidation. |
| Composite audit cursor | `listAuditLog` with `beforeCursor` / `afterCursor` | Real behavior within an existing method, not a separate method. |
| Statement cancellation | `StoreOperationOptions` on six methods | Real input shape, but actual Postgres mid-statement support is operation-specific; see section 2. |
| Full-text / lexical search | `lexicalSearch` | The draft describes the area but does not use the real method name or signature. |

### Needs correction

The draft's “full interface” bucketing is not a method inventory:

- There is no separate single insert. Both public `remember` and
  `rememberMany` call `insertMemories` (`src/memory/client-core.ts:343-440`).
- There is no generic “list by scalar filter” method. `getMemory` is a keyed
  lookup; scalar filters are embedded in `vectorSearch`, `lexicalSearch`,
  `findDuplicatePairs`, and `prune`.
- There is no generic batch-delete method. The real bulk methods are
  `deleteMemoriesForEntity` and filtered `prune`.
- `forget` and `forgetAll` are public client methods, not `MemoryStore`
  methods. Shared core maps them to `deleteMemory` and
  `deleteMemoriesForEntity` at `src/memory/client-core.ts:582-636`.
- “Basic audit read” and “composite audit cursor” are not separate store
  methods. Both are `listAuditLog(input, options?)`.
- “Full-text search” is not the contract name. The required method is
  `lexicalSearch`, and its result is a numeric lexical component rather than a
  promise of native full-text indexing.

Five required methods are not mentioned at all in the bucketing:

- `ensureSchema`
- `ensureEmbeddingCompatibility`
- `getMemoryEmbeddings`
- `loadConsolidationTargets`
- `close`

Two more are mentioned only indirectly and are not actually bucketed as
required methods:

- `stats` appears only as a hypothetical place to surface capabilities.
- `lexicalSearch` is discussed as “full-text search” without its real
  signature or result contract.

This matters beyond completeness:

- `ensureEmbeddingCompatibility` is called before writes, recall, and
  duplicate scans (`src/memory/client-core.ts:328-329,354,416,461,691`). The
  Postgres implementation performs persistent installation-wide dimension and
  model checks (`src/memory/postgres.ts:205-290`).
- `getMemoryEmbeddings` is required to rescore lexical-only recall candidates
  (`src/memory/client-core.ts:489-509`).
- `getMemory` and `loadConsolidationTargets` are the shared core's
  consolidation preflight (`src/memory/client-core.ts:758-805`).
- `close` is part of coordinated client lifecycle and may be retried after
  failure (`src/memory/client-core.ts:836-852`).

No `capabilities` property, `MemoryStoreCapabilities` type, static capability
object, or capability branch currently exists. A repository search finds no
such member in `MemoryStore`, either adapter, or `client-core.ts`. That is a
proposal rather than current behavior, which is appropriate for a design
draft, but any claim that it mirrors current orchestration is not source-backed.

### Genuinely undetermined / maintainer decision

Source alone cannot decide which existing mandatory postconditions should
become optional in a future public contract. The current internal interface has
no degraded paths: every implementation must supply every method and the
documented atomicity/conflict behavior. Whether a future public interface
weakens that rule is a contract policy decision, not something the current
method list answers.

## 2. The three explicitly flagged open questions

### 2.1 Composite audit cursor versus `supportsTransactions`

#### Confirmed accurate

`AUDIT-02` is implemented as stable tuple filtering and ordering:

- Postgres applies row-value comparisons and
  `ORDER BY timestamp DESC, id DESC` in one `SELECT`
  (`src/db/queries/events.ts:33-65`).
- In-memory compares `Date.getTime()` and then event ID, using the reverse
  comparator for newest-first order
  (`src/memory/in-memory.ts:55-67,253-292`).
- `ListAuditLogInput` exposes both strict timestamp filters and stable
  `{ timestamp, id }` cursors (`src/types.ts:686-737`).
- The cross-backend fixture pages through same-timestamp events at
  `test/fixtures/audit-cursor.ts:35-104`.

#### Needs correction

Stable tuple ordering does **not** depend on a real transaction in the current
implementation. The Postgres cursor is a single ordered query; the in-memory
store supplies the same stable ordering without a database transaction.
Ordinary Postgres audit batches are themselves inserted sequentially without a
wrapping transaction (`src/memory/postgres.ts:429-440`), yet every successfully
persisted event can still be paged by the tuple.

Therefore `supportsTransactions` is not evidence for composite-cursor support,
and lack of transactions is not evidence against it. The required ingredients
shown by current source are a stable event ID, a consistently comparable
timestamp representation, strict tuple filtering, and matching tuple order.

The draft's timestamp-only “fallback” is also not equivalent to the current
`MemoryStore` contract. `listAuditLog` accepts `beforeCursor` and `afterCursor`
unconditionally. Timestamp-only `before` / `after` deliberately omit all events
at the boundary timestamp (`src/types.ts:711-732`).

#### Genuinely undetermined / maintainer decision

Whether future adapters may decline composite-cursor support, and therefore
whether it deserves a separate capability flag, is a maintainer decision.
Source settles only the narrower question: it does not fold cleanly into
transaction support.

### 2.2 A future `supportsReferentialIntegrity: false` adapter

#### Confirmed accurate

The current portable invariant is stronger than “has a foreign key”:

- In-memory checks the complete candidate set before deleting
  (`src/memory/in-memory.ts:69-77,153-210`).
- Postgres uses one guarded candidate/dependent/delete statement
  (`src/db/queries/memories.ts:301-374`).
- Postgres also retains the named `ON DELETE NO ACTION` self-FK as a race
  backstop (`src/db/schema.ts:48-50`,
  `migrations/0000_initial.sql:31`, and
  `src/memory/postgres.ts:145-160`).
- Shared documentation makes dangling `supersededBy` references invalid and
  requires the whole selected delete to reject with `"CONFLICT"`
  (`docs/ARCHITECTURE.md:365-382`).

The in-memory backend proves that the guarantee is not synonymous with native
FK support. In the draft's own proposed terminology, it would need to count as
`true` despite having no database referential-integrity engine.

#### Needs correction

The current roadmap has no planned consumer for a `false` path:

- The next concrete store is `drizzleStore(db)` over the current Postgres and
  pgvector schema (`docs/ROADMAP.md:76-109`).
- The named runtime/driver expansions are still Postgres-oriented.
- SQLite plus `sqlite-vec` appears only as a later “local-first storage
  experiment” (`docs/ROADMAP.md:135-143`), and the SQLite draft itself claims
  `BEGIN IMMEDIATE` can enforce the invariant.
- No eventually consistent, async, KV, or non-atomic store is named anywhere
  on the roadmap.

On the current roadmap, a client fallback that knowingly accepts a TOCTOU race
is speculative. There is no planned adapter against which that behavior could
be tested.

#### Genuinely undetermined / maintainer decision

The roadmap does not prohibit a future eventually consistent backend forever.
It only provides no current justification for one. Whether to reserve a flag
now despite having no consumer is a maintainer policy decision.

### 2.3 `supportsStatementCancellation`

#### Confirmed accurate

Postgres uses postgres.js `query.cancel()` through
`executeCancelableSql` (`src/db/cancellation.ts:10-59`) for exactly these store
operations:

| Store operation | Actual Postgres behavior |
| --- | --- |
| `prune` dry run | `countPruneMatches` is an in-flight cancelable `SELECT` (`src/db/queries/memories.ts:274-290`). |
| `prune` non-dry run | The guarded candidate/dependent/`DELETE` CTE is one in-flight cancelable statement (`src/db/queries/memories.ts:292-374`). |
| `findDuplicatePairs` | The pgvector self-join is cancelable (`src/db/queries/memories.ts:386-461`). |
| `listAuditLog` | The ordered audit query is cancelable (`src/db/queries/events.ts:33-65`). |

`consolidate` does not use statement cancellation. It checks before and between
transaction statements and immediately before returning from the transaction
callback (`src/memory/postgres.ts:483-555`). `getMemory` and
`loadConsolidationTargets` similarly check only before and after their query
(`src/memory/postgres.ts:463-481`).

#### Needs correction

The draft credits both too little and too much:

- It says postgres.js cancellation is technically available “for reads,” but
  non-dry `prune` uses it for a mutating `DELETE` statement too. That is more
  maintenance-operation coverage than the draft acknowledges.
- It also discusses one adapter-wide boolean, but statement cancellation is
  not applied to all reads or all signal-bearing operations. `vectorSearch`,
  `lexicalSearch`, `getMemoryEmbeddings`, stats queries, `getMemory`, and
  `loadConsolidationTargets` do not use `executeCancelableSql`.
- Postgres and the proposed SQLite path are alike for `consolidate`
  between-step cancellation, but they are not alike for `prune`: current
  Postgres prune has mid-statement cancellation for both preview and deletion,
  while the SQLite draft promises only checks around local statements.

Consequently, neither blanket value is an accurate description of the current
Postgres adapter unless the future flag first defines exactly which operations
it covers.

#### Genuinely undetermined / maintainer decision

The current source can enumerate behavior but cannot decide the meaning or
granularity of the proposed future flag. That definition is a maintainer
contract decision.

## 3. SQLite four-method sanity check

### `vectorSearch`

#### Confirmed accurate

The broad execution model can satisfy the current method:

- Storage encoding is not prescribed by `MemoryStore`. Decoding a packed BLOB
  to `number[]` and scoring in JavaScript is compatible with the return type.
  Current Postgres pgvector storage is float4-based, so a deliberately defined
  float32 representation is not inherently at odds with observed backend
  precision.
- The in-memory implementation already scans, filters, computes cosine,
  clamps, sorts descending, and slices
  (`src/memory/in-memory.ts:96-110`).
- Shared helpers already exist as `cosineSimilarity` and `toVectorScore`
  (`src/retrieval/scorer.ts:39-56,82-90`).

#### Needs correction

As written, the notes omit parts of the real method contract:

- The return must be
  `{ memory: Memory; vectorScore: number }[]`, not rows containing an exposed
  embedding. Returned memories must be detached public objects with no runtime
  `embedding` field and with copied tags, metadata, and dates. Current record
  mapping behavior is visible in `src/memory/records.ts:24-46`.
- `vectorScore` must be finite and in `[0, 1]`
  (`src/memory/store.ts:27-31`).
- `minVectorScore` must be applied to the **clamped component** before limiting.
  Both current adapters do this (`src/memory/in-memory.ts:98-109` and
  `src/db/queries/memories.ts:671-715`). The SQLite notes say clamp, sort, and
  slice but omit this filter.
- All real recall filters must match: exact entity, default exclusion of
  superseded and expired rows, optional inclusion flags, type membership,
  all-tags semantics, and strict `createdAt < before` /
  `createdAt > after`. The authoritative JS behavior is
  `src/memory/filters.ts:94-120`.
- Results must represent the highest vector components in descending order
  before `limit`. There is no current deterministic tie-break guarantee:
  in-memory sorts only by score and Postgres orders only by distance.
- Recall also requires `getMemoryEmbeddings` to decode the same stored format
  for lexical-only candidates (`src/memory/client-core.ts:489-509`). That
  required companion method is absent from the SQLite notes.

The BLOB proposal is therefore feasible, but the written method design is not
yet a complete statement of what the current caller consumes.

#### Genuinely undetermined / maintainer decision

The repository contains no SQLite driver, schema, or BLOB codec. Byte order,
driver return types, float32 conversion details, and whether a query can be
interrupted are not verifiable from current source.

### `findDuplicatePairs`

#### Confirmed accurate

An entity-scoped JavaScript `O(n^2)` scan can satisfy the interface. The
in-memory implementation proves the basic algorithm:
`src/memory/in-memory.ts:212-249`. Cooperative checks between comparisons are
consistent with current in-memory cancellation behavior.

Keeping only the best `limit` pairs is a real backlog recommendation at
`docs/PERFORMANCE_REVIEW.md:106-120`; it is not current behavior, but it can be
semantics-preserving if implemented exactly.

#### Needs correction

The SQLite notes need to account for these existing requirements:

- Apply defaults in the adapter: threshold `0.95` and limit `100`
  (`src/memory/defaults.ts:23-26`,
  `src/memory/in-memory.ts:214-215`, and
  `src/memory/postgres.ts:405-407`).
- Include pairs at the threshold (`similarity >= threshold`), clamp similarity
  to `[0, 1]`, order descending, and return at most `limit`.
- Return each unordered pair exactly once. `DuplicatePair` explicitly defines
  `{a,b}` and `{b,a}` as the same logical pair
  (`src/types.ts:647-661`).
- Apply the entity, type, all-tags, include-superseded, and include-expired
  rules to **both** pair members
  (`src/memory/filters.ts:63-92` and
  `src/db/queries/memories.ts:434-458`).
- Return detached public `Memory` values for both `a` and `b`. Shared core
  clones both again when mapping the public pair
  (`src/memory/client-core.ts:225-234`).
- Honor `options?.signal` before and cooperatively during candidate filtering
  and pair comparison, not only in the innermost cosine calculation.

The notes call the bounded top-`limit` approach a near-direct port, but current
in-memory code collects all qualifying pairs, sorts them, and then slices.
The bounded approach is an unshipped optimization and must preserve the same
threshold, ordering, filter, and no-duplicate behavior; the performance backlog
states those exact verification requirements
(`docs/PERFORMANCE_REVIEW.md:108-120`).

#### Genuinely undetermined / maintainer decision

No source evidence establishes which bounded top-k data structure, SQLite
driver, or BLOB decoding implementation will be used. Those mechanics cannot be
verified before an adapter exists.

### `prune`

#### Confirmed accurate

For a non-dry run, `BEGIN IMMEDIATE`, candidate selection, a dependent check,
and deletion before commit can satisfy the atomic survivor-protection rule if
all competing SQLite writers use the same database locking protocol. The notes
correctly include references where both the dependent and survivor are in the
candidate set; current behavior rejects that case too
(`docs/ARCHITECTURE.md:365-382`).

Computing per-entity counts from the pre-delete candidate set is also the right
kind of data for shared core. Shared core uses those details to emit one
best-effort audit event per affected entity
(`src/memory/client-core.ts:638-678`).

#### Needs correction

The design is incomplete against the real signature and caller:

- It omits `dryRun`. A dry run must return
  `{ matchedCount, deletedCount: 0, dryRun: true,
  deletedByEntity: [] }` and must not delete or reject merely because a matched
  survivor has dependents. Current behavior is at
  `src/memory/in-memory.ts:173-210`,
  `src/memory/postgres.ts:370-398`, and
  `test/fixtures/consolidation-delete-policy.ts:103-112`.
- The adapter must independently reject an internal filter with no effective
  selector by calling the equivalent of `assertPruneFilterHasSelector`.
  Shared core validates first, but both current adapters defend the storage
  boundary too (`src/memory/store.ts:98-116`,
  `src/memory/in-memory.ts:173-176`, and
  `src/memory/postgres.ts:370-374`).
- Every selector is AND-combined. Exact behavior includes:
  `expiresAt <= now`, `supersededBy !== null`, strict `createdBefore`,
  null-or-strictly-before `notAccessedSince`, type membership, all requested
  tags, and the configured importance rank
  (`src/memory/filters.ts:11-61`).
- The real return type is `StorePruneResult`, including `deletedByEntity`.
  Shared core rejects empty entity IDs, non-positive/non-integer counts,
  duplicate entity rows, wrong entity scope, a per-entity sum different from
  `deletedCount`, or any dry-run details
  (`src/memory/client-core.ts:186-222`).
- A non-dry-run dependent match must throw a `MnemocyteError` with code
  `"CONFLICT"` before any candidate is deleted
  (`src/memory/store.ts:158-163` and `src/memory/deletion.ts:3-8`).

The cancellation comparison also needs correction. SQLite's proposed
between-step checks match Postgres `consolidate`, but current Postgres `prune`
uses mid-statement postgres.js cancellation for its count and guarded delete.
The SQLite behavior would be a real, narrower guarantee relative to current
Postgres prune, not existing parity.

Finally, the notes call `BEGIN IMMEDIATE` an equivalent of Postgres row-locking
intent “here.” Current Postgres prune does not use `FOR UPDATE`; it uses one
materialized candidate/dependent/delete CTE plus the FK backstop
(`src/db/queries/memories.ts:301-374`). Row locks are used by consolidation,
not prune.

#### Genuinely undetermined / maintainer decision

The codebase cannot verify how the chosen SQLite driver exposes
`BEGIN IMMEDIATE`, rollback, busy handling, aborts, or concurrent connections.
The design's locking proof depends on those unselected implementation details.

### `consolidate`

#### Confirmed accurate

The core concurrency design matches the observed contract:

- Shared orchestration performs an earlier survivor/loser preflight outside the
  mutation (`src/memory/client-core.ts:758-812`).
- The store must re-read the requested losers under its mutation lock because
  the earlier read is not concurrency-safe.
- A same-survivor retry is a zero-count no-op; any different-survivor loser
  rejects the complete call with `"CONFLICT"` before mutation.
- Loser updates, consolidation audit events, and optional survivor-tag merge
  must commit or roll back together.

Current Postgres implements that with a transaction and stable-ID
`FOR UPDATE` loser locks (`src/memory/postgres.ts:483-555`,
`src/db/queries/memories.ts:542-615`). `BEGIN IMMEDIATE` can serialize competing
SQLite writers coarsely enough to implement the same loser-claim rule.

The notes also correctly disclose that whole-database write serialization is
coarser than Postgres row locking. It is not, however, a stronger observable
contract guarantee; both mechanisms are intended to produce the same atomic
result for this method.

#### Needs correction

The notes omit required output and mutations:

- Return exactly `{ supersededIds: readonly string[] }`, containing only IDs
  newly superseded by this call. Shared core derives the public count from
  `result.supersededIds.length`
  (`src/memory/store.ts:78-80`,
  `src/memory/client-core.ts:813-829`).
- Set each newly changed loser's `supersededBy`, `supersededAt`, and
  `updatedAt` using `input.now`
  (`src/memory/in-memory.ts:375-380`,
  `src/db/queries/memories.ts:567-594`).
- Merge tags only from losers actually changed in this call, and only when
  `input.mergeTags` is true. The current stores do not re-merge tags from
  already-same-survivor no-ops.
- Write one `"memory.superseded"` event per newly changed loser only when
  `input.auditEnabled` is true, with `memoryId`, `supersededBy`, and
  `input.now`, inside the same transaction
  (`src/memory/postgres.ts:519-531`).
- Preserve the final abort check immediately before the transaction callback
  returns if the notes intend to match the current Postgres cancellation
  boundary (`src/memory/postgres.ts:552-554`).

There is also a referential race missing from the proposed SQLite steps.
Shared core reads the survivor **before** `BEGIN IMMEDIATE`. Current Postgres
has an `ON DELETE NO ACTION` FK backstop if the survivor disappears before or
during the transaction. A SQLite implementation that does not enforce the FK
and re-reads only losers, as the notes currently say, can write
`supersededBy` to a survivor deleted between shared preflight and lock
acquisition. To meet the current no-dangling-reference contract, the SQLite
transaction needs an equivalent atomic survivor-existence guarantee. The
current notes do not account for it.

The public `"VALIDATION"` and `"NOT_FOUND"` cases are primarily owned by shared
preflight (`src/memory/client-core.ts:753-812`); the store's crucial race-time
typed error is `"CONFLICT"` for a different current survivor.

#### Genuinely undetermined / maintainer decision

Source does not establish whether a future SQLite schema will enable and rely
on SQLite foreign keys, revalidate the survivor under `BEGIN IMMEDIATE`, or use
another equivalent mechanism. It also cannot verify driver commit/cancellation
behavior. Those choices determine whether the proposed transaction actually
satisfies the current invariant.

## 4. General accuracy pass

### Confirmed accurate

The drafts correctly identify several important source facts:

- The internal `MemoryStore` boundary and shared orchestration already exist;
  backend mechanics are in `src/memory/in-memory.ts` and
  `src/memory/postgres.ts`, while orchestration is in
  `src/memory/client-core.ts`.
- Vector search need not be natively indexed to satisfy current semantics.
  In-memory already performs JS cosine scan-and-score.
- Postgres uses pgvector for vector search and a pgvector self-join for
  duplicate detection.
- Postgres lexical search uses `to_tsvector`, `websearch_to_tsquery`, and
  `ts_rank`, while in-memory uses the JS lexical scorer
  (`src/db/queries/memories.ts:719-764`,
  `src/memory/in-memory.ts:111-123`).
- Non-dry delete/prune operations reject referenced survivor deletion with
  `"CONFLICT"` in both current adapters.
- Postgres consolidation transactionally couples loser updates, enabled audit
  writes, and tag merging, and its cancellation checks occur between
  statements rather than canceling the active transaction statement.
- Composite audit pagination uses `(timestamp, event ID)` descending in both
  adapters.
- SQLite-style JS scoring would not require a vector extension for semantic
  correctness, only for acceleration.
- The performance tradeoff between SQLite-wide write serialization and
  Postgres row-level concurrency is directionally correct.

### Needs correction

Other claims are inaccurate, internally inconsistent, or unsupported by
current source:

1. **There is no capability contract today.** No capabilities object is
   exported by either adapter, no client branch exists, and current `stats()`
   has no capability field. It returns only entity/global counts
   (`src/memory/store.ts:196-200`,
   `src/memory/in-memory.ts:390-420`,
   `src/memory/postgres.ts:558-575`).

2. **The proposed vector-search flag cannot currently be “surfaced via
   `stats()` or similar.”** That would be a new return shape, not use of an
   existing mechanism.

3. **There is no shared-client lexical fallback.** Every store is required to
   implement `lexicalSearch`. In-memory performs JS scoring inside its adapter;
   Postgres performs SQL full-text search inside its adapter. A capability
   value does not currently make `client-core.ts` supply an alternate scorer.

4. **The two drafts contradict each other on duplicate-search capabilities.**
   The capability draft puts `findDuplicatePairs` acceleration behind
   `supportsIndexedVectorSearch`; the SQLite notes say no flag is needed.
   Current Postgres code is an `O(n^2)` self-join, and
   `docs/PERFORMANCE_REVIEW.md:108-120` treats bounded preselection as
   unshipped, benchmark-dependent future work. Source provides no evidence
   that the HNSW recall-index capability describes duplicate-pair acceleration.

5. **`DOCS-DEF-01` is misapplied to SQLite `vectorSearch`.** The resolved
   “roughly a few thousand memories per entity” guidance is specifically about
   in-memory quadratic `findDuplicates`
   (`docs/NEEDS_HUMAN_INPUT.md:90-115`, `README.md:376-378`).
   A per-candidate vector scan is linear, not the same algorithmic shape. The
   existing threshold cannot be transferred to SQLite vector search from that
   decision.

6. **The bounded duplicate algorithm is not already proven in the in-memory
   adapter.** It is a P3 backlog item. The existing adapter collects all
   qualifying pairs, sorts, and slices
   (`src/memory/in-memory.ts:221-248`).

7. **Postgres prune does not use the row-lock pattern described by the SQLite
   notes.** Its atomicity comes from one guarded SQL statement and the FK
   backstop. `FOR UPDATE` is specific to consolidation.

8. **Statement cancellation is neither a reads-only feature nor an
   adapter-wide guarantee.** The exact operation set is documented in section
   2.3.

9. **“SQLite v1” is not a committed roadmap target.** The roadmap commits to
   public `MemoryStore`, Postgres `drizzleStore(db)`, and MCP in order. SQLite
   plus `sqlite-vec` is only a later experiment
   (`docs/ROADMAP.md:76-143`).

10. **“Dependency-free SQLite adapter” is not established by this
    repository.** Avoiding a vector extension removes one possible dependency,
    but the repository has no selected SQLite driver or runtime API. Current
    source cannot support the stronger claim that an adapter as a whole adds no
    dependency.

11. **SQLite is not currently positioned as a persistent production option.**
    README exposes only in-memory and Postgres; the roadmap calls SQLite a
    future local-first experiment. The draft's development/prototyping/smaller
    production positioning is new product guidance, not verified current
    guidance.

12. **Backend identity is a missing prerequisite.** The required
    `MnemocyteBackend` union has no `"sqlite"` member
    (`src/types.ts:59-65`), and neither design notes that a new adapter cannot
    currently report its backend through `MemoryStore`.

13. **The current interface has no generic transaction API.** Atomicity is
    expressed as postconditions on particular methods. That matches
    `src/memory/store.ts`, and it means a proposed `supportsTransactions` flag
    is not describing an existing callable store feature.

### Genuinely undetermined / maintainer decision

Current source cannot resolve these future-design claims:

- whether capability flags should be public, internal, or queryable through a
  new stats shape;
- whether any currently mandatory method postcondition should have a degraded
  path;
- which SQLite driver/runtime, transaction API, busy policy, BLOB codec, or
  cancellation mechanism would be supported;
- whether FTS5 is available in the chosen SQLite distribution or whether a
  SQLite adapter would use JS lexical scoring;
- whether SQLite will advance from a roadmap experiment to a versioned adapter
  target and what workloads it will officially support.

Those are real design decisions. They should not be presented as verified facts
about the current codebase.
