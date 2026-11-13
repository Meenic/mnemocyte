# AI SDK integration

`mnemocyte/ai-sdk` (`src/ai-sdk.ts`) is the only entry that imports `ai`,
an optional peer at `^7.0.135`; `src/ai-sdk.ts` and `src/ai-sdk-tools.ts`
are the only source files that do. It exports `aiSdkEmbedder` (see
[embedders.md](./embedders.md#aisdkembedder)) and `memoryTools`
(`src/ai-sdk-tools.ts`). The user guide is
[guide/ai-sdk.md](../guide/ai-sdk.md); decision 26 in
[ARCHITECTURE.md](../ARCHITECTURE.md#decisions) records the choices below.

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

## Tests

`test/ai-sdk/tools.test.ts` runs on the in-memory backend: schemas and
descriptions, the `"CONFIG"` checks, save, search and forget at the bound
scope, isolation between two entities (search finds nothing, forget returns
`false` and leaves the memory), every `validate` rejection, abort signals
reaching the embedder (aborted mid-call) and rethrown errors. Two tests run
`generateText` with `MockLanguageModelV4`: a three-step call that saves and
searches, and a model that sends `entityId`, which ends as a `tool-error`.
A third aborts `generateText` while a tool is embedding.

`test/package/exports.test.ts` checks the built entry,
`test/package/lazy-postgres.test.ts` runs `searchMemories` from the packed
tarball with `ai` linked in, and `test/package/exports-types.test-d.ts`
checks the exported types, `ToolSet` assignability, and that the unbound
client, a `key` and a scope field are type errors.
