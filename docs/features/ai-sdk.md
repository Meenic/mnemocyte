# AI SDK integration

`mnemocyte/ai-sdk` (`src/ai-sdk.ts`) is the only entry that imports `ai`,
an optional peer at `^7.0.135`; `src/ai-sdk.ts`, `src/ai-sdk-tools.ts`,
`src/ai-sdk-middleware.ts` and `src/ai-sdk-extraction.ts` are the only
source files that do. It exports `aiSdkEmbedder` (see
[embedders.md](./embedders.md#aisdkembedder)), `memoryTools`
(`src/ai-sdk-tools.ts`), `memoryMiddleware` and `withMemory`
(`src/ai-sdk-middleware.ts`), and `extractMemories`
(`src/ai-sdk-extraction.ts`). The user guide is
[guide/ai-sdk.md](../guide/ai-sdk.md); decisions 24, 26, 27 and 28 in
[ARCHITECTURE.md](../ARCHITECTURE.md#decisions) record the choices below.

## Memory tools

`memoryTools({ memory })` returns `{ searchMemories, saveMemory,
forgetMemory }`, each built with the AI SDK's `tool()`. It takes only a
`BoundMemoryClient`, recognised by its `scope` object and its `search`,
`add` and `delete` methods; the unbound client has no `scope`, so it fails
the check with `"CONFIG"`, as does a missing or non-object input.

The bound client is the security boundary. Every tool calls it, so each
call is scoped to `memory.for(scope)` on the server, and no input schema has
a scope field. A model that sends one anyway (`entityId`, `namespace`,
`agentId`, `sessionId`, `scope`, `allNamespaces`) fails input validation
with a message saying the scope is fixed; the AI SDK returns that to the
model as a tool error. Even if a field slipped through, the bound client
rejects `scope` and `allNamespaces` itself (`"VALIDATION"`).

### Schemas

Input schemas are JSON Schema through the AI SDK's `jsonSchema()`, not zod,
so the package adds no peer and no zod major to support. `jsonSchema()`
without `validate` checks nothing (`safeValidateTypes` returns the value
unchanged), so each tool has its own `validate`: an object with only the
known fields, the right types and enum values, and a copy of the input with
undefined fields dropped. The JSON Schemas set `additionalProperties: false`
and list the same enums, so models that honour schemas never send the
fields `validate` rejects. Sizes (content length, query length) are left to
the client's own validation, which throws `"VALIDATION"` from `execute`.

`strict` is not set: OpenAI's strict mode needs every property to be
required, and our optional fields would break it.

`MemoryTools` is a type alias, not an interface, so it is assignable to the
AI SDK's `ToolSet` (`Record<string, Tool>`); an interface has no implicit
index signature.

### Behaviour

- `searchMemories` calls `search` with `limit` (default 5, at most 20) and
  `kinds` (an empty array is dropped). Results become `FoundMemory` objects
  of JSON values: `createdAt` as an ISO string, `score` rounded to three
  decimals. Scope, key, source, metadata, embedding fields, access counts
  and `explanation` stay out of the model's context.
- `saveMemory` calls `add` with `content`, `kind`, `importance` and a fixed
  `source: "saveMemory"`. No key: a model-chosen key could overwrite a keyed
  memory the app wrote in the same exact scope. Tags, metadata, confidence
  and expiry stay the app's.
- `forgetMemory` calls `delete` by id. `"NOT_FOUND"` (including a non-UUID
  id) becomes `{ forgotten: false }`; any other error is rethrown. It uses
  the bound client's visibility, so shared memories of the entity are
  reachable.
- Each `execute` passes `options.abortSignal` as the client's `signal`. The
  AI SDK merges the call's `abortSignal` with any per-tool timeout into that
  signal. Errors are not caught: the AI SDK turns a thrown error into a
  `tool-error` part whose message goes back to the model, and the call
  continues.

Tool-level `needsApproval` is deprecated in AI SDK 7; approval is
configured with `toolApproval` on `generateText` / `streamText`, so the
tools set nothing and the guide shows `toolApproval: { forgetMemory:
"user-approval" }`.

## Memory middleware

`memoryMiddleware(options)` returns a `LanguageModelMiddleware` (the `ai`
type: `LanguageModelV4Middleware` without `specificationVersion`, which
`wrapLanguageModel` fills in). `withMemory({ model, ...options })` returns
`wrapLanguageModel({ model, middleware })`. Both validate their options
eagerly and throw `"CONFIG"` for: a missing options object; a value without
an object `scope` and a `context` method (the unbound client has no
`scope`); a `placement` other than `"user"` or `"system"`; a non-object
`context` or one with `query`, `signal`, `scope` or `allNamespaces`; a
`query` or `onError` that is not a function; and a `save` that is neither a
function nor valid extraction options (see [Extraction](#extraction)). `withMemory` also
rejects a string or non-object `model`: `wrapLanguageModel` only accepts
model objects, and resolving strings ourselves would copy the AI SDK's
internal global-provider lookup. The `context` options are copied
shallowly at creation; their values are validated by `context()` on each
call.

Types come from `ai` alone (`@ai-sdk/provider` is not a dependency):
`MemoryPrompt` is `transformParams`'s `params.prompt`, `MemoryFinishReason`
is the generate result's `finishReason.unified`, and `MemoryLanguageModel`
and `MemoryWrappedModel` are `wrapLanguageModel`'s parameter and return
types.

### Context

`transformParams` runs before every model call, `generate` or `stream`,
and in a multi-step call once per step:

1. The query is `options.query({ prompt })`, by default the text parts of
   the last user message joined with newlines, cut to its last 32,000
   characters (`MAX_CONTENT_LENGTH`, the `context()` query limit).
   `undefined` or a blank string returns `params` unchanged.
2. `memory.context({ ...options.context, query, signal })`, with
   `params.abortSignal` as `signal`. The last successful result is cached
   by query string in the middleware's closure, so the steps of one tool
   loop embed once. Failures are not cached.
3. `""` (no memory matched; see
   [retrieval.md](./retrieval.md#context)) returns `params` unchanged.
   Otherwise the block is a fixed preamble line, a blank line and the
   context.
4. `"user"` placement copies the last user message with the block as its
   first text part; a prompt with no user message falls back to
   `"system"`. `"system"` placement inserts `{ role: "system" }` after the
   leading run of system messages, since Anthropic and Google reject system
   messages later in the prompt.

The returned params are a new object; the original prompt is kept in a
`WeakMap` keyed by it, which the save hook reads. Nothing changes the
caller's messages.

If the query callback or `context()` throws, the error is rethrown when
`params.abortSignal` is aborted or it is an `"ABORTED"` `MnemocyteError`;
anything else goes to `onError({ phase: "context", error })` and `params`
are returned unchanged (fail open). The client's own `onEvent` already
reports the failed `"context"` operation. `onError` is called in a
`try`/`catch`, so a throwing handler cannot fail the call.

### Save hook

Without `save` the middleware has only `transformParams`. With it (a
function, or `{ model }`, which becomes the extraction hook described in
[Extraction](#extraction)),
`wrapGenerate` awaits `doGenerate()` and `wrapStream` pipes the stream
through a pass-through `TransformStream` that joins `text-delta` parts,
records the `finish` part's reason and notes any `error` part; its
`flush()` fires the hook. The hook fires when the reason is not
`"tool-calls"`, `"error"` or `"interrupted"`, and for a stream only when a
`finish` part arrived and no `error` part did, so a tool loop's
intermediate steps and failed or aborted calls never save.

The hook gets `{ memory, prompt, text, finishReason }`, where `prompt` is
the original prompt from the `WeakMap` (or `params.prompt` when nothing
was added). It is started without being awaited: a synchronous throw and a
rejected promise both go to `onError({ phase: "save", error })`.

## Extraction

`extractMemories({ model, memory, prompt, text })` and
`save: { model, ...options }` on the middleware share `runExtraction`
(`src/ai-sdk-extraction.ts`). The middleware checks the options when it is
created (`resolveExtractionOptions`, `"CONFIG"` with the
`memoryMiddleware save` or `withMemory save` prefix) and turns them into a
hook; `extractMemories` checks them on each call and rejects with
`"CONFIG"`, or `"VALIDATION"` for a `prompt` that is not an array or a
`text` that is not a string. The settings:

| Option | Check | Default |
|---|---|---|
| `model` | a non-blank string or an object; `generateText` resolves it | required |
| `instructions` | a string of at most 4,000 characters | none |
| `maxMemories` | an integer from 1 to 20 | 10 |
| `timeout` | a positive integer, in ms | 30,000 |
| `waitUntil` (middleware only) | a function | none |

Unlike `withMemory`'s `model`, a `"provider/model"` string is accepted:
`generateText` resolves it, so no AI SDK internals are copied.

### Steps

1. **The turn.** `readTurn` takes the run of user messages that ends with
   the last one (their text parts, joined with blank lines, last 8,000
   characters), and the text of the assistant message right before that run
   (last 2,000). The response `text` is cut to its first 4,000. System
   messages, tool calls, tool results, files and reasoning parts are never
   read: tool results carry third-party text, the main way an injection
   would reach memory. A turn with no user text returns `[]` without any
   call.
2. **Existing memories.** `memory.search({ query: userText, limit: 20,
   trackAccess: false })` with the bound client's default visibility, so
   shared memories are included. Each is shown as `{ kind, content }`
   (content cut to 500 characters), plus `key` without the prefix when the
   key starts with `extracted:` and the memory is in the exact bound scope:
   only those keys are ones an upsert from here would update. App keys
   stay hidden, so the model cannot copy one.
3. **The model call.** `generateText` with `instructions` (the built-in
   prompt, a "return at most N" line, then any `instructions` under
   "Application guidance:"), a JSON `prompt` of `{ existingMemories,
   conversation: { previousAssistantMessage, userMessage,
   assistantResponse } }` (JSON, so text in a message cannot close a
   section), `output: Output.object({ schema, name: "memories" })` and
   `providerOptions: { mnemocyte: { extraction: true } }`. AI SDK 7
   deprecates `generateObject` for `generateText` with `output`. The AI
   SDK's default retries (2) apply.
4. **Validation.** The schema is `jsonSchema()` with our `validate`, as for
   the tools. Every property is required and `additionalProperties` is
   false, so OpenAI's strict mode accepts it; `maxItems` and `pattern` are
   left out because not every provider accepts them. `validate` rejects a
   non-object, a kind other than `fact`, `preference`, `instruction` or
   `backstory`, an importance other than `low`, `normal` or `high`, blank
   content, or a key with no letters or digits; the AI SDK then throws
   `NoObjectGeneratedError`. Keys are lower-cased and every run of other
   characters becomes `_` (at most 64 characters), and content is trimmed.
5. **Write.** The last item per key is kept, in first-seen order, and the
   list is cut to `maxMemories`. One `addMany` stores them with key
   `extracted:<key>` and `source: "extractMemories"`. The keyed upsert
   (`ON CONFLICT … DO UPDATE` on Postgres; see [scopes.md](./scopes.md))
   updates a memory with that key in the exact scope in place, keeping its
   id, so concurrent extractions of one fact end in one memory. An empty
   list writes nothing.

One `AbortSignal.timeout(timeout)`, combined with the caller's `signal`
through `AbortSignal.any`, covers the search, the model call and the write.
When the timer fired and the caller's signal did not, the error becomes a
`"TIMEOUT"` `MnemocyteError` with the original as `cause`.

No similarity threshold is used to match facts. `search` embeds its query
with `purpose: "query"`, and for asymmetric embedders (Cohere, Google,
nomic) a query-to-document cosine is not comparable to the
document-to-document cosine of `findDuplicates`; a cut-off also differs
from one embedding model to another, and a check-then-insert races where
the keyed upsert does not.

### In the middleware

`save: { model }` becomes a hook that starts `runExtraction` with the
turn's `memory`, `prompt` (the original, without the added context) and
`text`, under the same final-step rule as a `save` function. A failure goes
to `onError({ phase: "save", error })`; the promise handed to `waitUntil`
settles after that and never rejects. The request's `abortSignal` is not
passed: the response has finished by then. The store calls report to the
client's `onEvent` as any call does; extraction adds no operation of its
own.

`isExtractionCall(params.providerOptions)` makes `transformParams`,
`wrapGenerate` and `wrapStream` pass an extraction call through untouched,
so a model wrapped with `withMemory` (or any memory middleware) given as
the extraction model neither adds context to the extraction prompt nor
starts another extraction. Providers read only their own key in
`providerOptions`, so they ignore the `mnemocyte` key.

## Tests

`test/ai-sdk/middleware.test.ts` runs on the in-memory backend with
`MockLanguageModelV4`: the `"CONFIG"` checks; `"user"` placement through
`generateText` with `instructions` and history; `"system"` placement after
two leading system messages; `context` options (`format: "xml"`) and an
unchanged prompt for an entity with no memories; the `query` option and a
`query` that returns `undefined`; one query embedding with a signal across
a three-step tool loop; fail-open with `onError` (and a throwing
`onError`); an abort that throws without calling the model; an invalid
`maxTokens` reaching `onError` as `"VALIDATION"`; the save hook once after
a tool loop with the original prompt, after `streamText` finishes, not
after a tool-call step or an errored stream, and failing hooks reported
without affecting the response.

`test/ai-sdk/extraction.test.ts` runs on the in-memory backend with
`MockLanguageModelV4`: stored memories with prefixed, normalized keys,
`source` and trimmed content; the request (`responseFormat`, the marker,
the conversation without system messages or tool results); a changed fact
updated in place with the same id and its key shown to the model; an app
key never overwritten and shown without its key; a shared memory shown
without its key to an agent-bound client; no write for an empty result and
no call without user text; the last item per key, `maxMemories` and
`instructions`; schema rejections (`episode`, `critical`, a key without
letters, blank content) as `NoObjectGeneratedError`; `"TIMEOUT"`; the
`"CONFIG"` and `"VALIDATION"` checks. Through the middleware: `save`
option checks; a response that returns while the extraction model is
still blocked, then the stored memory and the `waitUntil` promise; one
extraction after a tool loop and one after `streamText`; a failing
extraction reaching `onError`; and a `withMemory` model as the extraction
model, which makes exactly one extraction call with no added context
(the test fails with the guard removed).

`test/ai-sdk/tools.test.ts` runs on the in-memory backend: schemas and
descriptions, the `"CONFIG"` checks, save, search and forget at the bound
scope, isolation between two entities (search finds nothing, forget returns
`false` and leaves the memory), every `validate` rejection, abort signals
reaching the embedder (aborted mid-call) and rethrown errors. Two tests run
`generateText` with `MockLanguageModelV4`: a three-step call that saves and
searches, and a model that sends `entityId`, which ends as a `tool-error`.
A third aborts `generateText` while a tool is embedding.

`test/package/exports.test.ts` checks the built entry,
`test/package/lazy-postgres.test.ts` runs `searchMemories`, a
`withMemory` `generateText` call and an `extractMemories` call from the
packed tarball with `ai` linked in, and
`test/package/exports-types.test-d.ts` checks the exported types,
`ToolSet` assignability, that the middleware fits `wrapLanguageModel` and
`withMemory`'s result is a `LanguageModel`, that `save` takes a hook or
extraction options with a model id or object, and that the unbound client
(for the tools, the middleware and `extractMemories`), a `key`, a scope
field, a string model for `withMemory`, `context.query`, an unknown
placement and extraction options without a model are type errors.
