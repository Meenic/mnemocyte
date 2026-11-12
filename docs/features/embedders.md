# Embedders, resilience and observability

## The `Embedder` contract

```ts
interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}
```

`createMemory` checks that `embed` is a function, `model` is a non-empty
string and `dimensions` a positive integer (`"CONFIG"`). Every call's output
must have one vector per input, each of length `dimensions`, with finite
components and at least one non-zero component; otherwise `"EMBEDDING"`.
Queries and documents are embedded the same way: there is no query/document
distinction yet.

`addMany` calls the embedder with at most `EMBED_CHUNK_SIZE` (100) texts at
a time (`embedMany` in `memory/embeddings.ts`), one call after another so a
large batch does not run many requests against the provider's rate limit at
once. Providers cap a request by input count and total tokens (OpenAI: 2,048
inputs and 300,000 tokens); 100 texts of the 32,000-character content cap can
still pass 300,000 tokens, so very long contents may need smaller batches
once `maxBatch` lands (`feat/embedder-purpose`). Each call gets its own
timeout and retries, the signal is checked between calls, and the first
failure stops the rest. Every call finishes before the store opens its
transaction, so no transaction is held across an embedder call, and a failed
call stores nothing. `update` calls the embedder only when the content
changes.

## `openaiEmbedder`

`mnemocyte/embedders/openai` (also re-exported from `mnemocyte/embedders`)
calls `POST {baseUrl}/embeddings` with `fetch`; there is no SDK.

- `apiKey` defaults to `OPENAI_API_KEY`; missing key throws `"CONFIG"`.
- Known models: `text-embedding-3-small` (1536), `text-embedding-3-large`
  (3072), `text-embedding-ada-002` (1536). The `3-*` models accept a
  `dimensions` override; unknown models require `dimensions`.
- `baseUrl` defaults to `https://api.openai.com/v1`, so OpenAI-compatible
  servers work.
- The response must contain exactly one array embedding per input with
  unique, in-range indexes; results are sorted by index.
- A non-2xx response throws an `Error` with `status`; the response body is
  not read.

## Resilience

`config.provider` wraps every embedder call:

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | 0 (off) | Per attempt; aborts the attempt's signal and throws `"TIMEOUT"`. |
| `retries` | 0 | Extra attempts after the first. |
| `baseDelayMs` | 100 | First backoff; doubles per retry. |
| `maxDelayMs` | 2000 | Backoff ceiling (raised to `baseDelayMs` if lower). |
| `shouldRetry` | built-in | `(error, attempt) => boolean`. |

The built-in `shouldRetry` retries HTTP 429/500/502/503/504 (`error.status`),
messages containing network words or `500`/`502`/`503`/`504`, and
`MnemocyteError`s other than `VALIDATION`, `CONFIG`, `CONFLICT` and `ABORTED`.
There is no jitter and no `Retry-After` handling.

A caller `signal` cancels the current attempt and any backoff wait with
`"ABORTED"`; a pre-aborted signal rejects before any work. Provider requests
stop promptly only if the embedder forwards the signal to `fetch`.

## Observability

`observability.onEvent(event)` receives one `start` and one `success` or
`error` event per public operation, and per access write of a tracked search
(`"trackAccess"`), with `operation`, `backend`, `timestamp`,
`durationMs`, and `namespace`, `entityId`, `memoryId`, `count` where they
apply. Errors
thrown by the hook are swallowed, but the hook is **awaited**, so a slow async
hook delays every operation.

## Client lifecycle

The client has no `close()`: it holds no connections or timers (see
[scopes.md](./scopes.md#lifecycle)).
