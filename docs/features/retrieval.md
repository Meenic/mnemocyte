# Retrieval and context

## Recall pipeline

`recall({ entityId, query, … })` in `memory/client-core.ts`:

1. Validate input; resolve `limit` (default 10) and `minScore` (default 0)
   from the input, then `config.defaults`.
2. Check embedding compatibility (Postgres) and embed the query.
3. Run two candidate searches in parallel, each with
   `limit × candidateMultiplier` (default 3) and the same filters (`types`,
   `tags` must all match, `before`/`after` on `created_at`, superseded and
   expired rows excluded unless asked for). A list whose fusion weight is 0
   is not searched.
   - **vector**: cosine similarity, clamped to `[0, 1]`. Postgres orders by
     `embedding <=> $query` (HNSW when the planner chooses it); in-memory scans
     every row.
   - **lexical**: Postgres uses `content_tsv @@
     websearch_to_tsquery('english', $query)` ordered by `ts_rank`, then
     `id`, where `content_tsv` is a stored `to_tsvector('english', content)`
     column with a GIN index; in-memory uses the fraction of whitespace-split
     query terms found as substrings.
4. Rank each list and fuse the ranks (below). A memory missing from a list
   has no rank there; nothing is loaded to fill it in.
5. Apply the boosts, filter by `minScore`, sort, keep `limit`.
6. Increment access state for the returned ids (see below) and return them.

## Fusion and boosts

**Ranks.** Each list is already sorted by its own score. Ranks are 1-based
competition ranks ("1224"): equal scores share a rank, so ties do not depend
on the order a store returned them in.

**Reciprocal rank fusion (RRF).** A memory scores `Σ w / (k + rank)` over the
lists it appears in, with `k = 60` and list weights `vector = 1`,
`lexical = 1` by default (Cormack, Clarke and Büttcher, 2009, plus per-list
weights). RRF uses positions only, so `ts_rank` (often around 0.06), the
in-memory substring fraction and cosine similarity never share a scale, and
both backends fuse the same way. The sum is divided by its best value,
`(w_vector + w_lexical) / (k + 1)`, so `fused` is in `[0, 1]`: rank 1 in both
lists is 1, rank 1 in one list is 0.5, and rank 10 in both lists (about
0.87) beats rank 1 in one.

**Boosts.** The final score is `fused × boostFactor`, with

```
boostFactor = (1 + r × recency + i × importance) / (1 + r + i)
```

where `recency = exp(-ln2 × ageDays / recencyHalfLifeDays)` (half-life 90
days), `importance` is low 0, normal 0.5, high 0.8, critical 1, and `r` and
`i` default to 0.1. The factor is in `(0, 1]`, so `score` stays in `[0, 1]`.
Boosts multiply instead of adding, so a memory that matched neither search
well cannot rank high only for being new or important. At the defaults the
factor ranges from 1/1.2 to 1, which near the top of one list is worth about
12 rank positions between a stale low-importance memory and a fresh
critical one. `confidence` and `accessCount` do not affect ranking.

**Ties** in the final score go to the newer `createdAt`, then the lower id.

**Config.** `fusion.k`, `fusion.vector`, `fusion.lexical`, `boosts.recency`
and `boosts.importance` must be finite and non-negative, and the two list
weights must not both be 0; `recencyHalfLifeDays` must be positive and
`candidateMultiplier` an integer of at least 1. Violations throw `"CONFIG"`
at construction.

**Result fields.** `scores` holds `vectorRank`, `lexicalRank`, `vector`
(cosine) and `lexical` (the backend's own score), each `null` when the
memory is not in that list, plus `fused`, `recency` and `importance`.
`explain: true` adds the effective `fusion` and `boosts`, the `boostFactor`
and `finalScore`.

**Tests.** `test/retrieval/fusion.test.ts` covers the maths and the recall
merge. `test/integration/ranking.test.ts` checks on Postgres that a
full-text match beats a substring coincidence, that a memory found by both
searches comes first, that lexical-only candidates fuse without an
embedding lookup, and that the boosts order equal matches. They assert
membership or relative order on controlled fixtures, never exact scores
across backends.

## Access tracking

After ranking, `markMemoriesAccessed` increments `access_count` and sets
`last_accessed_at` and `updated_at` for every returned memory; the returned
records carry the values after the update. Access counts do not affect
ranking. On Postgres this is an `UPDATE … WHERE id IN (…)` on every recall,
limited to the recalled entity like every other id lookup.
If a returned memory is deleted between the search and this update, recall
rejects with `"DB"`.

## `buildContext`

`buildContext` runs the same recall (with its `signal`) and renders the
results:

- `markdown` (default): heading, the query, then each memory as a metadata
  line plus a fenced block whose backtick fence is longer than any run in
  the content.
- `plain`: `MEMORY N START/END` markers wrapped in an `=` fence longer than
  any `=` run in the query, metadata or content.
- `xml`: `<memory_context>` with escaped attributes and content.

`maxTokens` defaults to 1200 and must be a positive integer. The builder
binary-searches the number of memories that fit, adds an "N memories
omitted" line, and guarantees `tokenCounter.count(result) <= maxTokens`; if
nothing fits it returns the longest fitting part of a truncation marker, or
an empty string. The default counter is `ceil(length / 4)`; pass
`tokenCounter` for a real tokenizer.
