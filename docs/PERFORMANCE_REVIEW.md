# Performance Review

This review tracks current performance work for Mnemocyte. It focuses on
compute, memory allocation, database I/O, and benchmark coverage without
changing the public API or product architecture.

## Current Verdict

The file is legitimate as an internal maintenance backlog, but the remaining
items are optimizations rather than correctness bugs. Benchmark coverage, stats
parity, query-term precomputation, and per-recall scoring config normalization
are complete. Database index and duplicate-search changes should be driven by
query plans from representative data.

This document does not set product sequencing. Version `0.3.0` is published
with the internal `MemoryStore` boundary. The active architecture decisions are
whether that contract is ready to become public and how a future
`drizzleStore(db)` should handle caller-owned resources.

This file tracks performance only. The v1 architecture review also identified
correctness and API-stability follow-ups, including public store design,
remaining runtime input validation, and database/migration error normalization.
Track those in `ARCHITECTURE.md`, `ROADMAP.md`, and
`PROJECT_MEMORY.md`, not as performance backlog items.

## Priority Policy

Use this qualitative order for backlog decisions:

1. Correctness and data integrity.
2. Hot-path latency for `recall` and `buildContext`.
3. Write-path throughput.
4. Tooling and benchmarks.

Correctness or data-integrity work preempts every optimization below even when
the issue is tracked in `ARCHITECTURE.md`, `PROPOSALS.md`, or another
correctness-focused document. This policy deliberately does not invent global
latency, throughput, or “worth doing” thresholds; evaluate concrete changes
with representative measurements.

## Active Priority List

### P1 - Hot-Path Latency

1. **De-duplicate Postgres vector distance expressions**
   - **Area:** Database compute.
   - **Current state:** Recall candidate rows no longer return stored
     embeddings in the main vector/lexical result sets. Lexical-only rescoring
     uses a narrow `id, embedding` lookup. The remaining cost is that
     `vectorSearch()` computes `embedding <=> query` in `SELECT`, `WHERE`, and
     `ORDER BY`.
   - **Work:** Use a subquery or CTE so vector distance is computed once per
     candidate, while preserving current ranking and `MemoryWithScore` output.
   - **Verification:** Add/compare Postgres recall benchmark results and keep
     retrieval quality tests passing.
   - **Risk:** Medium. The SQL shape changes on the core recall path.

2. **Use top-k selection for in-memory recall**
   - **Area:** Compute and allocation.
   - **Current state:** In-memory recall scans all memories, scores all matching
     candidates, filters by score, sorts the whole result set, then slices to
     `limit`.
   - **Work:** Keep a bounded top-k set after `minScore`, then sort only that
     final set.
   - **Verification:** Existing retrieval tests pass and a benchmark confirms
     top-k equivalence for larger in-memory datasets.
   - **Risk:** Low to medium. Tie ordering must remain deterministic enough for
     tests and callers.

3. **Index in-memory memories by `entityId`**
   - **Area:** Compute.
   - **Current state:** Many in-memory operations scan the whole `Map`, even
     though most APIs are entity-scoped.
   - **Work:** Maintain `Map<string, Set<string>>` from entity ID to memory IDs
     and use it for recall, `forgetAll`, stats, prune with `entityId`, and
     duplicate detection.
   - **Verification:** Lifecycle tests cover remember, rememberMany, forget,
     forgetAll, prune, consolidate, stats, and close so stale IDs cannot remain.
   - **Risk:** Medium. Every mutation path must update the secondary index.

4. **Reduce repeated context formatting/token counting**
   - **Area:** Compute and allocation.
   - **Current state:** `buildContext()` uses binary search over memory count,
     but each probe slices arrays, formats the candidate context, and calls the
     token counter.
   - **Work:** Avoid repeated slices where easy, and consider prefix formatting
     for markdown/plain outputs if measurements show real tokenizer cost.
   - **Verification:** Context output snapshots remain identical for markdown,
     plain, and XML.
   - **Risk:** Low to medium. Formatting output must remain stable.

### P2 - Write-Path Throughput

5. **Batch audit inserts for batched operations**
   - **Area:** Database I/O.
   - **Current state:** Postgres `rememberMany()` fires one best-effort audit
     insert per created memory. Consolidation inserts one audit event per
     superseded memory inside the transaction when audit is enabled.
   - **Work:** Add an internal bulk event insert helper and use it where audit
     events are already naturally batched.
   - **Verification:** Audit tests confirm all expected events are written and
     primary operations still succeed if best-effort audit insertion fails.
   - **Risk:** Low to medium. Preserve current best-effort behavior for
     non-transactional audit writes.

### P3 - Tooling, Maintenance Paths, and Benchmarks

6. **Bound duplicate-search work**
   - **Area:** Database compute and in-memory compute.
   - **Current state:** Duplicate detection is pairwise: Postgres uses a
     self-join and in-memory uses nested loops, both effectively `O(n^2)` per
     entity candidate set.
   - **Work:** For in-memory, keep only the best `limit` pairs instead of
     sorting every matching pair. For Postgres, consider bounded preselection
     only if benchmarks show the self-join dominates real workloads.
   - **Verification:** Duplicate tests preserve threshold, ordering, filters,
     and no-duplicate behavior. Extend duplicate benchmarks across
     representative entity sizes without turning one fixture into a universal
     support threshold.
   - **Risk:** Medium if Postgres candidate bounding can hide valid pairs.

7. **Add supporting indexes only after `EXPLAIN`**
   - **Area:** Database I/O and benchmark evidence.
   - **Current state:** The bundled migration has entity, entity/type, event
     timestamp, and HNSW indexes. It does not include a full-text GIN expression
     index, a tag GIN index, or date/access partial indexes.
   - **Work:** Capture `EXPLAIN (ANALYZE, BUFFERS)` for representative recall,
     filtered recall, prune, stats, and duplicate-search workloads. Add only
     indexes that prove useful enough to justify write overhead.
   - **Likely candidates:** GIN on `tags`, GIN expression index for
     `to_tsvector('english', content)`, `(entity_id, created_at)`, and possibly
     partial indexes for active/non-superseded rows.
   - **Verification:** Migration tests pass; query plans improve on target
     workloads; write overhead is documented.
   - **Risk:** Medium. Indexes are persistent schema surface.

## Completed or Downgraded Items

- **Postgres recall row width:** Main vector and lexical candidate rows no
  longer return stored embeddings. Remaining work is vector-distance expression
  de-duplication, not row-width reduction.
- **Postgres stats materialization:** Replaced with SQL aggregates. Keep tests
  around it, but do not treat it as active performance work. Stats parity
  assertions now cover empty, active, expired, superseded, pruned, deleted,
  entity, and global scenarios.
- **Benchmark coverage:** `bench:retrieval` now runs multiple in-memory sizes
  and optional Postgres sizes when `DATABASE_URL` is configured.
- **Recall scoring constants:** Recall paths now precompute lexical query terms
  and normalized scoring config once per recall operation.
- **Query embedding caching:** Not recommended by default. It risks memory
  pressure and invalidation complexity unless a caller has a proven repeated
  query workload.

## Recommended Implementation Order

1. Resolve any correctness or data-integrity issue before optimization work.
2. Investigate the Postgres vector-distance CTE/subquery and in-memory recall
   top-k work with representative measurements.
3. Decide on in-memory entity indexing based on expected development and
   prototyping workloads.
4. Reduce `buildContext` formatting/token-counting work if profiling shows it
   is material.
5. Batch audit writes if audit-enabled write workloads make them material.
6. Bound experimental duplicate-search work only with semantics-preserving
   evidence.
7. Capture `EXPLAIN` and benchmark evidence before adding persistent indexes.

## Validation Checklist

- Run `pnpm checktypes` after TypeScript changes.
- Run targeted tests for the touched subsystem: `test:retrieval`,
  `test:context`, `test:dedup`, `test:audit`, and `test:integration` when
  Postgres is available.
- Compare `bench:retrieval` before and after recall/scoring/context changes.
- For Postgres query or index changes, capture `EXPLAIN (ANALYZE, BUFFERS)` on
  representative data.
- Confirm output compatibility for `Memory`, `MemoryWithScore`, `stats()`,
  `findDuplicates()`, and `buildContext()`.
