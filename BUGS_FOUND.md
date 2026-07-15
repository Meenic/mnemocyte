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

## BUG-03: Nested metadata aliases in memory and diverges from JSONB

**Status:** Deferred pending a metadata value contract.

Public-memory cloning copies only the top-level metadata object. Nested arrays
and objects remain shared with caller input, stored in-memory records, and
returned results. Postgres introduces a JSON serialization boundary instead,
which deep-copies JSON-compatible data and rejects or transforms unsupported
values.

### Reproduction

```ts
const metadata = { profile: { tier: "gold" } };
const memory = await client.remember({
  entityId: "u1",
  content: "account tier",
  metadata,
});

metadata.profile.tier = "free";
// On the in-memory backend, the stored memory now also reports "free".

(memory.metadata.profile as { tier: string }).tier = "trial";
// Mutating a returned nested value can also mutate later in-memory results.
```

The public type also accepts `{ sequence: 1n }` or cyclic objects. The
in-memory backend can retain those values, while Postgres JSONB serialization
cannot persist them consistently.

### Impact

Caller-side mutation can change stored in-memory state without a Mnemocyte
write, and the same typed metadata value can behave differently across
backends.
