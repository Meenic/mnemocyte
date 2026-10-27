# Embedders, resilience and observability

## The `Embedder` contract

```ts
interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}
```

`createMnemocyte` checks that `embed` is a function, `model` is a non-empty
string and `dimensions` a positive integer (`"CONFIG"`). Every call's output
must have one vector per input, each of length `dimensions`, with finite
components and at least one non-zero component; otherwise `"EMBEDDING"`.
Queries and documents are embedded the same way: there is no query/document
distinction yet.

`rememberMany` embeds the whole batch in one call; there is no chunking.

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
`error` event per public operation, and per access write of a tracked recall
(`"trackAccess"`), with `operation`, `backend`, `timestamp`,
`durationMs`, and `entityId`, `memoryId`, `count` where they apply. Errors
thrown by the hook are swallowed, but the hook is **awaited**, so a slow async
hook delays every operation.

## Client lifecycle

`close()` stops new operations (`"DB"`, "client is closed"), waits for running
ones, then closes the store. It does not wait for access writes started by
tracked recalls. Repeated calls share one promise; if closing the
store fails, the client reopens so it can be retried.
