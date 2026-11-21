# Custom stores

Mnemocyte ships backends for Postgres and libSQL. To keep memories
somewhere else, write a store: an object that implements `MemoryStoreV1`
from `mnemocyte/store`. Then run the contract suite from
`mnemocyte/store/test` against it, the same tests the built-in backends
pass.

This page is for people writing a backend. To use one, pass it as `store`
the way you would pass `postgresStore()`.

## The shape of a store

A store keeps memories and audit events and answers queries. The core does
the rest: it validates every input, embeds outside any store call, scores
and fuses search results and builds context. It checks the results it can
match against its input, such as the rows `insert` returns, and trusts the
store with the rest: a store that returns a memory from another scope
leaks it.

Wrap your store with `defineMemoryStore` and pass the result as `store`:

```ts
import { createMemory } from "mnemocyte";
import { defineMemoryStore, type MemoryStoreV1 } from "mnemocyte/store";

const kvStore: MemoryStoreV1 = {
  specificationVersion: "v1",
  name: "acme-kv",
  capabilities: {
    vectorSearch: "exact",
    filteredVectorSearch: "prefilter",
    lexicalSearch: "overlap",
    locking: "database",
    maxDimensions: 4096,
  },
  async insert(input) { /* … */ },
  async searchCandidates(input) { /* … */ },
  // get, list, update, markAccessed, delete, consolidate,
  // findDuplicates, listAudit, pruneAudit, stats
};

const memory = createMemory({
  store: defineMemoryStore({ store: kvStore }),
  embedder,
});
```

A backend package usually exports a factory that returns
`defineMemoryStore({ store })`, so its users write
`createMemory({ store: acmeStore({ client }) })`.

`defineMemoryStore` checks the version, the name, every capability value
and that each required method is a function. A wrong store fails with
`"CONFIG"` when the app starts, not on the first query. Mnemocyte reports
the backend as `"custom"` in observability events and in the CLI.

## Methods

Twelve methods are required. Each takes one input object, and every
method that touches memories gets a scope in it: a `visibility` for reads
and writes by id, a `selector` for bulk operations. Optional input fields
are left out, never set to `undefined`.

| Method | What it does |
|---|---|
| `insert` | new rows, and keyed upserts that keep the existing memory's id; all or nothing |
| `searchCandidates` | the vector list and the keyword list of a search, with one filter |
| `get` | memories by ids, or one by key in an exact scope |
| `list` | a page, newest first by `(createdAt, id)` |
| `update` | one patch, in one atomic write |
| `markAccessed` | bump `accessCount` and `lastAccessedAt`, never `updatedAt` |
| `delete` | one memory (with its consolidation dependents), a scope, or a `prune` filter |
| `consolidate` | the atomic write that marks memories superseded by a survivor |
| `findDuplicates` | similar pairs, the top ones or one page of a full run |
| `listAudit`, `pruneAudit` | audit event pages and retention |
| `stats` | counts for a selector |

The doc comment on each method in `MemoryStoreV1` is the specification:
order, atomicity, which conflicts throw and with which reason. Your editor
shows it on hover.

Two methods are optional:

- `migrate` applies your schema through `migrate()` and `mnemocyte
  migrate`. Without it, `migrate()` reports nothing applied and the CLI
  says the store manages its own schema.
- `ensureEmbeddingCompatibility` rejects an embedder that does not match
  what the store holds (another model, other dimensions). The core calls it
  before each write and search that embeds, and before duplicate searches,
  which compare stored vectors. Without it every embedder is accepted, so
  a store that keeps data across restarts should have it.

## Errors

Throw `MnemocyteError` from `mnemocyte`:

- `"CONFLICT"` with the reason the method names: `"KEY_IN_USE"`,
  `"HAS_DEPENDENTS"`, `"HIDDEN_DEPENDENTS"` or `"CONSOLIDATION_CHANGED"`.
- `"ABORTED"` when the input's `signal` stops a call.
- `"DB"` for anything else, with the driver's error as `cause`.

## Audit events

When an input asks for audit (`audit: true`, `audit: { fields }`,
`auditEnabled`), write the events in the same atomic write as the change
they record. If the event write fails, the change must not happen. The
events' types and metadata must match what the built-in backends write;
the contract suite compares them field by field.

## Capabilities

`capabilities` tells the core and the suite how your search behaves:

- `vectorSearch`: `"exact"` compares the query with every row in scope,
  `"approximate"` uses an index.
- `filteredVectorSearch`: `"prefilter"` filters before the vector search,
  `"iterative"` keeps scanning until the limit is met, `"postfilter"`
  filters after an index scan and may return fewer results.
- `lexicalSearch`: how keyword candidates are scored (`"bm25"`,
  `"ts_rank"`, `"overlap"`), or `"none"` for no keyword search; the core
  then asks for no keyword list.
- `locking`: whether concurrent writes wait on rows (`"row"`) or on the
  whole database (`"database"`).
- `maxDimensions`: the largest embedding you can store, or
  `Number.POSITIVE_INFINITY`. `migrate()` rejects anything larger.

## Test your store

The contract suite runs on [Vitest](https://vitest.dev) 5. Install it as a
dev dependency; it is an optional peer of `mnemocyte`.

```bash
pnpm add -D vitest
```

Point the suite at your store in a test file:

```ts
import { defineMemoryStore } from "mnemocyte/store";
import {
  describeMemoryStoreContract,
  STORE_CONTRACT_DIMENSIONS,
} from "mnemocyte/store/test";
import { beforeAll } from "vitest";

const store = defineMemoryStore({ store: acmeStore({ client }) });

beforeAll(async () => {
  await createTestTables({ dimensions: STORE_CONTRACT_DIMENSIONS });
});

describeMemoryStoreContract({
  name: "acme-kv",
  store: () => store,
});
```

Run it:

```bash
pnpm vitest run
```

What the suite checks, through the public client: values round-trip with
their JavaScript types, keyed adds, list paging, updates, scope visibility
and isolation between entities, agents and namespaces, search with and
without filters, context, deletes with consolidation dependents,
duplicates, consolidation, audit payloads, audit pages and retention, and
stats.

Things to know:

- It writes 1,536-dimension embeddings (`STORE_CONTRACT_DIMENSIONS`) with
  the model name `STORE_CONTRACT_EMBEDDING_MODEL`, and does not migrate
  your store. Have the tables ready first, in a `beforeAll`. One test calls
  `migrate()` on the ready store and expects nothing applied.
- Every test writes in its own namespaces starting with `contract_`, and
  nothing is deleted afterwards. A few audit checks read every namespace
  and keep only their own events. Run it on a database you keep for tests.
- `store` is called inside the tests, after your `beforeAll` hooks, once
  for every client the suite builds. It may return the same value each
  time.
- One test checks that a failed audit write rolls back the write it
  records. Give `failAuditWrites` to run it: it makes one namespace's
  audit writes fail (`failing: true`) or work again (`failing: false`), with
  a trigger or a fault switch in your store. Without it, that test is
  skipped.
- Expectations that differ by backend read your `capabilities`. A selective
  filter must still fill the vector list, unless you declare
  `filteredVectorSearch: "postfilter"`. Search results are checked by which
  memories come back, not by their order.
- A minor release of Mnemocyte may add tests to the suite. A store that
  passed may then fail, which points at behavior the built-in backends
  already have.

## What a custom store does not get

- `mnemocyte check` reports no installation for it, and
  `setTextSearchConfig()` changes nothing (`previous` and `current` are
  `null`). Those describe the Postgres and libSQL schemas.
- No helpers for building audit events, visibility filters or duplicate
  pairs in JavaScript yet; the first-party versions are internal.
- The suite runs on Vitest only.

## Versions

The contract carries its version in its name and in `specificationVersion`.
A later `MemoryStoreV2` would sit next to V1, and Mnemocyte would keep
accepting V1 stores for a while instead of breaking them in one release. A
store whose `specificationVersion` this copy of Mnemocyte does not know
fails with `"CONFIG"`, telling the user to update `mnemocyte`.

Take `mnemocyte` as a peer dependency (`"mnemocyte": "^1.3.0"`) in your
backend package, so your store and the app share one copy.
