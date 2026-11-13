# Embedders, resilience and observability

## The `Embedder` contract

```ts
interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatch?: number;
  embed(texts: readonly string[], options: EmbedOptions): Promise<number[][]>;
}

interface EmbedOptions {
  readonly purpose: "query" | "document";
  readonly signal?: AbortSignal;
}
```

`createMemory` checks that `embed` is a function, `model` is a non-empty
string, `dimensions` a positive integer and `maxBatch`, when set, a positive
integer (`"CONFIG"`). Every call's output must have one vector per input,
each of length `dimensions`, with finite components and at least one
non-zero component; otherwise `"EMBEDDING"`.

`options` is always passed. `purpose` is `"document"` from `add`, `addMany`
and `update` (when the content changes) and `"query"` from `search` and
`context`; `findDuplicates` and `consolidate` do not embed. Providers with
asymmetric models embed the two differently (Voyage and NVIDIA NIM
`input_type`, Jina `task`, prefixes such as nomic's `search_query: `), and
retrieval quality depends on using the right one. An embedder may ignore it.

`addMany` calls the embedder with at most `maxBatch` texts at a time
(`DEFAULT_MAX_BATCH`, 100, when unset; `embedMany` in
`memory/embeddings.ts`), one call after another so a large batch does not
run many requests against the provider's rate limit at once. Providers cap a
request by input count and total tokens (OpenAI: 2,048 inputs, 8,192 tokens
per input and 300,000 tokens per request); 100 texts of the 32,000-character
content cap can still pass 300,000 tokens, so `maxBatch` counts texts, not
tokens, and long contents need a smaller one. Each call gets its own timeout
and retries, the signal is checked between calls, and the first failure
stops the rest. Every call finishes before the store opens its transaction,
so no transaction is held across an embedder call, and a failed call stores
nothing.

A `ProviderError`, `"TIMEOUT"` or `"ABORTED"` from the embedder reaches the
caller as it is. Any other error is wrapped in an `"EMBEDDING"` error
(`"Failed to embed text."`) with the original as `cause`.

## Shipped embedders

The HTTP embedders build on `createFetchEmbedder` in `src/http-embedder.ts`,
which sits outside `src/embedders/` so it is not a build entry. It POSTs the
JSON body each embedder builds to one URL with `fetch` (no SDK) and the
call's signal, and hands a successful body to the embedder's parser. An
`embed` call without a valid `purpose` (untyped code) is `"VALIDATION"`, a
non-2xx response a `ProviderError` and a non-JSON success body
`"EMBEDDING"`. Each embedder checks and snapshots its options when it is
created (`"CONFIG"`), with the shared helpers in the same file
(`resolveApiKey`, `resolveModel`, `resolveModelDimensions`,
`resolveBoolean`, `resolveMaxBatch`, `resolveBaseUrl`).

`createHttpEmbedder` is the OpenAI-shaped one behind `openaiEmbedder` and
`openaiCompatibleEmbedder`: `POST {baseUrl}/embeddings`, and a response with
exactly one array embedding per input with unique, in-range indexes, sorted
by index (`parseIndexedEmbeddings`, which `voyageEmbedder` uses too).
`aiSdkEmbedder` (below) calls the AI SDK instead. All of them build their
`ProviderError`s with `createProviderError` in `src/provider-error.ts`.

### `openaiCompatibleEmbedder`

`mnemocyte/embedders/openai-compatible` (also re-exported from
`mnemocyte/embedders`), for any server with an OpenAI-shaped `/embeddings`:
OpenAI, Azure OpenAI, Mistral, Together, Ollama, LM Studio, vLLM.

| Option | Default | Meaning |
|---|---|---|
| `baseUrl` | required | Absolute URL; trailing slashes are removed. |
| `model` | required | Sent as `model`. |
| `dimensions` | required | The vector length the server returns. |
| `apiKey` | none | `Authorization: Bearer …`; no header without it. |
| `headers` | none | Extra headers, lower-cased; ours win on conflict. |
| `maxBatch` | unset (100) | Passed through to the `Embedder`. |
| `sendDimensions` | `false` | Send `dimensions` in the body. |
| `purposes` | none | `{ query?, document? }`, each `{ prefix?, body? }`. |

`dimensions` is not sent by default because vLLM rejects it for models
without Matryoshka training. A purpose's `prefix` is put in front of every
input text for that purpose and its `body` fields are merged into the
request; the stored `content` never changes. `body` is snapshotted with a
JSON round trip and may not set `model`, `input`, `encoding_format` or
`dimensions`.

### `openaiEmbedder`

`mnemocyte/embedders/openai` (also re-exported from `mnemocyte/embedders`)
is `createHttpEmbedder` with OpenAI's defaults:

- `apiKey` defaults to `OPENAI_API_KEY`; a missing key throws `"CONFIG"`.
- Known models: `text-embedding-3-small` (1536), `text-embedding-3-large`
  (3072), `text-embedding-ada-002` (1536). The `3-*` models accept a
  `dimensions` override, which is then sent; unknown models require
  `dimensions`, which is sent too.
- `baseUrl` defaults to `https://api.openai.com/v1`; `maxBatch` is passed
  through. There are no purpose hints: OpenAI models are symmetric.

### `voyageEmbedder`, `cohereEmbedder` and `googleEmbedder`

`mnemocyte/embedders/voyage`, `/cohere` and `/google` (also re-exported
from `mnemocyte/embedders`), each a `createFetchEmbedder` with its
provider's request and response (decision 29 in
[ARCHITECTURE.md](../ARCHITECTURE.md)).

| | Voyage | Cohere | Google (Gemini API) |
|---|---|---|---|
| Request | `POST {baseUrl}/embeddings` | `POST {baseUrl}/embed` | `POST {baseUrl}/models/{model}:batchEmbedContents` |
| `baseUrl` default | `https://api.voyageai.com/v1` | `https://api.cohere.com/v2` | `https://generativelanguage.googleapis.com/v1beta` |
| Auth | `authorization: Bearer …` | `authorization: Bearer …` | `x-goog-api-key` |
| Key default | `VOYAGE_API_KEY` | `COHERE_API_KEY` | `GEMINI_API_KEY` |
| Texts | `input` | `texts` | one `requests[]` item per text: `model: "models/{id}"`, `content.parts[{ text }]` |
| Purpose | `input_type` `query` / `document` | `input_type` `search_query` / `search_document` | `embedContentConfig.taskType` `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT`; text prefixes for `gemini-embedding-2` |
| Size | `output_dimension` | `output_dimension` | `embedContentConfig.outputDimensionality` |
| `truncate` | `truncation: boolean` | `truncate: "END"` / `"NONE"` | `embedContentConfig.autoTruncate` |
| Always sent | | `embedding_types: ["float"]` | |
| Response | `data[].embedding` by `index` | `embeddings.float`, in order | `embeddings[].values`, in order |
| `maxBatch` | unset (100) | 96, at most 96 | 100 |

- `apiKey` falls back to the environment variable; a missing or blank key
  throws `"CONFIG"`. Explicit `apiKey` wins.
- `dimensions` is resolved by `resolveModelDimensions` against each file's
  `KNOWN_MODELS`: a known model that can shorten its vectors takes one of
  its sizes (`sizes` list, or Google's `range` 128–3072), which is sent; a
  known fixed-size model accepts only its own size, not sent; an unknown
  model requires `dimensions`, not sent. The tables hold the models in
  the guide; `voyage-code-4` and `voyage-4-nano` are left out because the
  Voyage docs disagree on their sizes.
- `truncate` is a boolean, `true` by default, and always sent.
- `googleEmbedder` strips a `models/` prefix for `Embedder.model` and
  encodes the id into the URL. Its known-models entries carry a
  `purposeStyle`: `taskType`, or `prefix` for `gemini-embedding-2`
  (`task: search result | query: ` and `title: none | text: `, from the
  Gemini embeddings guide). Unknown Gemini models get `taskType`.
- Cohere and Google responses are checked by `assertVectorList`: one array
  per input, in order. Element values are checked by the core.

### `aiSdkEmbedder`

`mnemocyte/ai-sdk` (`src/ai-sdk.ts`, its own build entry) wraps an AI SDK
embedding model in an `Embedder` through `embedMany`. `ai` is an optional
peer (`^7.0.135`, the first 7.x whose `embedMany` takes `dimensions`) and a
dev dependency; only this entry imports it, and a package test follows the
static imports of every other entry to check that none reaches `ai`.

| Option | Default | Meaning |
|---|---|---|
| `model` | required | A model object (`specificationVersion` `v2`–`v4`, `provider`, `modelId`, `doEmbed`) or a non-empty string. |
| `dimensions` | from the table | Required for unknown models. |
| `maxBatch` | unset (100) | Passed through to the `Embedder`. |
| `providerOptions` | none | Sent with every call. |
| `purposes` | built-in hints | `{ query?, document? }`, each provider options. |

Options are checked when the embedder is created (`"CONFIG"`);
`providerOptions` and `purposes` must be objects of objects and are
snapshotted with a JSON round trip.

**Model id and provider.** A string's first `/` splits it into provider
and id (`openai/text-embedding-3-small`); a string without one has no
provider. A model object's provider is `model.provider` up to the first dot
(`google.generative-ai` → `google`, `google.vertex.embedding` → `google`,
`cohere.textEmbedding` → `cohere`), and its id is `modelId`, except for a
gateway model (`provider` `gateway`), whose `modelId` is split like a
string. `Embedder.model` is the id, so the gateway string, a direct model
object and `openaiEmbedder` report the same model and can share an
installation. The string itself is passed to `embedMany` unresolved, so
the AI SDK resolves it through `globalThis.AI_SDK_DEFAULT_PROVIDER` (the
AI Gateway when unset) on every call.

**Dimensions.** The known-models table (`KNOWN_MODELS`) holds the default
sizes the AI SDK provider docs state: OpenAI `text-embedding-3-small`
(1536), `text-embedding-3-large` (3072), `text-embedding-ada-002` (1536),
Google `gemini-embedding-001` and `gemini-embedding-2` (3072), Cohere `embed-v4.0` (1536), Mistral
`mistral-embed` (1024) and `codestral-embed` (1536), and Titan Text
Embeddings v2 under both its Bedrock id (`amazon.titan-embed-text-v2:0`) and
its gateway id (`titan-embed-text-v2`), 1024. Voyage and the other gateway
models are left out because the docs state no default. A `dimensions` that
differs from a known model's is sent as `embedMany`'s `dimensions`;
`text-embedding-ada-002` rejects one (`"CONFIG"`). For unknown models
`dimensions` is never sent.

**Purposes.** Without `purposes`, the provider picks built-in hints:
Google `taskType` `RETRIEVAL_QUERY` / `RETRIEVAL_DOCUMENT` under `google`
(Vertex reads `googleVertex`, then `vertex`, then `google`), Cohere
`inputType` `search_query` / `search_document` under `cohere`, Voyage
`inputType` `query` / `document` under `voyage`. Cohere's API defaults to
`search_query`, so stored documents would otherwise be embedded as queries.
The AI Gateway forwards `providerOptions` to the upstream provider under the
same keys. The hint for the call's purpose is merged over `providerOptions`
one provider key at a time, and each call gets a `structuredClone` of the
result.

`gemini-embedding-2` from a `google` provider (`DEFAULT_PREFIXES`, keyed
`google/gemini-embedding-2`) gets no `taskType`, which the Gemini
embeddings guide says it cannot take. `embed` puts the prefixes
`googleEmbedder` uses in front of each value passed to `embedMany`
instead: `task: search result | query: ` and `title: none | text: `. The
rule covers the Gemini API, Vertex AI and a `google/…` gateway id; the
same id from another provider, or a string without a provider, gets
nothing. `purposes` replaces the hints entirely, prefixes included.

**Calls.** `embedMany` runs with `maxRetries: 0`, `maxParallelCalls: 1` and
the call's signal as `abortSignal`. Mnemocyte's chunks already go one at a
time, and the AI SDK splits a chunk further when the model's
`maxEmbeddingsPerCall` is lower (Cohere: 96); with one call at a time those
sub-calls run in order too. A failed sub-call fails the chunk, and a retry
embeds the whole chunk again. `maxRetries: 0` leaves retries to
`withResilience`: the AI SDK's own (2 retries from 2 s, `Retry-After` up to
60 s) would otherwise run inside each of Mnemocyte's attempts, and its
backoff does not follow `config.provider`. With `maxRetries: 0`, `embedMany`
throws the provider's error unchanged, not a `RetryError`.

**Errors.** An `APICallError` with a `statusCode` becomes a `ProviderError`
(`"AI SDK embeddings request failed with status 429 (rate_limit_exceeded)."`)
with `retryAfterMs` read from `responseHeaders` by `parseRetryAfterMs`, and
as `cause` the provider's parsed error (`data`), else the response body
parsed like the HTTP embedders', else the `APICallError` itself. AI Gateway
errors (`GatewayError`, recognised by the `Symbol.for("vercel.ai.gateway.error")`
marker, since `ai` does not export the class) keep their `statusCode` and
read headers and body from the `APICallError` they wrap in `cause`. An
`APICallError` without a status (a network failure) and every other error
are thrown unchanged, so the core wraps them as `"EMBEDDING"`; a network
code along the `cause` chain still retries.

### Errors

In the HTTP embedders, a non-2xx response throws a `ProviderError`
(exported from `mnemocyte`; `aiSdkEmbedder`'s mapping is above): a
`MnemocyteError` with code `"EMBEDDING"`, `status`, `retryAfterMs` and the
response body as `cause` (parsed JSON, or text; bodies over 8,192
characters are cut and kept as text; an empty body leaves `cause`
undefined). The message names the status and, when the body has one, a
short `code` or `type` (OpenAI's `error.code`/`error.type`, Google's
canonical `error.status` such as `RESOURCE_EXHAUSTED`, vLLM's top-level
`type`). Voyage's `detail` and Cohere's `message` are free text and give no
label. The body's free-text `message` stays out of the message
because providers can echo part of the key in it (OpenAI's "Incorrect API
key provided: sk-…").

`retryAfterMs` comes from `retry-after-ms` (OpenAI, Azure) when it is a
non-negative number, else `Retry-After` as delay-seconds or an HTTP-date
(RFC 9110, section 10.2.3); a date in the past means 0, and anything else is
ignored. A failed `fetch` (network error) is thrown unchanged.

## Resilience

`config.provider` wraps every embedder call (`withResilience` in
`resilience.ts`):

| Option | Default | Meaning |
|---|---|---|
| `timeoutMs` | 0 (off) | Per attempt; aborts the attempt's signal and throws `"TIMEOUT"`. |
| `retries` | 2 | Extra attempts after the first. |
| `baseDelayMs` | 500 | First backoff; doubles per retry. |
| `maxDelayMs` | 8000 | Backoff ceiling (raised to `baseDelayMs` if lower). |
| `maxRetryAfterMs` | 60000 | Longest server-requested wait honoured. |
| `shouldRetry` | built-in | `(error, attempt) => boolean`. |

The defaults match the official OpenAI Node SDK (two retries, 0.5 s
doubling to 8 s), which also ignores server waits over 60 s.

The built-in `defaultShouldRetry` reads fields, never message text:

- a numeric `status` of 408, 429, 500, 502, 503 or 504 retries; any other
  status does not (409 would blur with `"CONFLICT"`, 501 and 505 do not
  pass on their own);
- a `code` of `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`,
  `EAI_AGAIN`, `UND_ERR_SOCKET`, `UND_ERR_CONNECT_TIMEOUT`,
  `UND_ERR_HEADERS_TIMEOUT` or `UND_ERR_BODY_TIMEOUT` on the error or up to
  four `cause` links down retries (`fetch` rejects with
  `TypeError("fetch failed")` whose `cause` carries it);
- a `MnemocyteError` retries only with code `"TIMEOUT"`; a malformed
  response (`"EMBEDDING"`) does not.

Until `feat/embedder-purpose` the rule also retried any error whose message contained "500",
"network", "timeout" and similar words, and every `MnemocyteError` except
four codes.

Waits use equal jitter: the capped exponential delay `d`, then a random
value between `d / 2` and `d`, so clients that failed together do not retry
together while every wait still backs off. An error with a numeric,
non-negative `retryAfterMs` (any error, not only `ProviderError`) waits
exactly that long instead, or is thrown at once when it is over
`maxRetryAfterMs`. A custom `shouldRetry` decides whether to retry; the
`retryAfterMs` wait and cutoff still apply.

A caller `signal` cancels the current attempt and any backoff wait with
`"ABORTED"`; a pre-aborted signal rejects before any work. Provider requests
stop promptly only if the embedder forwards the signal to `fetch`.

## Observability

`observability.onEvent(event)` receives one `start` and one `success` or
`error` event per public operation, and per access write of a tracked search
(`"trackAccess"`), with `operation`, `backend`, `timestamp`,
`durationMs`, and `namespace`, `entityId`, `memoryId`, `count` where they
apply. The hook
is called synchronously and **not awaited** (`observability.ts`): events of a
call are delivered in order, but async hook work may overlap, and a
synchronous hook still blocks. A throw or rejection goes to the optional
`observability.onError({ error, event })`, or is dropped; a failing `onError`
is ignored too. There is no per-call queue, so a hook that never settles
holds nothing. The AI SDK middleware and tools only call client methods, so
they are covered by the same behavior (decision 27 keeps them off `onEvent`).

## Client lifecycle

The client has no `close()`: it holds no connections or timers (see
[scopes.md](./scopes.md#lifecycle)).
