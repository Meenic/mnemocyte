# Mnemocyte Architecture

> This is the canonical architecture document for Mnemocyte. It describes the
> current package, the infrastructure boundaries it relies on, and the planned
> path toward adapter-based TypeScript infrastructure.

## Current Status

Mnemocyte exposes its client API through `createMnemocyte()`. The client uses
an explicitly supplied `store`, a URL-owned Postgres/pgvector backend when
`databaseUrl` is provided, or an in-memory backend when neither is supplied.
Supplying both storage fields rejects synchronously with `"CONFIG"`.

The package is ESM-only for now. CommonJS is intentionally not advertised unless the build later emits and tests a real CJS artifact.

The current package is intentionally explicit: callers supply the embedder, the
Postgres schema is applied through migrations, and the client does not hide
infrastructure setup behind constructor side effects.

The package version and latest repository tag are `0.4.0`; tag `v0.4.0`
points to `a11ecf1`. The verification snapshot at `54864ba` is three commits
ahead of that tag while retaining package version `0.4.0`. Local Git state does
not establish npm or GitHub-release publication status.

Current source includes the `0.4.0` hardening work, installation-level
`embedding_model` metadata, and post-tag lazy Postgres loading. The default
1536-dimensional install is represented by `0000_initial.sql`,
`0001_add_mnemocyte_meta.sql`, and `0002_add_embedding_model.sql`; custom fresh
installs are rendered from `0000_initial.sql.template`.

## Goals

- **Maintainability:** each module has one responsibility and clear boundaries.
- **TypeScript-first DX:** public types are exported from `mnemocyte` and APIs are easy to evolve before v1.
- **Composable infrastructure:** callers should be able to bring their own
  embedder, database client, connection lifecycle, and runtime-specific
  adapters.
- **Minimal core:** Postgres with pgvector is the first persistence and vector
  search backend, not a mandate to adopt a separate vector database or agent
  framework.
- **Realistic agent memory:** prioritize reliable recall, provenance, lifecycle, and debuggability over speculative intelligence.
- **Package correctness:** npm metadata, exports, build output, and docs must match what is actually shipped.

## Non-Goals

- No separate vector database requirement in the core package.
- No stable CommonJS export until CJS output is produced and tested.
- No hidden schema creation from the client constructor.
- No unimplemented methods in the stable public API.
- No full autonomous memory consolidation in the core package.
- No provider lock-in. Official embedder factories are convenience adapters,
  not the only supported path.
- No broad backend expansion before a public `MemoryStore` adapter contract
  exists.

## Package Strategy

Mnemocyte remains ESM-only until there is a strong reason to dual-publish. The
package ships:

- `dist/` - built root and subpath `.mjs` / `.d.mts` files and source maps
  produced by `tsdown`.
- `migrations/0000_initial.sql` - the default 1536-dimensional Postgres schema
  baseline for fresh installs.
- `migrations/0001_add_mnemocyte_meta.sql` - the metadata migration that records
  the default embedding dimensions for existing 0.1.x installs and default
  fresh installs.
- `migrations/0002_add_embedding_model.sql` - adds installation-level embedding
  model identity and records a single historical row model when unambiguous.
- `migrations/0000_initial.sql.template` and `migrations/render-initial.mjs` -
  the explicit custom-dimension fresh-install path, including the installation
  model metadata column.

The full, canonical `package.json` lives at the repository root. See it for the current `scripts`, `exports`, `engines.node`, and dependency pins (Drizzle ORM, `postgres`, `@biomejs/biome`, `tsdown`, Vitest, etc.). CI runs `test:ci` to enforce unit behavior, package exports, and exported type reachability from `mnemocyte`.

Future adapter packages should depend on the core rather than widening the core
surface. The internal `MemoryStore` boundary remains private. The
`mnemocyte/stores/drizzle` subpath now exposes `drizzleStore(db)` through the
narrow opaque `MnemocyteStoreConfig` value required by
`MnemocyteConfig.store`, without publishing the full internal contract.
`@mnemocyte/mcp` remains the next adapter milestone.

The root artifact validates a supplied database URL synchronously, then creates
a lazy Postgres store. Drizzle, postgres.js, schema, query, and Postgres adapter
modules are dynamically imported only when that store is first used. The
database packages remain runtime dependencies for the Postgres path, but a
packed in-memory consumer is tested with both packages absent. Importing
`mnemocyte/stores/drizzle` is the explicit opt-in that loads the postgres.js
adapter; the `./stores/*` export is kept outside the root entry's static import
graph and lets future store source entries ship without another export-map or
build-script edit.

If CommonJS support is added later, the package must emit `dist/index.cjs` and CI must validate both `import("mnemocyte")` and `require("mnemocyte")`.

## Runtime Dependencies

Use `postgres` for the database driver. In this document, `postgres` means the postgres.js npm package, not PostgreSQL itself.

```json
{
  "dependencies": {
    "drizzle-orm": "^0.45.2",
    "postgres": "^3.4.9"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.15",
    "@types/node": "^22.18.0",
    "drizzle-kit": "^0.31.10",
    "tsdown": "^0.22.0",
    "typescript": "^6.0.3",
    "vitest": "4.1.6"
  }
}
```

## TypeScript Strategy

The package should keep strict type checking and explicit ESM behavior.

Current strict options worth keeping:

- `strict`
- `noUncheckedIndexedAccess`
- `exactOptionalPropertyTypes`
- `verbatimModuleSyntax`
- `isolatedModules`
- `declaration`
- `declarationMap`

The package uses `nodenext`, declares Node `>=22.18`, and tests Node 22.18 and
Node 24 in CI.

## Module Structure

```text
src/
+-- index.ts                  # public API re-exports only
+-- client.ts                 # createMnemocyte() factory + backend selection
+-- database-url.ts           # synchronous Postgres URL validation
+-- types.ts                  # public types
+-- errors.ts                 # MnemocyteError + isMnemocyteError
+-- observability.ts          # observe() helper for start/success/error events
+-- resilience.ts             # withResilience helper (timeout/retry/caller abort)
+-- db/
|   +-- index.ts              # postgres.js + drizzle setup (createDatabase)
|   +-- cancellation.ts       # AbortSignal-aware postgres.js query execution
|   +-- schema.ts             # drizzle table definitions (memories, events, meta)
|   +-- vector.ts             # precise pgvector component serialization
|   +-- queries/
|       +-- memories.ts       # memory CRUD, recall, prune, dedup, consolidate SQL
|       +-- events.ts         # audit-event CRUD
|       +-- meta.ts           # installation metadata reads and model recording
+-- embedders/
|   +-- index.ts              # provider helper exports
|   +-- openai.ts             # fetch-based OpenAI embeddings helper
+-- stores/
|   +-- drizzle.ts            # postgres.js Drizzle adapter subpath
+-- retrieval/
|   +-- scorer.ts             # cosineSimilarity, lexical score, fused ranker
+-- memory/
|   +-- client-core.ts        # shared MnemocyteClient orchestration
|   +-- store.ts              # internal MemoryStore boundary
|   +-- defaults.ts           # shared internal defaults and importance ordering
|   +-- embeddings.ts         # resilient single and batch embedding calls
|   +-- deletion.ts           # typed consolidation-dependent deletion conflict
|   +-- filters.ts            # in-memory recall, prune, and duplicate filters
|   +-- json.ts               # JSON metadata validation and deep cloning
|   +-- records.ts            # stored/public memory mapping, cloning, and ids
|   +-- postgres-records.ts   # Postgres row-to-public-memory mapping
|   +-- validation.ts         # client configuration and operation validation
|   +-- in-memory.ts          # in-memory MemoryStore adapter
|   +-- lazy-postgres.ts      # MemoryStore proxy + dynamic Postgres import
|   +-- postgres-runtime.ts   # URL-to-Postgres-store runtime assembly
|   +-- postgres.ts           # Postgres MemoryStore adapter
|   +-- store-config.ts       # opaque public config token wrapping MemoryStore
+-- context/
    +-- builder.ts            # buildContext()
    +-- formatter.ts          # markdown/plain/xml context formatting
    +-- tokens.ts             # token counting abstraction
```

Embedder providers are deliberately represented by a small `Embedder`
interface. Callers pass an implementation explicitly. Official factories such
as `openaiEmbedder()` should remove boilerplate while preserving the same
contract. Additional provider integrations should stay in subpaths or adapter
packages rather than becoming hidden behavior in `createMnemocyte()`. The root
`mnemocyte` entrypoint must not import provider SDKs. `openaiEmbedder()` uses
`fetch` directly for the embeddings endpoint so no OpenAI SDK dependency is
required.

Layering rule: lower-level modules must not import higher-level modules. For example, `db/` must not import from `memory/`, and `retrieval/` must not import from `context/`.

## Current Architecture Assessment

The strongest parts of the current architecture should stay: the root package is
provider-free, schema setup is explicit, the public API is compact, typed errors
exist, package exports are tested, and Postgres/pgvector is treated as
infrastructure rather than hidden magic.

The `0.3.0` release moved backend behavior behind an internal
`MemoryStore` boundary. Validation, embedding, resilience wrapping, recall
scoring, audit behavior, result mapping, context building, and lifecycle checks
now run through `memory/client-core.ts`, while `memory/in-memory.ts` and
`memory/postgres.ts` own storage-specific mechanics. Focused leaf modules under
`memory/` own defaults, embedding calls, filters, record mapping, and validation
without importing the client orchestrator or backend adapters.

`createMnemocyte()` synchronously validates embedder identity/dimensions,
retrieval tuning, provider timeout/retry/delay values, and the configured
database URL before backend work. Database URLs must use the `postgres:` or
`postgresql:` protocol; finer host and credential validation belongs to
postgres.js. Provider delays remain compatible with the existing policy that
normalizes `maxDelayMs` up to `baseDelayMs` when needed.

Remaining boundaries:

- Postgres query modules own both SQL shape and some public result-shaping
  concerns.
- The full internal `MemoryStore` interface is not exported. The first public
  adapter deliberately exposes only an opaque config value while transaction
  hooks and non-postgres.js Drizzle drivers remain under review.

### Internal `MemoryStore` stabilization status

`src/memory/store.ts` currently has one required `backend` property and exactly
18 methods. All methods are mandatory; no capability object or degraded method
path exists. This table accounts for each method exactly once and records the
current ownership that a future public contract must preserve or resolve.

| Method | Current guarantee and stabilization disposition |
| --- | --- |
| `ensureSchema` | Mandatory readiness hook; both built-ins are currently no-ops. It does not authorize hidden schema creation. |
| `ensureEmbeddingCompatibility` | Mandatory backend-relevant compatibility hook. In-memory resolves; Postgres enforces persistent installation model and dimensions. Document the intentional difference without a capability flag. |
| `insertMemories` | The store returns exactly one detached public memory per prepared ID and takes ownership of prepared rows. Shared orchestration—not the store—validates missing, duplicate, or unknown returned IDs and restores input order. |
| `vectorSearch` | Mandatory correctness contract with finite `[0, 1]` components and shared filter semantics. Postgres has an HNSW-capable pgvector path; in-memory scans. Index use is planner-dependent and approximate, and no public capability flag is currently justified. |
| `lexicalSearch` | Mandatory candidate/scoring contract. Postgres uses English full-text parsing/ranking and has no bundled full-text expression index; in-memory uses JavaScript scoring. Candidate/rank differences must be documented. |
| `getMemoryEmbeddings` | Mandatory ID-keyed embedding lookup used to rescore lexical-only recall candidates. Shared orchestration consumes by ID, not return order. |
| `markMemoriesAccessed` | Mandatory post-update records normalized by ID in shared orchestration. Shared recall supplies distinct IDs; that precondition must be explicit before public export because direct duplicate-ID behavior differs by adapter. |
| `deleteMemory` | Mandatory entity-scoped delete with atomic `"CONFLICT"` rejection when the target has dependents. |
| `deleteMemoriesForEntity` | Mandatory whole-entity delete with atomic all-or-nothing dependent protection. |
| `prune` | Mandatory normalized-selector, dry-run, count, per-entity-detail, and atomic dependent-protection contract. In-memory checks cancellation cooperatively; Postgres actively cancels the count/delete statement. |
| `findDuplicatePairs` | Mandatory correctness-only pairwise search. Neither adapter uses HNSW nearest-neighbor pair generation; ordinary relational indexes may still assist the Postgres self-join. No capability flag is planned. |
| `addAuditEvents` | Mandatory detached-value persistence called through best-effort shared audit orchestration. Successful writes match; Postgres may persist a prefix if a later event fails, unlike the in-memory batch. |
| `listAuditLog` | Mandatory strict `(timestamp, event ID)` cursor/filter/order contract. In-memory cancellation is cooperative; Postgres uses active statement cancellation. No transaction is required for tuple positioning. |
| `getMemory` | Mandatory detached entity-and-ID lookup. In-memory checks before its synchronous lookup; Postgres checks before and after its statement. |
| `loadConsolidationTargets` | Mandatory consolidation preflight lookup. Shared validation guarantees distinct requested loser IDs before either adapter is called. |
| `consolidate` | Mandatory atomic survivor re-read/protection, loser update, enabled audit write, and mutation-time tag merge. A missing or superseded survivor and a loser assigned to a different survivor reject with `"CONFLICT"` before mutation. |
| `stats` | Mandatory entity/global counts using a shared `now`; active excludes expired and superseded, while the expired and superseded counts may overlap. |
| `close` | Mandatory store-lifecycle hook. Current in-memory close clears ephemeral state and Postgres closes its owned handle. A future caller-supplied Drizzle handle remains caller-owned; the public contract must limit `close()` to resources owned by that store construction path. |

Design files under `docs/design/` are historical investigation records, not
implementation contracts. Current behavior is governed by source, tests,
migrations, package configuration, README, changelog, and this document;
future direction by `ROADMAP.md`; and approval-sensitive decisions by root
`PROPOSALS.md`. The latest stabilization v3 verification rejects its subject as
a final implementation basis. No public capability surface is approved.

## Public API Direction

Use object parameters rather than positional APIs. This keeps the API evolvable before v1 without adding breaking positional arguments.

```ts
import { createMnemocyte } from "mnemocyte";

const client = createMnemocyte({
  databaseUrl: process.env.DATABASE_URL!,
  embedder: {
    model: "text-embedding-3-small",
    dimensions: 1536,
    async embed(texts) {
      return embedWithProvider(texts);
    },
  },
});

await client.remember({
  entityId: "user_123",
  content: "Prefers short, direct answers.",
  type: "preference",
  source: "chat",
  confidence: 0.9,
});

const memories = await client.recall({
  entityId: "user_123",
  query: "How should I respond?",
  limit: 5,
  types: ["preference", "instruction"],
});

await client.close();
```

## Current Public Surface

The source of truth is `dist/index.d.mts` plus any exported subpath declaration
files such as `dist/embedders/index.d.mts` and
`dist/embedders/openai.d.mts`; this section is a fast index.

**Factory**

- `createMnemocyte(config: MnemocyteConfig): MnemocyteClient` — stable.

**Embedder helpers**

- `mnemocyte/embedders`: `openaiEmbedder(options)` and
  `OpenAIEmbedderOptions` for editor-discoverable provider helpers.
- `mnemocyte/embedders/openai`: the stable direct OpenAI helper subpath. This
  helper uses direct `fetch` calls, does not add an OpenAI SDK dependency, and
  rejects response data unless it contains exactly one uniquely indexed array
  embedding per input. Shared embedding validation still owns dimensions and
  finite numeric components.

**Storage adapters**

- `mnemocyte/stores/drizzle`: `drizzleStore(db)` accepts a caller-owned
  postgres.js Drizzle instance and returns `MnemocyteStoreConfig`. Its v1 scope
  is the `public` schema with pre-applied Mnemocyte migrations; it does not
  close the caller's connection. The wildcard `mnemocyte/stores/*` package
  boundary mirrors provider helper subpaths and scales to later store entries.

**Errors**

- `MnemocyteError`, `isMnemocyteError`, `MnemocyteErrorCode` (`"CONFIG"`, `"VALIDATION"`, `"DB"`, `"EMBEDDING"`, `"NOT_FOUND"`, `"CONFLICT"`, `"MIGRATION"`, `"TIMEOUT"`, `"ABORTED"`).

**Client (stable)**

- `remember(input)` / `rememberMany({ inputs, signal })`; the positional batch
  form remains a deprecated pre-v1 compatibility overload.
- `recall(input)` — hybrid vector + lexical, with `RetrievalExplanation` when `explain: true`.
- `buildContext(input)` — markdown / plain / xml with token-budget trimming.
- `forget({ entityId, memoryId })`, `forgetAll({ entityId })` — reject with
  `"CONFLICT"` before deleting when the selected set contains a referenced
  consolidation survivor.
- `prune(input: PruneInput)` — bulk-delete by `entityId` / `expired` / `superseded` / `createdBefore` / `notAccessedSince` / `types` / `tags` / `maxImportance` with `dryRun`; a non-dry-run batch rejects atomically with `"CONFLICT"` if any match is a referenced survivor. Store results include internal per-entity deletion counts so shared orchestration can emit one best-effort `"memory.pruned"` audit event per affected entity, including global prunes.
- `findDuplicates(input)` — read-only pairwise scan returning `DuplicatePair[]`.
- `listAuditLog(input)` — entity-scoped and ordered newest-first by
  `(timestamp, event ID)`. Experimental `beforeCursor` / `afterCursor`
  composite positions provide stable tie-safe pagination; `before` / `after`
  remain strict timestamp filters.
- `stats(input?)` — `EntityStats` or `GlobalStats`.
- `close()` — idempotent; repeated close calls share the result, while client
  operations admitted after closing starts throw `"DB"`.

**Client (experimental, gated under `client.experimental.*`)**

- `experimental.consolidate(input)` — mark one or more memories as superseded
  by a survivor, with optional tag merge. Same-survivor retries are idempotent;
  a loser already assigned to a different survivor rejects the entire call
  with `"CONFLICT"`. Successful mutations are audited as
  `"memory.superseded"`, and the survivor remains protected from deletion
  until its dependents are removed.

**Config**

- `MnemocyteConfig`: mutually exclusive `databaseUrl?` and `store?`,
  `embedder` (required; its model and dimensions must match `mnemocyte_meta`
  for Postgres), `defaults?`, `retrieval?`, `observability?`, `provider?`
  (resilience), `audit?` (`{ enabled }`). When neither storage field is
  supplied, the in-memory backend is selected.

**Types**

- `Memory` (canonical record, includes `supersededBy` and `supersededAt`), `MemoryWithScore`, `RetrievalScores`, `RetrievalExplanation`, `EntityStats`, `GlobalStats`.
- JSON metadata: recursive `JsonObject` and `JsonValue`; persisted metadata is
  validated and deep-cloned at storage ingress and public-result egress.
- Input types: `RememberInput`, `RememberManyInput`, `RecallInput`,
  `BuildContextInput`, `PruneInput`, `FindDuplicatesInput`,
  `ListAuditLogInput`, `ConsolidateInput`.
- Result types: `PruneResult`, `ConsolidateResult`.
- Observability: `MnemocyteObservation`, `MnemocyteOperation`, `MnemocyteObservationPhase`, `MnemocyteBackend`, `ObservabilityConfig`.
- Resilience: `ProviderResilienceConfig`.
- Audit: `AuditConfig`, `AuditEvent`, experimental `AuditLogCursor`.
- Storage configuration: opaque `MnemocyteStoreConfig`; the internal
  `MemoryStore` method contract remains unexported.

**Escape hatches**

- None. Internal database handles, schema definitions, and query builders are
  not re-exported. If an unstable hatch is ever needed, expose it under
  `client.experimental.*`, never as a top-level export.

## Error Model

Use typed errors so consumers can recover from expected failures.

```ts
export class MnemocyteError extends Error {
  constructor(
    message: string,
    readonly code:
      | "CONFIG"
      | "VALIDATION"
      | "DB"
      | "EMBEDDING"
      | "NOT_FOUND"
      | "CONFLICT"
      | "MIGRATION"
      | "TIMEOUT"
      | "ABORTED",
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "MnemocyteError";
  }
}
```

`"TIMEOUT"` and `"ABORTED"` are emitted by the resilience layer; `"CONFIG"`
covers invalid embedder/database URL configuration, including non-Postgres URL
protocols, simultaneous `databaseUrl` and `store` values, invalid retrieval
tuning, and Postgres model/dimension mismatches.
`"MIGRATION"` also covers unresolved mixed historical embedding models after
`0002_add_embedding_model.sql`.
`"VALIDATION"` covers per-call argument errors (including invalid `maxTokens`,
JSON-incompatible or cyclic metadata, malformed or selector-free prune input,
and empty or duplicate consolidation loser IDs) plus an explicitly empty
`databaseUrl`. `"CONFLICT"` covers mutations rejected because stored
relationships must remain valid: deleting a referenced consolidation survivor
or attempting to reassign a loser to a different survivor, and a consolidation
whose survivor disappeared or became superseded after shared preflight.

Prune validation produces a normalized internal filter before the
`MemoryStore` boundary. Both adapters accept that internal filter rather than
the public `PruneInput`, and independently reject an empty filter so a
validation regression cannot reach an unbounded delete.

### Consolidation Survivor Deletion Policy

`supersededBy` is a live referential relationship, not historical metadata that
may dangle. A delete candidate set is rejected with `"CONFLICT"` if any stored
memory references a candidate as its consolidation survivor:

- `forget` rejects before deleting the referenced survivor.
- `forgetAll` rejects even when both the survivor and dependent are selected.
- A non-dry-run `prune` rejects the entire batch, so unrelated matching rows
  are not partially deleted. A dry run may still report those matches.
- Deleting a superseded loser or any memory with no dependents remains valid.

The in-memory adapter checks the complete candidate set before mutation.
Postgres uses one guarded candidate/dependent/delete statement for atomic batch
behavior, while the existing `ON DELETE NO ACTION` self-reference remains a
race-condition backstop. Violations of that specific foreign key are normalized
to the same `"CONFLICT"` code rather than a generic `"DB"` error. Callers remove
dependents before deleting their survivor.

### Consolidation Target Policy

Consolidation idempotency is survivor-specific. A loser that already points to
the requested survivor is an idempotent no-op. A loser that points to any other
survivor rejects with `"CONFLICT"`, because returning a zero-count success
would not satisfy the requested postcondition. Repeated IDs in
`supersededIds` reject with `"VALIDATION"` during shared validation, before
either adapter performs its preflight lookup.

The rule is atomic across a complete call. Both adapters re-read the survivor
and every requested loser inside the mutation boundary before changing any
active loser, merging survivor tags, or writing `"memory.superseded"` audit
events. A survivor missing or superseded at that point rejects with
`"CONFLICT"`. Postgres locks the survivor and requested losers in deterministic
ID order inside the consolidation transaction; in-memory performs the checks
and mutation in one non-interleaved synchronous block. Tag merging starts from
the protected survivor's mutation-time tags, so concurrent successful merges
cannot overwrite tags committed by an earlier consolidation.

Maintenance-operation signals are checked before store access. In-memory
pruning, duplicate scans, audit-log scans, and consolidation preparation check
cooperatively during their synchronous work. Postgres prune, duplicate-search,
and audit-log statements use the underlying postgres.js query cancellation
hook. Postgres consolidation instead checks between transactional statements
and immediately before the transaction callback returns: a statement already
in flight may finish before the next check triggers rollback. An abort after
the final check, including while commit is in flight, may still leave the
transaction committed.

Known pre-v1 gap: `MnemocyteError` is the intended recovery boundary, but not
every database/driver failure is wrapped consistently yet. Before v1, expected
infrastructure failures should be normalized to `"DB"` or `"MIGRATION"` while
preserving the original cause.

## Database Architecture

Postgres is the source of truth. pgvector is used for vector similarity search. Migrations are first-class and must be explicit; the main client constructor must not silently create extensions or tables.

### Schema Baseline

The `CREATE EXTENSION` statement below is an explicit deployment prerequisite;
the bundled migration assumes pgvector is already enabled and starts with table
creation.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE mnemocyte_memories (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  content text NOT NULL,
  type text NOT NULL DEFAULT 'fact',
  importance text NOT NULL DEFAULT 'normal',
  tags text[] NOT NULL DEFAULT '{}',
  source text,
  metadata jsonb NOT NULL DEFAULT '{}',
  confidence real NOT NULL DEFAULT 1.0,
  embedding vector(1536),
  embedding_model text NOT NULL,
  embedding_dimensions integer NOT NULL,
  superseded_by text REFERENCES mnemocyte_memories(id),
  superseded_at timestamptz,
  expires_at timestamptz,
  last_accessed_at timestamptz,
  access_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mnemocyte_events (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  timestamp timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mnemocyte_meta (
  key text PRIMARY KEY,
  embedding_dimensions integer NOT NULL,
  embedding_model text
);

INSERT INTO mnemocyte_meta (key, embedding_dimensions)
VALUES ('installation', 1536);
```

### Index Baseline

```sql
CREATE INDEX mnemocyte_memories_entity_idx ON mnemocyte_memories (entity_id);
CREATE INDEX mnemocyte_memories_entity_type_idx ON mnemocyte_memories (entity_id, type);
CREATE INDEX mnemocyte_events_entity_time_idx ON mnemocyte_events (entity_id, timestamp);
CREATE INDEX mnemocyte_memories_embedding_hnsw_idx ON mnemocyte_memories USING hnsw (embedding vector_cosine_ops);
```

HNSW is the current bundled vector-search index. pgvector HNSW is approximate,
so production users should benchmark recall quality for their own corpus and
queries instead of treating top-K results as exact. HNSW also has operational
costs: index builds can use significant memory, and each write must update the
graph, increasing insert/update overhead compared with no vector index.
Postgres applies ordinary filters around vector search, so highly selective
`entity_id`, `type`, tag, time, or lifecycle filters may require query/session
tuning or a workload-specific migration.

IVFFlat is also valid for some large, steady-state tables, but it needs
representative data before index creation and workload-specific tuning. Do not
replace the bundled HNSW index blindly; benchmark HNSW, IVFFlat, and custom
filtered/partial indexes against real data volume, write rate, filters, and
latency targets.

The current migration does not include a full-text GIN expression index for
`to_tsvector('english', content)`. Lexical search is implemented with
PostgreSQL full-text search, but production deployments should add and benchmark
a matching expression index before relying on large lexical scans. Tag filters
currently use the `text[]` column without a bundled GIN index; add a tag index
only after measuring tag-heavy queries in the target workload.

### Embedding Vector Space Policy

The current package supports one embedding model and dimension per
installation. `mnemocyte_meta` is the installation-level source of truth, and
the Postgres client validates both values before embedding-dependent operations
call the embedder or compare stored vectors. Empty installations atomically
claim the configured model. If the metadata model is unset after an upgrade, a
single historical row model is inferred and recorded; multiple historical
models fail with `"MIGRATION"` until an operator repairs the data. Continue
storing `embedding_model` and `embedding_dimensions` on every memory for
diagnosis and future re-embedding workflows.

Compatibility validation runs only before writes, recall, and duplicate scans.
Non-embedding recovery operations such as cleanup, audit reads, or diagnostics
remain available when the configured embedder is incompatible with the
installation.

## Write Path

Current write flow:

1. Snapshot caller-owned tags, metadata, and expiration dates at call ingress.
2. Validate strings, JSON metadata, enum domains, tags, confidence, and dates.
3. Check Postgres embedding compatibility and embed content.
4. Verify embedding count, dimensions, finite components, and nonzero norm.
5. Insert the complete memory row through the selected adapter.
6. Return a public record with independently cloned metadata.

The observation start timestamp is captured before synchronous write
preparation. Preparation completes before an awaited user hook can mutate
caller-owned values; if preparation itself fails, the hook still receives one
`"start"` event followed by one `"error"` event carrying the same thrown value.
Closed-client admission remains earlier than preparation, matching other
operations' lifecycle precedence.

The ingress metadata clone carries an internal validated/owned type through
record construction. `MemoryStore.insertMemories()` takes ownership of those
fresh rows and returns one detached public record for each prepared ID. Shared
orchestration treats return order as untrusted, validates that no ID is missing,
duplicated, or unknown, and restores prepared-input order before public egress.
It does not repeat the metadata traversal. Audit events retain one
adapter-ingress clone and one detached public-egress clone. Retrieval scoring
and duplicate-pair mapping keep their separate clones until those
multi-candidate ownership paths are audited independently.

Do not hold a database transaction open while calling an external embedding API. If asynchronous embedding is needed later, model it explicitly with an `embedding_status` field and retry/repair tooling.

## Retrieval Architecture

Retrieval uses a shared canonical filter object so vector and lexical paths cannot diverge.

```ts
export interface MemoryFilter {
  entityId: string;
  types?: readonly MemoryType[];
  tags?: readonly string[];
  before?: Date;
  after?: Date;
  includeSuperseded?: boolean;
  includeExpired?: boolean;
}
```

### Vector Search

Use cosine distance with pgvector. Recall queries should project only the
fields needed to build `Memory` plus the score; stored embeddings are used for
distance calculation but are not returned in the main candidate result set.
The `MemoryStore` vector candidate contract exposes a finite component in
`[0, 1]`: negative cosine and non-finite database values clamp to `0`, and any
store-level vector cutoff applies to that component. Public `RecallInput`
`minScore` is applied only to the final fused score in shared orchestration.

```sql
SELECT id, entity_id, content, type, importance, tags, source, metadata,
       confidence, embedding_model, embedding_dimensions, superseded_by,
       superseded_at, expires_at, last_accessed_at, access_count,
       created_at, updated_at,
       1 - (embedding <=> $1::vector) AS vector_score
FROM mnemocyte_memories
WHERE entity_id = $2 AND embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $3;
```

### Lexical Search

Use PostgreSQL full-text search for lexical retrieval. Do not call this BM25;
PostgreSQL `ts_rank` is useful, but it is not BM25. Lexical candidate rows
also avoid returning embeddings; lexical-only candidates fetch embeddings
through a narrow `id, embedding` lookup when cosine rescoring needs them.

```sql
SELECT id, entity_id, content, type, importance, tags, source, metadata,
  confidence, embedding_model, embedding_dimensions, superseded_by,
  superseded_at, expires_at, last_accessed_at, access_count,
  created_at, updated_at,
  ts_rank(to_tsvector('english', content), websearch_to_tsquery('english', $1)) AS lexical_score
FROM mnemocyte_memories
WHERE entity_id = $2
  AND to_tsvector('english', content) @@ websearch_to_tsquery('english', $1)
ORDER BY lexical_score DESC
LIMIT $3;
```

### Score Fusion

Fusion combines vector, lexical, recency, importance, confidence, and access-count signals. Weights are configurable through `MnemocyteConfig.retrieval`, and detailed explanations are only returned when requested.

Recall ranks candidates using their pre-access counts. After selection, the
store access-update operation returns one post-update count and timestamp set
per selected ID; shared orchestration validates that returned ID set and patches
the public results. A recall therefore exposes the access state it committed
without allowing that same update to change its ranking or explanation.

## Context Builder

The context builder assembles model-ready memory context. It must treat memory content as untrusted input.

Requirements:

- Escape XML output.
- Choose a Markdown fence that cannot collide with included memory content.
- Choose a deterministic plain-text fence that cannot occur in the query,
  rendered metadata, or included memory content.
- Support a default heuristic token counter.
- Allow callers to provide a model-specific token counter.
- Reject a supplied `maxTokens` unless it is a positive integer; omission keeps
  the default budget path.
- Trim deterministically by priority and token budget, with
  `count(result) <= maxTokens` as a hard postcondition. If the complete
  truncation marker does not fit, return its longest fitting fragment or an
  empty string.

```ts
export interface TokenCounter {
  count(text: string): number;
}
```

## Connection Lifecycle

The client owns the postgres.js connection when it creates it from
`databaseUrl`, so it must expose `close()`. The current `createDatabase()` path
accepts only the `postgres:` and `postgresql:` protocols, uses postgres.js over
TCP, parses common `sslmode` values, and disables prepared statements for
pooler-style URLs (`:6543` or `pgbouncer=true`).

`drizzleStore(db)` instead installs a required no-op `DatabaseHandle.close()`
callback. Closing the Mnemocyte client still drains its operations and closes
the logical store, but it does not call `client.end()` or otherwise tear down
the supplied Drizzle/postgres.js connection. The application remains
responsible for that connection's lifecycle.

The v1 caller-owned path accepts only `drizzle-orm/postgres-js` instances. It
queries the fixed Mnemocyte tables in the `public` schema directly, so the
caller's Drizzle schema map need not merge those tables, but the bundled
migrations must already have been applied. Other drivers and schemas require
separate verification and are not silently accepted.

## Production Concerns

Before v1, finish or explicitly defer:

- a public `MemoryStore` adapter contract once the internal boundary is stable
- continued tightening of expected database, migration, and provider failure
  wrapping
- remaining runtime input validation outside the remember and memory-type
  filter boundaries where JavaScript consumers cannot rely on TypeScript
- representative benchmark or `EXPLAIN` evidence before adding more default
  full-text, tag, or filtered-vector indexes
- provenance verification on the next manual publish or a trusted-publishing
  workflow

## Implementation Roadmap

The historical MVP phases are complete enough to treat the current package as
the baseline. Future work is ordered around hardening first, then adapter-ready
storage boundaries.

### `0.1.x` - Maintenance

The planned hardening slice is complete for the `0.1.4` release. Future
`0.1.x` work should be limited to critical fixes or documentation corrections.

### `0.2.0` - Configurable Embedding Dimensions

Status: released as `v0.2.0`.

- Add `mnemocyte_meta` with installation metadata such as
  `embedding_dimensions`.
- Parameterize the Postgres vector dimension through an explicit migration
  template and renderer instead of assuming `vector(1536)`.
- Validate the configured embedder against stored metadata before Postgres
  embedding operations call the embedder.
- Keep one vector dimension per installation.

### `0.3.0` - `MemoryStore` / v1 Stabilization

- Status: released as `v0.3.0`.
- Extracted storage primitives into an internal `MemoryStore` interface.
- Moved shared orchestration into one core path.
- Reduced in-memory and Postgres backends to adapters.
- Fixed the known pre-v1 gaps around public result mapping, timeout
  cancellation, database error wrapping, and dimension-validation scope.
- Added JSON-only metadata value semantics with deep cloning and typed
  validation failures.
- Rejected invalid retrieval tuning and supplied invalid `maxTokens` values at
  their public boundaries.
- Added `rememberMany({ inputs, signal })` while retaining the deprecated
  positional compatibility overload.
- Defer any third backend until the public adapter contract exists.

### `0.4.0` - Hardening and Behavior Corrections

- Status: package version and repository tag are `0.4.0`; current `HEAD`
  contains post-tag work. Registry/GitHub publication must be confirmed
  separately.
- Release details live in `CHANGELOG.md`; this release does not include the
  planned public Drizzle adapter.

### `0.5.0` - `drizzleStore(db)`

- Status: implemented under `[Unreleased]` for caller-owned postgres.js
  Drizzle instances.
- The adapter keeps connection lifecycle ownership with the application and
  requires the public-schema migrations to be applied explicitly.
- Expanding beyond postgres.js remains future work that requires driver/runtime
  verification.

### `0.6.0` - `@mnemocyte/mcp`

- Ship MCP as a separate adapter package built on the same core primitives.
- Configure database and embedder explicitly.
- Expose memory tools only after the core storage and embedder contracts are
  stable enough to avoid a parallel implementation.

## Known limitations

- **Postgres supports one embedding vector space per installation.** The
  default migration creates `embedding vector(1536)`, and custom dimensions
  must be rendered explicitly from the migration template. `createMnemocyte`
  stays synchronous; before writes, recall, or duplicate scans, the Postgres
  client validates the configured model and dimensions against
  `mnemocyte_meta`.
- **`MemoryStore` is internal.** The in-memory and Postgres backends now use a
  shared internal adapter boundary, but it is not a public adapter API yet.
  `drizzleStore(db)` exposes only an opaque `MnemocyteStoreConfig` token for the
  supported postgres.js caller-owned path.
- **Provider timeout cancellation depends on signal support.** The resilience
  layer aborts the per-attempt signal on `"TIMEOUT"`; embedder implementations
  must honor `AbortSignal` for the underlying request to stop promptly.
- **Database cancellation has an explicit commit boundary.** Standalone
  maintenance queries request postgres.js cancellation. Consolidation checks
  cancellation between transaction steps and before its transaction callback
  returns. An in-flight statement can finish before rollback; an abort after
  the final check, including during commit, may still leave the mutation
  committed.
- **Database error wrapping is broader but still conservative.** Expected
  missing schema and storage failures are normalized, while unusual driver
  failures may still surface through their original cause.
- **`rememberMany({ inputs, signal })` owns cancellation at the batch level.**
  The former positional form remains a deprecated pre-v1 compatibility
  overload; its first item signal is treated as the batch signal.
- **`findDuplicates` on the in-memory backend is O(n²).** The in-memory
  backend is intended for development and prototyping, and duplicate detection
  degrades noticeably beyond roughly a few thousand memories per entity. Use
  the Postgres backend beyond that scale; it performs the comparison in one
  pgvector self-join.
- **Hybrid recall on Postgres computes approximate lexical scores for vector-only candidates.** When a row appears only in the vector top-K, a JS-side substring-match lexical score is used instead of PostgreSQL's `ts_rank`. Similarly, lexical-only candidates get a JS-side cosine similarity from the stored embedding, fetched through a narrow follow-up lookup. These approximations are close but not identical to database-side scores. `candidateMultiplier` widens the candidate set to further reduce edge cases.
- **`forgetAll` does not cascade-delete the audit log** (intentional — the
  audit trail is sticky). Mnemocyte has no event-pruning API; use explicit
  database maintenance against `mnemocyte_events` if you need to compact it.
- **Consolidation survivor deletion is rejected, not cascaded or detached.**
  `forget`, `forgetAll`, and non-dry-run `prune` throw `"CONFLICT"` without
  deleting anything when a selected memory still has `supersededBy`
  dependents.
- **`experimental.consolidate` is gated under `client.experimental.*`.** Members of that namespace may change between minor releases.

## Issue Checklist

- [x] Fix exports whenever build outputs change.
- [x] Keep package ESM-only until CJS is emitted and tested.
- [x] Implement object-parameter public API.
- [x] Add explicit migrations and document setup.
- [x] Store embedding model and dimensions.
- [x] Add client `close()`.
- [x] Apply one canonical retrieval filter to all retrieval paths.
- [x] Use `lexical` / `fts` terminology instead of BM25 for `ts_rank`.
- [x] Add typed errors.
- [x] Keep `client.ts` as a thin backend wiring layer.
- [x] Add package export smoke tests.
- [x] Add Postgres + pgvector integration tests.
- [x] Add safe context formatting and token counting.
- [x] Keep consolidation under `client.experimental.*` until it graduates.
- [x] Strip internal embedding vectors from all public in-memory results.
- [x] Split schema availability checks from embedding-dimension checks.
- [x] Actively abort provider requests on timeout where supported.
- [x] Wrap expected database and migration failures in `MnemocyteError`.
- [x] Decide the v1 shape for `rememberMany`.
- [x] Extract `MemoryStore` or equivalent shared orchestration before v1.
