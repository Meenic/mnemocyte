# `drizzleStore(db)` — v1 Design Proposal

Status: draft, grounded in
`docs/design/DRIZZLESTORE_READINESS_REPORT.md`. Not yet verified against
source by Codex.

## Scope (deliberate, evidence-backed)

v1 supports **caller-supplied Drizzle instances backed by postgres.js
only**. Not node-postgres, not Neon HTTP/serverless. This matches
`docs/ROADMAP.md`'s own stated hedge ("starting with postgres.js and
expanding only after verification") and is grounded in concrete findings,
not caution for its own sake: the readiness report found `consolidate()`'s
transaction callback throws at runtime on Neon HTTP in the locked Drizzle
release, and that `executeCancelableSql()`, raw-execute result handling,
and error-field reading are all genuinely postgres.js-specific across the
guarded-delete/prune/duplicate-search/audit-list surface. Scoping to
postgres.js only means none of that needs to change for v1 — it's the
single decision that keeps this a small, real, shippable feature instead of
a driver-abstraction project.

Explicitly out of scope for v1: node-postgres, Neon (any transport), MySQL,
Prisma, configurable schema namespacing, and `ensureSchema()` performing
real verification or creation.

## What changes

**1. A new way to construct a `DatabaseHandle`.** Currently
`createDatabase(databaseUrl)` in `src/db/index.ts` is the only path.
Add a second constructor that accepts an already-built
`PostgresJsDatabase<typeof schema>` directly and produces the same
`DatabaseHandle` shape `createPostgresStore(handle)` already consumes
unmodified — the readiness report confirmed store logic doesn't inspect
where its handle came from.

**2. `DatabaseHandle` needs an ownership flag.** `close()` currently
unconditionally calls `client.end()`. Add whatever's needed (a boolean, or
simply omitting the close callback entirely for caller-supplied handles) so
a caller-supplied handle's `close()` is a no-op on the underlying
connection, while a self-constructed handle's `close()` behaves exactly as
today. No other code path currently attempts to close a connection — this
change is isolated to the one existing close site the report found.

**3. Public API surface.** Proposed shape, to be confirmed against actual
`MnemocyteConfig`/`createMnemocyte()` signatures during verification:

```ts
// New subpath export, mirroring mnemocyte/embedders/openai's existing pattern
import { drizzleStore } from "mnemocyte/stores/drizzle";

const client = createMnemocyte({
  store: drizzleStore(db), // db: PostgresJsDatabase<typeof schema>-compatible instance
  embedder: myEmbedder,
});
```

Open question for verification: does `MnemocyteConfig` need a new `store`
field alongside `databaseUrl`, or should `drizzleStore(db)` return something
that fits an existing extension point? Check current config validation
(`ERR-02`/`CONFIG-02`'s synchronous validation timing) to confirm a new
field doesn't disturb it.

**4. Schema stays externally managed, explicitly documented as a v1
constraint.** No change to `ensureSchema()`'s no-op behavior. README and
the new subpath's own documentation state plainly: target database must
already have Mnemocyte's schema applied (migrations run beforehand, same as
today's `databaseUrl` path), must use the `public` schema, and must not
already contain conflicting `mnemocyte_*`-named objects. This is a stated
limitation, not silently unsupported behavior.

**5. Dependency shape.** `mnemocyte/stores/drizzle` declares `drizzle-orm` and
`postgres` as peer dependencies, not direct dependencies — consistent with
the zero-dep root fix's existing approach and drizzle-orm's own pattern of
keeping drivers as peers.

**6. Packaging: ships as a subpath on the existing `mnemocyte` package for
v1**, not a separate monorepo adapter package yet. Extraction into a real
separate package is later, mechanical, follow-up work — keeping it separate
from this feature avoids conflating two changes in one run.

## Testing requirement (the one real gap the report found)

Add an integration test that:
1. Constructs a real postgres.js Drizzle instance directly (the caller's
   own, outside any Mnemocyte factory).
2. Passes it to `drizzleStore(db)` and constructs a Mnemocyte client.
3. Exercises `remember`/`recall` (or another representative operation) to
   confirm the wrapped instance works identically to the `databaseUrl`
   path.
4. Calls `client.close()`.
5. Confirms the original Drizzle/postgres.js instance is still usable
   afterward — proving connection ownership stayed with the caller.

This is the scenario the readiness report explicitly found has zero
existing coverage.

## What's still undetermined, needs verification against source

- Exact current `MnemocyteConfig` shape and whether adding a `store` field
  (or equivalent) is additive or requires restructuring existing validation
  order.
- Whether any other code path beyond the one `close()` site assumes it can
  freely construct/tear down connections — worth a second check beyond the
  readiness report's search, since this design depends on that being
  exhaustive.
- Exact TypeScript type to accept for `db` — `PostgresJsDatabase<typeof
  schema>` requires the caller's instance to be built with Mnemocyte's own
  schema map, which may be too strict (a caller with their own schema
  alongside Mnemocyte's tables might not naturally end up with that exact
  type). Needs checking against how `drizzle(client, { schema })` typing
  actually works before finalizing the public signature.
