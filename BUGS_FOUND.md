# Bugs Found

Behavioral defects discovered during the codebase audit that were not changed
because their fixes require a public-contract decision.

## BUG-01: `rememberMany` observes only the first input signal

**Status:** Deferred pending a batch-cancellation contract.

`RememberInput.signal` is documented for every item, but `rememberMany(inputs)`
makes one embedder call and passes only `inputs[0]?.signal`. Aborting any later
input does not cancel that call; aborting the first input cancels the whole
batch.

### Reproduction

```ts
const first = new AbortController();
const second = new AbortController();

const pending = client.rememberMany([
  { entityId: "u1", content: "first", signal: first.signal },
  { entityId: "u1", content: "second", signal: second.signal },
]);

second.abort();
await pending; // Continues unless the embedder completes or another signal aborts.
```

An embedder that waits for its supplied signal makes the mismatch deterministic:
it receives `first.signal`, never `second.signal`.

### Impact

Callers can believe an individual batch item was cancelled when the item is
still embedded and persisted. Combining signals automatically would instead
make one item cancel every item, which is also a user-visible semantic choice.

## BUG-02: Runtime tuning accepts invalid numeric ranges

**Status:** Deferred pending validation and fallback policy.

Public tuning fields are typed as `number` but are not validated at runtime.
Representative outcomes include:

- `buildContext({ maxTokens: 0 })` returns untrimmed content because a budget
  below one is treated as “do not trim.”
- A `NaN` retrieval weight survives weight normalization and can produce
  `NaN` component/final scores.
- Non-positive recency half-life or access saturation values cause zero,
  negative, or non-finite score math.
- Fractional or non-finite `candidateMultiplier` values produce fractional or
  `NaN` store limits; the in-memory and Postgres paths need not fail alike.

### Reproduction

```ts
const client = createMnemocyte({
  embedder,
  retrieval: {
    weights: { vector: Number.NaN },
    recencyHalfLifeDays: 0,
    accessSaturation: -1,
    candidateMultiplier: 1.5,
  },
});

await client.buildContext({
  entityId: "u1",
  query: "preferences",
  maxTokens: 0,
}); // A zero budget does not constrain the output.

await client.recall({ entityId: "u1", query: "preferences", limit: 3 });
// The candidate limit is 4.5 and score math can become non-finite.
```

### Impact

Invalid JavaScript input can silently disable a budget, corrupt ranking, or
create backend-specific query failures instead of producing one typed error at
the public boundary.
