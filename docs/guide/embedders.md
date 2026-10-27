# Embedders

Mnemocyte does not call an embedding provider on its own. You pass an
`Embedder`, and Mnemocyte calls it to embed memories and queries.

## The `Embedder` interface

```ts
interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}
```

- `model` is a non-empty string and `dimensions` a positive integer; anything
  else throws `"CONFIG"` from `createMnemocyte`.
- `embed` returns one vector per input text, in input order. Each vector has
  exactly `dimensions` finite numbers, at least one of them non-zero.
  Anything else throws `"EMBEDDING"` before the vector is stored or compared.
- Forward `options.signal` to your HTTP call. Timeouts and cancellation stop
  a request promptly only if the embedder passes the signal on.

Wrapping any provider takes a few lines:

```ts
const embedder = {
  model: "my-model",
  dimensions: 768,
  async embed(texts, options) {
    return embedWithYourProvider(texts, { signal: options?.signal });
  },
};
```

On Postgres, `model` and `dimensions` must match the installation (see
[postgres.md](./postgres.md#one-embedding-model-per-installation)).

## `openaiEmbedder`

```ts
import { openaiEmbedder } from "mnemocyte/embedders";

const embedder = openaiEmbedder({ model: "text-embedding-3-small" });
```

| Option | Default | Meaning |
|---|---|---|
| `model` | required | Embedding model id. |
| `apiKey` | `process.env.OPENAI_API_KEY` | A missing key throws `"CONFIG"`. |
| `dimensions` | the model's | Required for models the helper does not know. |
| `baseUrl` | `https://api.openai.com/v1` | Any OpenAI-compatible `/embeddings` endpoint. |

Known models: `text-embedding-3-small` (1536), `text-embedding-3-large`
(3072) and `text-embedding-ada-002` (1536). The `text-embedding-3-*` models
accept a smaller `dimensions`.

The helper calls the API with `fetch`; there is no OpenAI SDK dependency, and
`import "mnemocyte"` does not load it. It is also available as
`mnemocyte/embedders/openai`. A non-2xx response throws an `Error` with
`status`; a malformed response body throws `"EMBEDDING"`.

## Timeouts and retries

```ts
const client = createMnemocyte({
  embedder,
  provider: {
    timeoutMs: 5_000,
    retries: 2,
    baseDelayMs: 200,
    maxDelayMs: 2_000,
  },
});
```

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | 0 (none) | Per attempt. Aborts the attempt's signal and throws `"TIMEOUT"`. |
| `retries` | 0 | Extra attempts after the first. |
| `baseDelayMs` | 100 | First wait between attempts; doubles each retry. |
| `maxDelayMs` | 2000 | Longest wait; raised to `baseDelayMs` if lower. |
| `shouldRetry` | built-in | `(error, attempt) => boolean`. |

The built-in rule retries HTTP 429, 500, 502, 503 and 504, network errors,
and Mnemocyte errors other than `VALIDATION`, `CONFIG`, `CONFLICT` and
`ABORTED`. Waits have no jitter, and `Retry-After` headers are ignored.
Invalid options throw `"CONFIG"` from `createMnemocyte`.

## Cancellation

Methods that call the embedder or the database accept `signal`:

```ts
const controller = new AbortController();

await client.remember({
  entityId: "user_123",
  content: "Prefers short answers.",
  signal: controller.signal,
});
```

An aborted signal throws `"ABORTED"`. A signal that is already aborted throws
before any work starts. The signal cancels the embedder attempt and any wait
between retries.

On Postgres, `prune`, `findDuplicates` and `listAuditLog` also cancel the
running query. Other queries run to completion. `consolidate` checks the
signal between its statements: a statement that is already running finishes
first, and an abort while the transaction commits may still leave the change
committed.

## Observability

```ts
const client = createMnemocyte({
  embedder,
  observability: {
    onEvent(event) {
      console.log(event.operation, event.phase, event.durationMs);
    },
  },
});
```

Each public operation emits one `start` event, then one `success` or `error`
event; so does the access write of a tracked recall (`"trackAccess"`, see
[recall](./api.md#recall)), with `operation`, `phase`, `backend`, `timestamp`, `durationMs`, and
`entityId`, `memoryId`, `count` or `error` where they apply. Errors thrown by
`onEvent` are ignored, but an async `onEvent` is awaited, so a slow hook
slows every operation.
