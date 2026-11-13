# Embedders

Mnemocyte does not call an embedding provider on its own. You pass an
`Embedder`, and Mnemocyte calls it to embed memories and queries.

## The `Embedder` interface

```ts
interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch?: number;
  embed(
    texts: readonly string[],
    options: { purpose: "query" | "document"; signal?: AbortSignal },
  ): Promise<number[][]>;
}
```

- `model` is a non-empty string and `dimensions` a positive integer;
  `maxBatch`, if set, a positive integer. Anything else throws `"CONFIG"`
  from `createMemory`.
- `embed` returns one vector per input text, in input order. Each vector has
  exactly `dimensions` finite numbers, at least one of them non-zero.
  Anything else throws `"EMBEDDING"` before the vector is stored or compared.
- `options.purpose` is `"document"` when memories are stored (`add`,
  `addMany`, `update`) and `"query"` when they are searched (`search`,
  `context`). Models that embed queries and documents differently need it;
  others can ignore it.
- `maxBatch` is the most texts `addMany` sends in one call. It defaults
  to 100.
- Forward `options.signal` to your HTTP call. Timeouts and cancellation stop
  a request promptly only if the embedder passes the signal on.

Wrapping any provider takes a few lines:

```ts
const embedder = {
  model: "my-model",
  dimensions: 768,
  async embed(texts, options) {
    return embedWithYourProvider(texts, {
      inputType: options.purpose,
      signal: options.signal,
    });
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
| `baseUrl` | `https://api.openai.com/v1` | Another OpenAI endpoint, such as a proxy. |
| `maxBatch` | 100 | Most texts per request. |

Known models: `text-embedding-3-small` (1536), `text-embedding-3-large`
(3072) and `text-embedding-ada-002` (1536). The `text-embedding-3-*` models
accept a smaller `dimensions`.

The helper calls the API with `fetch`; there is no OpenAI SDK dependency, and
`import "mnemocyte"` does not load it. It is also available as
`mnemocyte/embedders/openai`.

## `openaiCompatibleEmbedder`

For any server with an OpenAI-shaped `/embeddings` endpoint: Azure OpenAI,
Mistral, Together, Ollama, LM Studio, vLLM and others.

```ts
import { openaiCompatibleEmbedder } from "mnemocyte/embedders";

const embedder = openaiCompatibleEmbedder({
  baseUrl: "http://localhost:11434/v1",
  model: "nomic-embed-text",
  dimensions: 768,
  purposes: {
    query: { prefix: "search_query: " },
    document: { prefix: "search_document: " },
  },
});
```

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Requests go to `{baseUrl}/embeddings`. |
| `model` | required | The model id as the server names it. |
| `dimensions` | required | The length of the vectors the model returns. |
| `apiKey` | none | Sent as `Authorization: Bearer …`. Local servers need none. |
| `headers` | none | Extra headers, such as `{ "api-key": key }` for Azure. |
| `maxBatch` | 100 | Most texts per request. |
| `sendDimensions` | `false` | Send `dimensions` in the request, for models that can shorten their vectors. Servers reject it for models that cannot. |
| `purposes` | none | How to mark queries and documents (below). |

`purposes.query` and `purposes.document` each take a `prefix`, put in front
of every text sent for that purpose, and `body`, fields added to the
request. Check your model's documentation for which it expects:

| Model or server | `purposes` |
|---|---|
| nomic-embed-text | `query: { prefix: "search_query: " }`, `document: { prefix: "search_document: " }` |
| E5 models | `query: { prefix: "query: " }`, `document: { prefix: "passage: " }` |
| NVIDIA NIM | `query: { body: { input_type: "query" } }`, `document: { body: { input_type: "passage" } }` |
| Jina | `query: { body: { task: "retrieval.query" } }`, `document: { body: { task: "retrieval.passage" } }` |
| OpenAI, Mistral | none: the models embed both the same way |

The prefix is only sent to the provider; the stored `content` stays as you
wrote it. Keep `purposes` fixed for an installation: memories embedded with
other hints compare poorly with new queries, and nothing detects the change.
`body` may not set `model`, `input`, `encoding_format` or `dimensions`.
It is also available as `mnemocyte/embedders/openai-compatible`.

## Provider errors

When a provider answers with an error status, both helpers throw a
`ProviderError`. Custom embedders can throw one too, to get the same retry
handling:

```ts
import { ProviderError } from "mnemocyte";

try {
  await memory.add({ scope, content });
} catch (error) {
  if (error instanceof ProviderError) {
    console.log(error.status, error.cause); // 429, { error: { code: "rate_limit_exceeded", … } }
  }
}
```

- `code` is `"EMBEDDING"`, so code that checks `MnemocyteError` codes keeps
  working.
- `status` is the HTTP status, and `retryAfterMs` the wait the provider asked
  for, if any.
- `cause` is the response body: parsed JSON, or text. The message has the
  status and the provider's short error code, but not its message text,
  which can quote part of your API key; log `cause` with care.

A network failure (the server cannot be reached) throws `fetch`'s own error
wrapped in an `"EMBEDDING"` error, with it as `cause`.

## Timeouts and retries

```ts
const memory = createMemory({
  embedder,
  provider: {
    timeoutMs: 5_000,
    retries: 2,
    baseDelayMs: 500,
    maxDelayMs: 8_000,
  },
});
```

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | 0 (none) | Per attempt. Aborts the attempt's signal and throws `"TIMEOUT"`. |
| `retries` | 2 | Extra attempts after the first. `0` turns retries off. |
| `baseDelayMs` | 500 | First wait between attempts; doubles each retry. |
| `maxDelayMs` | 8000 | Longest wait; raised to `baseDelayMs` if lower. |
| `maxRetryAfterMs` | 60000 | Longest wait a provider may ask for (below). |
| `shouldRetry` | built-in | `(error, attempt) => boolean`. |

The built-in rule retries:

- HTTP 408, 429, 500, 502, 503 and 504, read from the error's `status`;
- network errors that can pass on their own, such as a reset or refused
  connection or a DNS lookup that timed out, read from the error's `code` or
  its `cause`'s;
- `"TIMEOUT"`.

Other errors fail at once, including 4xx statuses such as a bad API key and
malformed responses. Error messages are never read.

Each wait is a random value between half and all of the current delay, so
many clients that failed together do not retry at the same moment. When the
provider sends `Retry-After` (or `retry-after-ms`), the next attempt waits
exactly that long instead. If it asks for more than `maxRetryAfterMs`, the
error is thrown without retrying.

A custom embedder gets the same handling by throwing a `ProviderError`, or
any error with numeric `status` and `retryAfterMs` fields. Invalid options
throw `"CONFIG"` from `createMemory`.

## Cancellation

Methods that call the embedder or the database accept `signal`:

```ts
const controller = new AbortController();

await memory.add({
  scope: { namespace: "my-app", entityId: "user_123" },
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
const memory = createMemory({
  embedder,
  observability: {
    onEvent(event) {
      console.log(event.operation, event.phase, event.durationMs);
    },
  },
});
```

Each public operation emits one `start` event, then one `success` or `error`
event; so does the access write of a tracked search (`"trackAccess"`, see
[search](./api.md#search)), with `operation`, `phase`, `backend`, `timestamp`,
`durationMs`, and `namespace`, `entityId`, `memoryId`, `count` or `error`
where they apply. Errors thrown by
`onEvent` are ignored, but an async `onEvent` is awaited, so a slow hook
slows every operation.
