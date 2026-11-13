# AI SDK integration

`mnemocyte/ai-sdk` (`src/ai-sdk.ts`) is the only entry that imports `ai`,
an optional peer at `^7.0.135`; `src/ai-sdk.ts`, `src/ai-sdk-tools.ts` and
`src/ai-sdk-middleware.ts` are the only source files that do. It exports
`aiSdkEmbedder` (see [embedders.md](./embedders.md#aisdkembedder)),
`memoryTools` (`src/ai-sdk-tools.ts`), and `memoryMiddleware` and
`withMemory` (`src/ai-sdk-middleware.ts`). The user guide is
[guide/ai-sdk.md](../guide/ai-sdk.md); decisions 26 and 27 in
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
`context` or one with `query`, `signal`, `scope` or `allNamespaces`; and a
`query`, `save` or `onError` that is not a function. `withMemory` also
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

Without `save` the middleware has only `transformParams`. With it,
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

`test/ai-sdk/tools.test.ts` runs on the in-memory backend: schemas and
descriptions, the `"CONFIG"` checks, save, search and forget at the bound
scope, isolation between two entities (search finds nothing, forget returns
`false` and leaves the memory), every `validate` rejection, abort signals
reaching the embedder (aborted mid-call) and rethrown errors. Two tests run
`generateText` with `MockLanguageModelV4`: a three-step call that saves and
searches, and a model that sends `entityId`, which ends as a `tool-error`.
A third aborts `generateText` while a tool is embedding.

`test/package/exports.test.ts` checks the built entry,
`test/package/lazy-postgres.test.ts` runs `searchMemories` and a
`withMemory` `generateText` call from the packed tarball with `ai` linked
in, and `test/package/exports-types.test-d.ts` checks the exported types,
`ToolSet` assignability, that the middleware fits `wrapLanguageModel` and
`withMemory`'s result is a `LanguageModel`, and that the unbound client, a
`key`, a scope field, a string model, `context.query` and an unknown
placement are type errors.
