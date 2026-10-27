# Retrieval and context

## Recall pipeline

`recall({ entityId, query, … })` in `memory/client-core.ts`:

1. Validate input; resolve `limit` (default 10) and `minScore` (default 0)
   from the input, then `config.defaults`.
2. Check embedding compatibility (Postgres) and embed the query.
3. Run two candidate searches in parallel, each with
   `limit × candidateMultiplier` (default 3) and the same filters (`types`,
   `tags` must all match, `before`/`after` on `created_at`, superseded and
   expired rows excluded unless asked for):
   - **vector**: cosine similarity, clamped to `[0, 1]`. Postgres orders by
     `embedding <=> $query` (HNSW when the planner chooses it); in-memory scans
     every row.
   - **lexical**: Postgres uses `content_tsv @@
     websearch_to_tsquery('english', $query)` ranked by `ts_rank`, where
     `content_tsv` is a stored `to_tsvector('english', content)` column with
     a GIN index; in-memory
     uses the fraction of whitespace-split query terms found as substrings.
4. Merge by id. Lexical-only candidates get their vector score from a second
   query that loads their embeddings.
5. Score, filter by `minScore`, sort, keep `limit`.
6. Increment access state for the returned ids (see below) and return them.

## Scoring

The final score is a weighted sum of six components, each in `[0, 1]`:

| Component | Value | Default weight |
|---|---|---|
| vector | clamped cosine similarity | 0.55 |
| lexical | see the note below | 0.20 |
| recency | `exp(-ln2 × ageDays / recencyHalfLifeDays)`, half-life 90 days | 0.10 |
| confidence | stored `confidence` | 0.05 |
| access | `log1p(accessCount) / log1p(accessSaturation)`, saturation 10 | 0.05 |
| importance | low 0, normal 0.5, high 0.8, critical 1 | 0.05 |

Weights are normalized to sum to 1 and validated at construction (finite,
non-negative, non-zero total). `explain: true` attaches the components and
weights to each result.

Lexical note: on Postgres, candidates found by the lexical search keep their
`ts_rank` (often around 0.06), while vector-only candidates get the substring
score (0 to 1). The two scales mix, so a true full-text match can rank below a
substring coincidence, and the backends rank the same data differently. The
roadmap replaces this with reciprocal rank fusion.

## Access tracking

After ranking, `markMemoriesAccessed` increments `access_count` and sets
`last_accessed_at` and `updated_at` for every returned memory. Ranking uses
the counts from before the update; the returned records carry the values
after it. On Postgres this is an `UPDATE … WHERE id IN (…)` on every recall,
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
