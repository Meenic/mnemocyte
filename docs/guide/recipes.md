# Recipes

Short, copyable answers to common tasks. Each one assumes the `memory.ts`
from [getting started](./getting-started.md#4-write-memoryts), which exports
a `memory` client.

## A chat route with memory

`withMemory` wraps your model so every call starts with the user's relevant
memories. Bind the client to the signed-in user for each request:

```ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { withMemory } from "mnemocyte/ai-sdk";
import { memory } from "./memory.ts";

export async function POST(request: Request) {
  const session = await getSession(request); // your auth
  const { messages } = await request.json();

  const result = streamText({
    model: withMemory({
      model: openai("gpt-6.1-sol"),
      memory: memory.for({ entityId: session.userId }),
      onError: ({ phase, error }) => console.warn({ phase, error }),
    }),
    instructions: "You are a helpful assistant.",
    messages,
  });

  return result.toTextStreamResponse();
}
```

The memories are added to what the model receives and not to `messages`.
To let the model also save and forget, add `memoryTools`; to store facts
from each turn, add `save: { model }`. See [the AI SDK guide](./ai-sdk.md).

## Save a preference that changes

Give the memory a `key`. Adding the same key again updates the memory in
place:

```ts
const user = memory.for({ entityId: session.userId });

await user.add({
  key: "reply-style",
  kind: "preference",
  content: "Prefers short, direct answers.",
});

// Later: same memory, new content.
await user.add({
  key: "reply-style",
  kind: "preference",
  content: "Prefers detailed answers with examples.",
});
```

An `add` without a key always inserts a new memory. See
[keys](./api.md#add-and-addmany).

## Erase a user

```ts
const { deletedCount } = await memory
  .for({ entityId: session.userId })
  .deleteScope();
```

This deletes the user's memories across every agent and session, and their
audit events. To clear only one chat, add `sessionId` to the scope. The
erasure records no audit event; log it yourself if you need a record. See
[`delete` and `deleteScope`](./api.md#delete-and-deletescope).

## Nightly maintenance

Mnemocyte holds no timers, so run cleanup from your own scheduler (cron, a
queue, a platform's scheduled functions):

```ts
import { memory } from "./memory.ts";

const day = 24 * 3600 * 1000;

// 1. Delete expired and replaced memories in every namespace.
await memory.prune({ allNamespaces: true, expired: true });
await memory.prune({
  allNamespaces: true,
  superseded: true,
  createdBefore: new Date(Date.now() - 30 * day),
});

// 2. Merge near-duplicates, one user at a time.
for (const entityId of await listUserIds()) { // your own user list
  const scope = { entityId };
  const replaced = new Set<string>();
  for (const { a, b } of await memory.findDuplicates({ scope, threshold: 0.95 })) {
    if (replaced.has(a.id) || replaced.has(b.id)) continue;
    const [survivor, duplicate] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
    await memory.consolidate({
      scope,
      survivorId: survivor.id,
      supersededIds: [duplicate.id],
    });
    replaced.add(duplicate.id);
  }
}

// 3. Keep 90 days of audit history.
await memory.pruneAuditLog({
  allNamespaces: true,
  before: new Date(Date.now() - 90 * day),
});
```

- `prune` needs a selector, so it never deletes a whole scope by accident.
  Add `dryRun: true` to see the counts first.
- `consolidate` marks the duplicate as replaced and keeps it, left out of
  search. The `superseded` prune above deletes it after 30 days.
- `findDuplicates` is approximate on large scopes and slow on very large
  ones; see [limitations](./limitations.md#maintenance).
- Pass `scope: { namespace }` instead of `allNamespaces: true` to keep
  different windows per tenant.

The details are in [`prune`](./api.md#prune),
[`findDuplicates`](./api.md#findduplicates),
[`consolidate`](./api.md#consolidate) and
[retention](./api.md#retention). Audit events exist only with
`audit: { enabled: true }`.

## Tests on the in-memory store

Leave out `store` and give the client a fake embedder, so a test needs
neither a database nor a network:

```ts
import { createMemory } from "mnemocyte";
import type { Embedder } from "mnemocyte";

// A word-hash embedder: texts that share words get similar vectors.
const fakeEmbedder: Embedder = {
  model: "fake",
  dimensions: 64,
  async embed(texts) {
    return texts.map((text) => {
      const vector = new Array<number>(64).fill(0);
      vector[0] = 1; // never an all-zero vector
      for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
        let hash = 0;
        for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 63;
        vector[hash + 1] += 1;
      }
      return vector;
    });
  },
};

export function createTestMemory() {
  return createMemory({ namespace: "test", embedder: fakeEmbedder });
}
```

Make one per test so tests share nothing:

```ts
import { expect, test } from "vitest";

test("finds a saved memory", async () => {
  const user = createTestMemory().for({ entityId: "user_1" });
  await user.add({ content: "Lives in Berlin." });

  const results = await user.search({ query: "berlin" });
  expect(results[0]?.content).toBe("Lives in Berlin.");
});
```

The in-memory store matches keywords differently from Postgres, so use a
real database for tests that depend on ranking. The
[embedder interface](./embedders.md#the-embedder-interface) lists what
`embed` must return.

## A local setup with Ollama

Run PGlite for the database and Ollama for embeddings, and nothing leaves
your machine:

```bash
ollama pull nomic-embed-text
pnpm add mnemocyte @electric-sql/pglite @electric-sql/pglite-pgvector
```

```ts
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { createMemory } from "mnemocyte";
import { openaiCompatibleEmbedder } from "mnemocyte/embedders";

export const db = await PGlite.create({
  dataDir: "./memory-data",
  extensions: { vector },
});

export const memory = createMemory({
  namespace: "my-agent",
  store: db,
  embedder: openaiCompatibleEmbedder({
    baseURL: "http://localhost:11434/v1",
    model: "nomic-embed-text",
    dimensions: 768,
    purposes: {
      query: { prefix: "search_query: " },
      document: { prefix: "search_document: " },
    },
  }),
});
```

Create the schema once with the app stopped (a PGlite data folder opens in
one process at a time):

```bash
pnpm exec mnemocyte migrate
```

For a local chat or extraction model, see
[local models](./ai-sdk.md#local-models). The steps in full are in
[getting started](./getting-started.md#use-ollama-instead-of-openai).
