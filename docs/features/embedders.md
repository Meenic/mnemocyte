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

Both build on `createHttpEmbedder` in `src/http-embedder.ts`, which sits
outside `src/embedders/` so it is not a build entry. It calls
`POST {baseUrl}/embeddings` with `fetch` (no SDK), checks and snapshots its
options when the embedder is created (`"CONFIG"`), and validates the
response: exactly one array embedding per input with unique, in-range
indexes, sorted by index. A non-JSON success body is `"EMBEDDING"`. An
`embed` call without a valid `purpose` (untyped code) is `"VALIDATION"`.

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

### Errors

A non-2xx response throws a `ProviderError` (exported from `mnemocyte`): a
`MnemocyteError` with code `"EMBEDDING"`, `status`, `retryAfterMs` and the
response body as `cause` (parsed JSON, or text; bodies over 8,192
characters are cut and kept as text; an empty body leaves `cause`
undefined). The message names the status and, when the body has one, a
short `code` or `type` (OpenAI's `error.code`/`error.type`, vLLM's
top-level `type`). The body's free-text `message` stays out of the message
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
apply. Errors
thrown by the hook are swallowed, but the hook is **awaited**, so a slow async
hook delays every operation.

## Client lifecycle

The client has no `close()`: it holds no connections or timers (see
[scopes.md](./scopes.md#lifecycle)).
