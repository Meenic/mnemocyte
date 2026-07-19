# SQLite Adapter Design Notes — The Four High-Difficulty Methods

Scope: `vectorSearch`, `findDuplicatePairs`, `prune`, and `consolidate` — the
four methods `MONOREPO_READINESS_REPORT.md` rated High difficulty for
SQLite. This is a design proposal, not a report — it makes real
recommendations rather than deferring them. Everything here is meant to be
read before any SQLite adapter code is written, and revised if reality
disagrees once implementation starts.

**Core decision governing all four:** SQLite v1 does not depend on a vector
extension. Where Postgres uses pgvector, SQLite v1 mirrors the *in-memory*
backend's algorithm — SQL narrows candidates by scalar filters, JavaScript
does the vector math — with SQLite supplying real persistence instead of a
`Map`. `sqlite-vec` becomes an optional, later acceleration layer behind a
capability flag, not a v1 requirement. This keeps the adapter dependency-free
and de-risks the whole SQLite effort down to "can we match the in-memory
backend's already-proven behavior with a different persistence layer,"
rather than "can we replicate pgvector."

---

## `vectorSearch`

**v1 design:** Store embeddings as SQLite `BLOB` (packed float32, not JSON —
smaller and avoids float-string round-trip precision issues, which
`SERIALIZATION-01` already taught us matter). `vectorSearch` issues one SQL
query that applies every non-vector filter (entity, type, tags, date range,
`now()`-relative expiry) exactly like the existing scalar filters, pulls
back the candidate rows including their embedding BLOBs, decodes each BLOB
to a `number[]` in JS, computes cosine the same way the in-memory scorer
already does, clamps to `[0, 1]`, sorts, and slices. This is close to a
direct reuse of the in-memory backend's scoring code — the shared clamp/
cosine helper should be extracted so both adapters call the same function
rather than reimplementing it a third time.

**Performance framing:** this makes SQLite's `vectorSearch` cost scale with
however many rows survive the SQL-level scalar filters per entity — the
same shape as the in-memory backend's own limitation. Reuse the exact
guidance already settled in `DOCS-DEF-01` (in-memory is fine to a few
thousand memories per entity, Postgres recommended beyond that) rather than
inventing new numbers for SQLite specifically; the underlying algorithm is
the same.

**Capability flag:** `supportsIndexedVectorSearch: false` in v1. A later
`sqlite-vec`-backed path can flip this to `true` and let the client prefer
indexed search when available, without changing the public contract.

---

## `findDuplicatePairs`

**v1 design:** Nearly a direct port of the in-memory backend's existing
algorithm — SQL filters the entity-scoped candidate set, JS does the O(n²)
pairwise cosine scan with cooperative cancellation checks between
comparisons, keeping only the best `limit` pairs (this is also
`PERFORMANCE_REVIEW.md`'s P3 recommendation for the in-memory backend
itself — apply it to SQLite from the start rather than porting the naive
version first). No new algorithm design needed here; the risk is
implementation fidelity to the in-memory version, not a new hard problem.

**Capability flag:** none needed — this one doesn't get meaningfully better
with `sqlite-vec` unless a future version adds bounded ANN-based
preselection, which is out of scope for v1.

---

## `prune`

**v1 design:** SQLite's transaction model actually makes the "all-or-nothing,
no dangling survivor reference" guarantee more straightforward to reason
about than Postgres's CTE, not less — SQLite is single-writer, so one
`BEGIN IMMEDIATE` transaction gets you real isolation without needing a
materialized CTE:

1. `BEGIN IMMEDIATE` (acquires the write lock up front, rather than
   lazily on first write — this is SQLite's practical equivalent of
   Postgres's row-locking intent here).
2. `SELECT` candidate IDs matching the validated internal filter.
3. `SELECT` whether any memory's `supersededBy` points at a candidate ID
   (including candidate-to-candidate references within the same selected
   set) — same check `deleteMemoriesForEntity` already needs.
4. If any dependent exists, `ROLLBACK` and reject the entire prune with
   `"CONFLICT"` before any row is touched — matching current Postgres/
   in-memory behavior exactly.
5. Otherwise `DELETE` the candidates, compute per-entity counts from the
   pre-delete candidate set (group by `entity_id` in JS or SQL, either
   works at SQLite's expected scale), `COMMIT`.

**Cancellation — a disclosed, honest gap, not a fake parity claim:** SQLite
queries are local and typically fast enough that mid-statement cancellation
isn't the same kind of problem it is for a network-bound Postgres query.
v1 checks `signal.aborted` before opening the transaction and immediately
after step 2, before any mutation — the same "check between steps, don't
promise mid-statement cancellation" approach Postgres's own `consolidate`
already uses and discloses. Do not claim stronger cancellation guarantees
than this actually provides.

---

## `consolidate`

**v1 design:** This is the one where SQLite's single-writer model is a real
asset. `BEGIN IMMEDIATE` acquires the write lock for the whole database
before any other write transaction can start — which is a *coarser* but
*stronger* guarantee than Postgres's per-row `FOR UPDATE` locks for this
specific operation. Inside that transaction:

1. Re-read each requested loser's current `supersededBy` (the same
   preflight-then-recheck pattern Postgres uses, since the caller's earlier
   read is never sufficient on its own).
2. Apply `CONSOLIDATION-01`'s approved policy: same-survivor retry is a
   zero-count no-op; a loser already pointing at a *different* survivor
   rejects the **entire call** with `"CONFLICT"` before anything mutates —
   mixed-batch atomicity, matching what already shipped for Postgres.
3. Update active losers, insert the `"memory.superseded"` audit event(s),
   and merge survivor tags, all inside the same transaction.
4. `COMMIT`.

**The real, disclosed tradeoff:** because SQLite locks the whole file for
writes, a `consolidate` call will serialize against *any* other concurrent
write to the database (a `remember`, a `prune`, another `consolidate`) —
not just conflicting ones. This is coarser than Postgres, which can run
unrelated writes concurrently. This isn't unique to `consolidate`, it's a
property of SQLite generally, but it's worth stating explicitly here since
it's the method most likely to be called under real write contention.
Document it plainly rather than letting someone assume SQLite matches
Postgres's concurrency model.

**Cancellation:** same honest between-steps approach as `prune`, which
again isn't a new weaker guarantee — it's the same one Postgres's own
`consolidate` already accepts and documents (an abort after the final
check, including during commit, may still leave the mutation committed).

---

## What this means for the adapter as a whole

None of the four methods need a new dependency to be *correct*. Three of
them (`vectorSearch`, `findDuplicatePairs`, and the concurrency shape of
`prune`/`consolidate`) are direct extensions of algorithms the codebase has
already proven correct once, in the in-memory backend. The genuinely new
work is SQLite-specific transaction handling (`BEGIN IMMEDIATE` sequencing)
and BLOB embedding encoding — both concrete, bounded engineering tasks, not
open research questions.

The honest cost being paid for zero-dependency v1: `vectorSearch` and
`findDuplicatePairs` won't be *fast* at Postgres/pgvector scale, and
`consolidate`/`prune` will serialize against other writes more coarsely
than Postgres does. Both are disclosed, documented limitations consistent
with positioning SQLite the same way the in-memory backend is already
positioned — a real, persistent, dependency-free option for development,
prototyping, and smaller production workloads, with Postgres remaining the
recommended path at scale. That's a coherent, honest story to ship, not a
compromise to hide.
