# Upgrading

How to move an app from Mnemocyte 0.5 to the current release. Each section
lists what a release changed that existing code or data notices; read the
ones between your version and the current one, in order. The full list of changes is in the
[changelog](../../CHANGELOG.md).

After upgrading the package, run `pnpm exec mnemocyte migrate` (or
`migrate({ memory })`) in every deploy. 0.6 and 1.1 change the schema;
the other releases add no migration. See
[upgrade an existing installation](./postgres.md#upgrade-an-existing-installation)
for applying the SQL files with `psql` instead.

## 0.5 → 0.6

0.6 replaces the entity-only client with the scoped one, makes Postgres
drivers optional peers and rewrites the schema.

**Data.** Memories written by 0.5 are in namespace `"default"` with no agent
or session, so pass `namespace: "default"` to keep reading them. Migration
`0003_schema_v2.sql` rewrites both tables under an `ACCESS EXCLUSIVE` lock
and turns ids into UUIDs (`md5(id)::uuid` for ids that were not UUIDs); plan
a maintenance window and convert ids your app stores, as
[the schema migration](#schema-migration-0003_schema_v2sql) below shows.
Search needs pgvector 0.8.0 or later.

**Connection.** `databaseUrl` is gone; create the database client yourself,
pass it in and end it on shutdown. Install the driver (`postgres`, `pg`,
`@electric-sql/pglite`), which is no longer a dependency. Mnemocyte no
longer sets a pool size or overrides `sslmode`.

```ts
// 0.5
const client = createMnemocyte({ databaseUrl: process.env.DATABASE_URL!, embedder });

// 1.0
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const memory = createMemory({ namespace: "default", store: sql, embedder });
```

**Methods.**

| 0.5 | 1.0 |
|---|---|
| `createMnemocyte(config)` | `createMemory(config)` |
| `MnemocyteClient`, `MnemocyteConfig` | `MemoryClient`, `MemoryConfig` |
| `remember({ entityId, … })` | `add({ scope, … })` |
| `rememberMany({ inputs })` / `rememberMany(inputs)` | `addMany({ scope, memories })`, one scope per call |
| `recall({ entityId, … })` | `search({ scope, … })` |
| `buildContext({ entityId, … })` | `context({ scope, … })`; the query is no longer echoed |
| `forget({ entityId, memoryId })` | `delete({ scope, id })` |
| `forgetAll({ entityId })` | `deleteScope({ scope })`; also deletes the scope's audit events |
| `prune({ entityId?, … })` | `prune({ scope, … })` or `prune({ allNamespaces: true, … })`, plus a selector besides the scope |
| `findDuplicates`, `listAuditLog`, `experimental.consolidate` with `entityId` | `findDuplicates`, `listAuditLog`, `consolidate` with `scope` |
| `stats({ entityId })` / `stats()` | `stats({ scope })` / `stats({ allNamespaces: true })`, one `MemoryStats` type |
| `type`, `types`, `MemoryType` | `kind`, `kinds`, `MemoryKind` |
| `memory.entityId`, `event.entityId` | `memory.scope.entityId`, `event.scope.entityId` |
| `close()` | removed; end your own database client |
| `"entity.cleared"` audit event | none; `deleteScope` deletes the audit events |
| observability operations `remember`, `recall`, `buildContext`, `forget`, `forgetAll`, `close` | `add`, `search`, `context`, `delete`, `deleteScope`; no `close` |

With a default namespace, `memory.for({ entityId })` returns a client bound
to one scope whose methods take no `scope`; see
[bound scopes](./api.md#bound-scopes).

**Behavior.**

- **Ranking.** Search fuses the vector and keyword rankings by reciprocal
  rank fusion. `score` stays between 0 and 1, but a memory found by only one
  search scores at most 0.5, so revisit any `minScore`. `retrieval.weights`
  became `retrieval.fusion`, and `confidence` and `accessCount` no longer
  affect ranking (see [retrieval tuning](./api.md#retrieval-tuning)).
- **Access tracking is off by default.** Pass
  `retrieval: { trackAccess: true }` to keep counting. `prune` with
  `notAccessedSince` counts never-accessed memories from `createdAt`.
- **Input caps.** Oversized content, tags, metadata, keys, scopes, `limit`
  and `addMany` batches throw `"VALIDATION"` ([input limits](./api.md#input-limits)).
- **`context` output.** The Markdown and plain formats lose their query
  line and the XML its `query` attribute.

### Schema migration (`0003_schema_v2.sql`)

- **Ids become UUIDs.** `id` and `superseded_by` change from `text` to
  `uuid`, and so do audit event ids. New ids are UUIDv7: time-ordered, so
  new rows land at the end of the primary-key index instead of on a random
  page. An existing id that is already a UUID keeps its value; any other
  id, such as `mem_lx2…`, becomes `md5(id)::uuid`. The `memoryId` and
  `supersededBy` values in audit event metadata are converted the same
  way. If your application stores memory ids, convert them with the same
  rule:

  ```sql
  SELECT md5('mem_lx2abc_k3j9d0q1')::uuid;
  ```

  ```ts
  import { createHash } from "node:crypto";

  const hex = createHash("md5").update(oldId).digest("hex");
  const newId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  ```

- **The tables are rewritten.** Changing the id type and adding the stored
  full-text column rewrite `mnemocyte_memories` and `mnemocyte_events` and
  rebuild every index on them, including HNSW. The migration holds an
  `ACCESS EXCLUSIVE` lock on each table while it runs, which blocks reads
  and writes. Plan a maintenance window for large tables.
- **Scope columns.** Memories and audit events gain `namespace`,
  `agent_id` and `session_id`; existing rows get the namespace `default`
  and no agent or session. Memories also gain `key` (unique per scope when
  set), and `type` is renamed to `kind`.
- **Full text is precomputed.** `content_tsv` is a stored generated column
  (`to_tsvector('english', content)`) with a GIN index, so keyword search
  no longer parses every row on each query.

To apply it with `psql` instead of `migrate`, see
[upgrade an existing installation](./postgres.md#upgrade-an-existing-installation).

## 0.6 → 0.7

- **Custom embedders.** `embed(texts, options)` takes a required
  `{ purpose, signal? }`. A parameter default such as `options = {}` no
  longer type-checks, and code that calls `embed` directly must pass
  `{ purpose: "query" }` or `{ purpose: "document" }`.
- **Retries are on.** `provider.retries` defaults to 2, with jittered
  backoff and `Retry-After`. Retries follow the HTTP status, not the
  message text; a custom embedder should throw an error with `status`, or a
  `ProviderError`. Set `retries: 0` for the old behavior.
- **`openaiEmbedder` errors.** A failed request throws `ProviderError`.
- **`context` returns `""`** when no memory matches, instead of an empty
  header.
- **Clients as `store`.** `createMemory({ store: sql })` takes the database
  client directly; `postgresStore` still works.

## 0.7 → 0.8

- **`prune` deletes a survivor with its dependents.** A prune that selects
  a consolidation survivor and every memory consolidated into it deletes
  them all; before, it threw `"CONFLICT"`. A dependent left outside the
  selection still makes it throw. Preview with `dryRun: true` before a
  prune that can match survivors.
- **`findDuplicates` is approximate on large scopes.** Each memory is
  compared with its `neighbors` nearest instead of every memory, and on
  Postgres the neighbors come from the HNSW index, which can miss a pair.
  Pairs have the smaller id as `a`. Run it again after consolidating, or
  page through a large scope with `experimental.findDuplicatesPage`.
- **Observability hooks are not awaited.** A slow or failing `onEvent` no
  longer delays or fails a call; hook errors go to `observability.onError`,
  dropped when it is unset. Code that relied on the hook finishing before
  the call returned must wait for its own work.
- **Audit writes fail the call.** With audit enabled, a failed audit write
  rejects the call and the change is not kept.
- **`forgetMemory`** deletes with `dependents: "delete"`.
- **`consolidate` leaves `experimental`.** `experimental.consolidate` is
  deprecated; call `consolidate`.
- **The `mnemocyte` command.** `pnpm exec mnemocyte migrate` replaces a
  hand-written migrate script; see the [CLI guide](./cli.md).

## 0.8 → 1.0

- **Unknown option keys throw `"CONFIG"`** in `createMemory`'s config and
  its nested objects, `postgresStore`, every embedder and the AI SDK
  functions. A misspelled key used to be ignored.
- **`baseUrl` is `baseURL`** on every fetch-based embedder, and the
  extraction `timeout` is `timeoutMs`. The old names throw an error naming
  the new one.

  ```ts
  // 0.8
  openaiEmbedder({ model, baseUrl: "https://proxy.example/v1" });
  // 1.0
  openaiEmbedder({ model, baseURL: "https://proxy.example/v1" });
  ```

- **`search` filters `createdAt` with `createdBefore` / `createdAfter`**,
  the name `prune` already uses. `before` and `after` throw
  `"VALIDATION"` naming the new key. `listAuditLog` and `pruneAuditLog`
  keep `before` / `after`.

  ```ts
  // 0.8
  await memory.search({ scope, query, after: lastWeek });
  // 1.0
  await memory.search({ scope, query, createdAfter: lastWeek });
  ```

- **Unknown keys on method inputs throw `"VALIDATION"`**, in the input of
  every client method (bound clients included) and `migrate`, in its
  `scope`, and in each `addMany` memory. A misspelled key used to be
  ignored, so `deleteScope({ scope: { namespace, entityId, sessionID } })`
  erased the entity in every session and `migrate({ memory, dryrun: true })`
  applied the migrations. An input object reused across methods now has to
  carry only the keys each one takes:

  ```ts
  // 0.8: maxTokens was ignored by search
  const input = { scope, query, maxTokens: 800 };
  await memory.search(input);
  // 1.0
  const { maxTokens, ...searchInput } = input;
  await memory.search(searchInput);
  ```

- **`listAuditLog` pages like `list`.** It returns `{ events, nextCursor }`
  and takes `cursor`; `beforeCursor`, `afterCursor` and `AuditLogCursor` are
  gone. `entityId` is optional, and `allNamespaces: true` lists every
  namespace.

  ```ts
  // 0.8
  const events = await memory.listAuditLog({ scope, beforeCursor });
  // 1.0
  const { events, nextCursor } = await memory.listAuditLog({ scope, cursor });
  ```

- **`AuditEvent.type` replaces `description`.** No migration is needed.
- **Errors carry a `reason`.** Branch on `code` and `reason` instead of
  messages ([errors](./api.md#errors)). `new MnemocyteError` takes one
  object, and `"CONFIG"`, `"CONFLICT"` and `"MIGRATION"` require a reason:

  ```ts
  // 0.8
  throw new MnemocyteError("model is required", "CONFIG");
  // 1.0
  throw new MnemocyteError({ message: "model is required", code: "CONFIG", reason: "INVALID_OPTION" });
  ```

- **`consolidate` into a superseded survivor throws `"CONFLICT"`** with
  reason `"CONSOLIDATION_CHANGED"`, as it already did when a concurrent call
  superseded it, instead of `"VALIDATION"`.
- **A `null` or missing input throws `"VALIDATION"`** on every method,
  instead of a `TypeError` from `add`, `search`, `list` and the others.
- **`extractMemories` aborted during the model call throws `"ABORTED"`**
  (the AI SDK's error is its `cause`), as it does during the search and the
  write.
- **Removed:** `postgresJs()` and `PostgresJsExecutor` (pass the client),
  `drizzleStore()` and `mnemocyte/stores/drizzle` (pass `store: db`; a
  `PostgresJsDatabase`-annotated instance passes `db.$client`), and
  `experimental.consolidate` (call `consolidate`).
- **Package files.** `migrations/render-initial.mjs`, the schema template
  and `migrations/meta/_journal.json` are no longer shipped; run
  `pnpm exec mnemocyte sql --dimensions <n>` for the fresh-install schema. The
  numbered SQL files and `fresh-install.sql` still ship.

Breaking changes now wait for a major release; see
[stability](./api.md#stability) for what the promise covers.

## 1.0 → 1.1

Your code keeps working. TypeScript may flag one thing, and the database
has one migration.

- **`delete` returns a `DeleteResult`.** It used to resolve with nothing.
  Code that awaits it is fine, but TypeScript flags a `Promise<void>`
  annotation on the call or on a function that returns it, and a
  hand-written `MemoryClient` fake whose `delete` returns nothing. Return a
  `DeleteResult` there, or `await` the call inside an `async` function.
- **Migration `0004_audit_memory_id.sql`.** It adds a `memory_id` column to
  `mnemocyte_events`, filled by Postgres from each event's
  `metadata.memoryId`, and an index on it. Adding the column rewrites the
  table under an `ACCESS EXCLUSIVE` lock, so audit reads and audited writes
  wait until it finishes: on 1,000,000 events (150 MB) it took 9.6 s on a
  laptop, 8.5 s for the rewrite and 1.1 s for the index. Memory reads, and writes
  with the audit log off, do not wait; `deleteScope` does, since it also
  deletes the scope's events.
- **Deploy in either order.** 1.1 writes events exactly as 1.0 did, and
  Postgres fills the new column, so 1.1 keeps working before the migration
  and 1.0 keeps working after it. Only the new `memoryId` filter needs the
  migration; before it, that call throws `"MIGRATION"`.
- **`listAuditLog({ memoryId })`** lists one memory's history; see
  [one memory's history](./api.md#one-memorys-history).

## 1.1 → 1.2

Nothing in your code or database has to change.

- **No migration.** 1.1 and 1.2 clients share an installation, so deploy in
  either order, as long as the installation keeps the defaults: `english`
  keyword search and the tables on `search_path`.
- **New options, all opt-in.** `migrate` takes `textSearchConfig`,
  `postgresStore` takes `schemaName`, and `mnemocyte generate --adapter
  drizzle` writes the tables as a Drizzle schema. Without them nothing
  behaves differently. See the [Postgres guide](./postgres.md).
- **Update every process before you use them.** Pick a keyword search
  language other than `english` (on a fresh install or with
  `mnemocyte text-search`) or a `schemaName` only once every app process,
  worker and script runs 1.2. A 1.1 client searches with `english`
  whatever the installation uses, so on a `simple` installation a search
  for "running" loses its keyword match without an error. It also ignores
  `schemaName` and looks for the tables on `search_path`.

## 1.2 → 1.3

Nothing in your database has to change, and code changes only for a
`switch` over `backend` with no `default`.

- **No migration.** 1.2 and 1.3 clients share a Postgres installation, so
  deploy in either order.
- **New entries, all opt-in.** `mnemocyte/libsql` stores memories in
  libSQL or Turso (see the [libSQL guide](./libsql.md)), and
  `mnemocyte/store` and `mnemocyte/store/test` let a package add and test
  its own backend (see [custom stores](./custom-stores.md)).
- **`backend` has two new values.** `MnemocyteBackend`, the `backend` of
  `onEvent` events and of the CLI's `--json` output, adds `"libsql"` and
  `"custom"`, so a `switch` over it needs a `default`, as its doc comment
  says.
- **Install one copy of `mnemocyte`.** A store made by another installed
  copy, older than 1.3, now makes `createMemory` throw `"CONFIG"` at once
  instead of failing on its first call. `npm ls mnemocyte` lists the
  copies.
