# Limitations

Mnemocyte is pre-1.0. These are the current limits, what happens when you hit
them, and the [roadmap](../ROADMAP.md) item planned for each.

## Storage

- **One embedding model per Postgres installation.** A second model or
  dimension throws `"CONFIG"`, and mixed history throws `"MIGRATION"` until
  repaired ([postgres.md](./postgres.md#repair-mixed-models)).
- **At most 2,000 dimensions on Postgres.** pgvector's HNSW index on `vector`
  stops there; a schema rendered above that fails at `CREATE INDEX`. Planned:
  `halfvec` above 2,000 dimensions (`feat/postgres-schema-v2`).
- **postgres.js only.** `postgresJs` is the only `SqlExecutor` adapter, and
  `drizzleStore` accepts only `drizzle-orm/postgres-js` instances. Planned:
  Drizzle, PGlite and node-postgres adapters (`feat/postgres-drivers`).
- **Migrations are applied by hand.** Nothing records which files were applied
  outside the repository's Drizzle journal. Planned: an exported `migrate()`
  (`feat/migrate-runner`).
- **Large batches fail on Postgres.** `rememberMany` sends one `INSERT`; past
  about 3,400 memories it exceeds Postgres's 65,535 bind-parameter limit and
  throws `"DB"`. The whole batch is also embedded in one embedder call. Split
  large batches yourself. Planned: chunked writes (`fix/batch-writes`).

## Retrieval

- **Keyword scores are on different scales on Postgres.** Full-text matches
  and substring matches are scored differently, so a real keyword match can
  rank below a coincidental one, and the two backends can rank the same data
  differently. Planned: reciprocal rank fusion (`fix/hybrid-fusion`).
- **Selective filters can return too few results.** Filters are applied after
  the approximate vector search, so a narrow `types` or `tags` filter can
  return fewer memories than exist. Planned: iterative index scans
  (`fix/filtered-vector-search`).
- **Recall always writes.** Every recall updates the access count and
  `updatedAt` of the returned memories. If one of them is deleted at the same
  moment, the recall throws `"DB"`. Planned: opt-in access tracking
  (`fix/access-tracking`).
- **Queries and documents are embedded the same way.** The embedder is not
  told which one it is embedding, so providers with separate query and
  document modes cannot use them. Planned: `feat/embedder-purpose`.

## Deleting

- **`prune` without `entityId` covers every entity.** `prune({ types: ["fact"]
  })` deletes every fact in the installation. Planned: prune requires a scope
  (`feat/scoped-api`).
- **Consolidation blocks deletes.** After a consolidation, `forget`,
  `forgetAll` and `prune` throw `"CONFLICT"` for the survivor until the
  superseded memories are deleted first (`prune({ entityId, superseded: true
  })`). Planned: survivor-aware deletes (`feat/consolidate-stable`).
- **Duplicate search compares every pair.** `findDuplicates` cost grows with
  the square of an entity's memory count. Planned: nearest-neighbor based
  search (`feat/consolidate-stable`).
- **The audit log grows forever.** Mnemocyte never deletes audit events.
  Planned: a retention option (`feat/audit-retention`).

## Providers

- **Timeouts need the embedder's help.** A timeout aborts the attempt's
  signal; the request stops only if your embedder forwards that signal.
- **Retries have no jitter and ignore `Retry-After`.** The built-in retry
  rule also retries any error whose message contains "500". Planned:
  `feat/embedder-purpose`.
- **The observability hook is awaited.** A slow `onEvent` slows every
  operation. Planned: `fix/observability-non-blocking`.
