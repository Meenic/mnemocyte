# Using Mnemocyte with AI coding tools

Coding agents (Claude Code, Cursor, Copilot and others) read your
`AGENTS.md` or `CLAUDE.md` before they write code. Paste the block below into
yours, and they stop making the usual Mnemocyte mistakes. The sections after
it explain each rule.

## Paste this into your `AGENTS.md` or `CLAUDE.md`

````md
## Mnemocyte (memory)

Mnemocyte (`mnemocyte` on npm) stores AI app memories in our own database.
Docs: https://github.com/Meenic/mnemocyte/tree/main/docs/guide. The `.d.mts`
files in `node_modules/mnemocyte/dist` carry JSDoc with examples.

- Mnemocyte never creates tables. Schema changes are numbered migrations:
  run `mnemocyte migrate` (or `migrate({ memory })`), never hand-written DDL.
- `store` takes a postgres.js `sql`, a node-postgres `Pool` (never a
  `pg.Client`), a PGlite instance or a Drizzle `db`. Leave it out for tests.
- Always work through a scope: `memory.for({ entityId })`, or pass `scope`
  to every call. Never call a method without one.
- One embedding model and one dimension count per installation. Do not
  change the embedder's `model` or `dimensions` on an existing database.
- Unknown option keys throw. Use only keys from the guides and the types;
  do not copy options from other memory or vector libraries.
- Import `createMemory`, `migrate` and error helpers from `mnemocyte`,
  embedders from `mnemocyte/embedders`, `postgresStore` from
  `mnemocyte/postgres` and the AI SDK integration from `mnemocyte/ai-sdk`.
- The client has no `close()`. End the database client yourself.
- `deleteScope({ scope: { namespace, entityId } })` erases the entity across
  every agent and session. Add `agentId` or `sessionId` to erase less.
- Check errors with `isMnemocyteError(error)` and branch on `code` and
  `reason`, not on `instanceof` or the message.
- Do not use anything under `client.experimental`. It can change in a minor
  release.
- `migrate` needs a regular connection with interactive transactions, not
  Neon's HTTP driver.
````

## Why each rule is there

### Mnemocyte does not create tables

`createMemory` only builds a client. With Postgres, the first call on a
database that was never migrated throws `"MIGRATION"` with reason
`"SCHEMA_MISSING"`. The fix is `pnpm exec mnemocyte migrate`, not code that
runs `CREATE TABLE`. See
[Install the schema](./postgres.md#install-the-schema).

### Pass a `Pool`, not a `pg.Client`

A node-postgres `Client` is one connection, and Mnemocyte needs to check out
a connection per transaction. `createMemory` throws `"CONFIG"` for a
`pg.Client`. Pass a `pg.Pool`, or see [connect](./postgres.md#connect) for
the other drivers.

### Use a scope on every call

Every read and write takes a scope, so one user never sees another's
memories. `memory.for({ entityId })` binds one so the calls stay short. A
call without a scope throws `"VALIDATION"`. See [scopes](./api.md#scopes).

### One embedding model per installation

The database records the embedder's model and dimensions on first use. A
different one throws `"CONFIG"` (`"MODEL_MISMATCH"` or
`"DIMENSIONS_MISMATCH"`), so an agent that swaps `text-embedding-3-small`
for another model fails on the next call. See
[one embedding model per installation](./postgres.md#one-embedding-model-per-installation).

### Unknown keys throw

Agents like to bring options from other libraries (`topK` on
`search`, `limit` on `createMemory`). Mnemocyte throws `"CONFIG"` for an unknown key
in the configuration and `"VALIDATION"` for one in a method input, so a typo
never silently does something else. Read the type or the
[API reference](./api.md) for the real name.

### Import from the right entry point

The root `mnemocyte` import has no provider code. Embedders live in
`mnemocyte/embedders`, `postgresStore` in `mnemocyte/postgres` and the AI SDK
tools and middleware in `mnemocyte/ai-sdk`. An import from the root fails to
type-check.

### There is no `close()`

The client holds no connections or timers. Close the database client you
passed in (`sql.end()`, `pool.end()`, `db.close()`) when a script is done. A
server keeps it open. See [getting started](./getting-started.md#4-write-memoryts).

### `deleteScope` erases more than you may expect

Bulk operations select, and an omitted `agentId` or `sessionId` matches any
value. `deleteScope({ scope: { namespace, entityId } })` therefore erases
the user across every agent and session, together with their audit events.
That is right for an erasure request and wrong for "clear this chat": add
`sessionId` for that. See [`delete` and `deleteScope`](./api.md#delete-and-deletescope).

### Use `isMnemocyteError`

`instanceof MnemocyteError` fails when two copies of the package are
installed. `isMnemocyteError(error)` checks a brand instead. Branch on
`error.code` and `error.reason`; messages change. See [errors](./api.md#errors).

### Leave `experimental` alone

Everything under `client.experimental` may change or go in a minor release.
Use it only when you accept that, and pin the version.
[Stability](./api.md#stability) lists what is covered.

### `migrate` and Neon's HTTP driver

`migrate` runs each migration in a transaction, and Neon's HTTP driver has
no interactive transactions. Migrate over a regular connection (Neon's
pooled `Pool` or a direct postgres.js connection). The app can use any
driver after that. See [limitations](./limitations.md).
