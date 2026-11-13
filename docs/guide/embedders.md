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

## `voyageEmbedder`, `cohereEmbedder` and `googleEmbedder`

For Voyage AI, Cohere and the Gemini API (Google AI Studio). Each calls the
provider's own embeddings endpoint with `fetch` (there is no SDK
dependency), reads its API key from the environment, and tells the model
whether it is embedding a query or a document.

```ts
import {
  cohereEmbedder,
  googleEmbedder,
  voyageEmbedder,
} from "mnemocyte/embedders";

const voyage = voyageEmbedder({ model: "voyage-4" });
const cohere = cohereEmbedder({ model: "embed-v4.0" });
const google = googleEmbedder({
  model: "gemini-embedding-001",
  dimensions: 768,
});
```

| Option | Default | Meaning |
|---|---|---|
| `model` | required | Embedding model id. |
| `apiKey` | `VOYAGE_API_KEY`, `COHERE_API_KEY` or `GEMINI_API_KEY` | A missing key throws `"CONFIG"`. |
| `dimensions` | the model's | A smaller size, for models that offer one (below). Required for models the helper does not know. |
| `truncate` | `true` | Cut texts longer than the model's context instead of failing the request. |
| `baseUrl` | the provider's API | Another endpoint, such as a proxy. |
| `maxBatch` | 100 (Cohere: 96) | Most texts per request. Cohere accepts at most 96. |

Known models:

| Provider | Model | `dimensions` | Other sizes |
|---|---|---|---|
| Voyage | `voyage-4-large`, `voyage-4`, `voyage-4-lite`, `voyage-3-large`, `voyage-3.5`, `voyage-3.5-lite`, `voyage-code-3` | 1024 | 256, 512, 2048 |
| Voyage | `voyage-finance-2`, `voyage-law-2` | 1024 | none |
| Cohere | `embed-v4.0` | 1536 | 256, 512, 1024 |
| Cohere | `embed-v5.0-pro`, `embed-v5.0-fast` | 2048 | 256, 512, 768, 1024, 1536 |
| Cohere | `embed-english-v3.0`, `embed-multilingual-v3.0` | 1024 | none |
| Cohere | `embed-english-light-v3.0`, `embed-multilingual-light-v3.0` | 384 | none |
| Google | `gemini-embedding-001`, `gemini-embedding-2` | 3072 | 128 to 3072; Google recommends 768 or 1536 |

A size other than the default is sent to the provider, which returns
vectors of that length. For any other model, `dimensions` only states the
length the model returns and is not sent. `googleEmbedder` also accepts
`models/gemini-embedding-001`; its `model` is the id without `models/`, as
for `aiSdkEmbedder`, so you can switch between them on an existing Postgres
installation.

### Queries and documents

| Embedder | Query | Document |
|---|---|---|
| `voyageEmbedder` | `input_type: "query"` | `input_type: "document"` |
| `cohereEmbedder` | `input_type: "search_query"` | `input_type: "search_document"` |
| `googleEmbedder` | `taskType: "RETRIEVAL_QUERY"` | `taskType: "RETRIEVAL_DOCUMENT"` |
| `googleEmbedder` with `gemini-embedding-2` | text prefix `task: search result \| query: ` | text prefix `title: none \| text: ` |

`gemini-embedding-2` does not take `taskType`; Google's guide marks its
texts with these prefixes instead. The prefix is only sent to the provider;
the stored `content` stays as you wrote it. Models the helper does not know
get `taskType`.

### Limits

- **Batches.** Cohere takes at most 96 texts per request, and a larger
  `maxBatch` throws `"CONFIG"`. Voyage takes up to 1,000 texts but also caps
  the tokens per request (120,000 for `voyage-4-large`, `voyage-3-large` and
  `voyage-code-3`), so lower `maxBatch` when memories are long. Google
  documents no limit for its batch endpoint; 100 is the helper's default.
- **Long texts.** With `truncate: true`, a text longer than the model's
  context (512 tokens for Cohere's v3 models, 2,048 for
  `gemini-embedding-001`) is embedded from its start only. With `false`,
  the request fails with a 400 `ProviderError`.
- **Vertex AI.** `googleEmbedder` calls the Gemini API with an API key, not
  Vertex AI. For Vertex, use `aiSdkEmbedder` with `@ai-sdk/google-vertex`.
- **Errors.** A provider error becomes a `ProviderError` (below). For the
  Gemini API its message also names Google's status, such as
  `RESOURCE_EXHAUSTED`. None of the three sends `Retry-After`, so retries
  wait for the client's backoff.

They are also available as `mnemocyte/embedders/voyage`,
`mnemocyte/embedders/cohere` and `mnemocyte/embedders/google`.

## `aiSdkEmbedder`

For apps that use the [AI SDK](https://ai-sdk.dev): any AI SDK embedding
model becomes an embedder. Install `ai` (7.0.135 or newer) next to
Mnemocyte; it is an optional peer dependency, and `import "mnemocyte"` does
not load it.

```ts
import { aiSdkEmbedder } from "mnemocyte/ai-sdk";

// A "provider/model" string goes through the AI Gateway
// (AI_GATEWAY_API_KEY, or OIDC on Vercel).
const embedder = aiSdkEmbedder({ model: "openai/text-embedding-3-small" });
```

```ts
import { google } from "@ai-sdk/google";
import { aiSdkEmbedder } from "mnemocyte/ai-sdk";

// A model object calls the provider directly.
const embedder = aiSdkEmbedder({
  model: google.embedding("gemini-embedding-001"),
  dimensions: 768,
});
```

A string is resolved by the AI SDK's global provider on every call: the AI
Gateway, or the provider in `globalThis.AI_SDK_DEFAULT_PROVIDER` if you set
one.

| Option | Default | Meaning |
|---|---|---|
| `model` | required | An AI SDK embedding model, or a `"provider/model"` string. |
| `dimensions` | the model's | Required for models not in the table below. |
| `maxBatch` | 100 | Most texts per call. |
| `providerOptions` | none | AI SDK `providerOptions`, sent with every call. |
| `purposes` | built in | `{ query?, document? }`, each a `providerOptions` object. |

Known models, by id with or without the gateway's `provider/` prefix:

| Model | `dimensions` |
|---|---|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `text-embedding-ada-002` | 1536 |
| `gemini-embedding-001`, `gemini-embedding-2` | 3072 |
| `embed-v4.0` (Cohere) | 1536 |
| `mistral-embed` | 1024 |
| `codestral-embed` | 1536 |
| `amazon.titan-embed-text-v2:0`, gateway `amazon/titan-embed-text-v2` | 1024 |

For a known model, a smaller `dimensions` is sent to the provider, which
shortens the vectors (`text-embedding-ada-002` cannot, and throws
`"CONFIG"`). For any other model, `dimensions` only states the length the
model returns; to shorten its vectors, set the provider's option in
`providerOptions` too.

The embedder's `model` is the model id without the provider prefix, so
`openaiEmbedder({ model: "text-embedding-3-small" })`,
`openai.embedding("text-embedding-3-small")` and
`"openai/text-embedding-3-small"` all report `text-embedding-3-small`, and you
can switch between them on an existing Postgres installation.

### Queries and documents

Google, Cohere and Voyage models embed queries and documents differently.
For them, `aiSdkEmbedder` sends the matching option by default:

| Provider | Query | Document |
|---|---|---|
| Google, Vertex | `google: { taskType: "RETRIEVAL_QUERY" }` | `google: { taskType: "RETRIEVAL_DOCUMENT" }` |
| Google, Vertex with `gemini-embedding-2` | text prefix `task: search result \| query: ` | text prefix `title: none \| text: ` |
| Cohere | `cohere: { inputType: "search_query" }` | `cohere: { inputType: "search_document" }` |
| Voyage | `voyage: { inputType: "query" }` | `voyage: { inputType: "document" }` |

The provider is read from the string's prefix (`google/…`) or the model
object (`google.embedding(…)`). Other providers get nothing; OpenAI and
Mistral models embed both the same way. Through the AI Gateway these options
reach the upstream provider under the same keys.

`gemini-embedding-2` does not take `taskType`, so it gets the same text
prefixes as with `googleEmbedder`. The prefix is only sent to the provider;
the stored `content` stays as you wrote it.

`purposes` replaces the built-in hints, the `gemini-embedding-2` prefixes
included; a purpose it leaves out gets none, and `purposes: {}` turns them
off. Each purpose's options are merged over
`providerOptions`, one provider key at a time:

```ts
const embedder = aiSdkEmbedder({
  model: cohere.embedding("embed-v4.0"),
  providerOptions: { cohere: { truncate: "END" } },
  purposes: {
    query: { cohere: { inputType: "search_query" } },
    document: { cohere: { inputType: "search_document" } },
  },
});
```

Keep the hints fixed for an installation, as with `openaiCompatibleEmbedder`.

### Retries and errors

`aiSdkEmbedder` turns the AI SDK's own retries off (`maxRetries: 0`), so
only the client's `provider` settings below retry, as for the other
embedders; two retry layers would multiply the attempts. An AI SDK `APICallError` or AI Gateway
error with an HTTP status becomes a `ProviderError` with that `status`,
`retryAfterMs` from the response's `Retry-After` or `retry-after-ms`, and
the provider's error body as `cause` (or the AI SDK error itself when there
is no body). Errors without a status, such as a network failure or an
unknown model id, are wrapped in an `"EMBEDDING"` error with the AI SDK
error as `cause`.

## Provider errors

When a provider answers with an error status, the shipped embedders throw a
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

On Postgres, `prune`, `findDuplicates`, `listAuditLog` and `consolidate`
also cancel the running query. `consolidate` is one statement, so a cancel
before it finishes writes nothing; one that arrives after it finished has no
effect. Other queries run to completion.

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
