# Upgrading

How to move an app from Mnemocyte 0.5 to 1.0. Each section lists what a
release changed that existing code or data notices; read the ones between
your version and 1.0, in order. The full list of changes is in the
[changelog](../../CHANGELOG.md).

After upgrading the package, run `npx mnemocyte migrate` (or
`migrate({ memory })`) in every deploy. Only 0.6 changes the schema; later
releases add no migration. See
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
[upgrading to 0.6](./postgres.md#upgrading-to-06-0003_schema_v2sql) shows.
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
  selection still makes it throw.
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
- **`experimental.consolidate` is deprecated**; call `consolidate`.
- **The `mnemocyte` command.** `npx mnemocyte migrate` replaces a
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

- **Removed:** `postgresJs()` and `PostgresJsExecutor` (pass the client),
  `drizzleStore()` and `mnemocyte/stores/drizzle` (pass `store: db`; a
  `PostgresJsDatabase`-annotated instance passes `db.$client`), and
  `experimental.consolidate` (call `consolidate`).
- **Package files.** `migrations/render-initial.mjs`, the schema template
  and `migrations/meta/_journal.json` are no longer shipped; run
  `npx mnemocyte sql --dimensions <n>` for the fresh-install schema. The
  numbered SQL files and `fresh-install.sql` still ship.

1.0.0-rc.1 is a release candidate: install it with `mnemocyte@next`. It
changes only if testing finds a problem.

From 1.0, breaking changes wait for a major release; see
[stability](./api.md#stability) for what the promise covers.
