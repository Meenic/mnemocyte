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
