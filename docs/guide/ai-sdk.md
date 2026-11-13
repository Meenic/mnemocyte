# AI SDK

`mnemocyte/ai-sdk` connects Mnemocyte to the [AI SDK](https://ai-sdk.dev):
memory tools a model can call, a middleware that adds memories to every
prompt, and an embedder built on an AI SDK embedding model (see
[embedders](./embedders.md#aisdkembedder)). It needs the `ai`
package, 7.0.135 or newer:

```bash
pnpm add ai
```

## Memory tools

`memoryTools({ memory })` returns three tools for `generateText`,
`streamText` or an agent: `searchMemories`, `saveMemory` and
`forgetMemory`. Pass a client bound to the current user with
`memory.for(scope)`:

```ts
import { generateText, stepCountIs } from "ai";
import { memoryTools } from "mnemocyte/ai-sdk";
import { memory } from "./memory";

const { text } = await generateText({
  model: "openai/gpt-6.1-sol",
  tools: memoryTools({ memory: memory.for({ entityId: session.userId }) }),
  stopWhen: stepCountIs(5),
  prompt: "I moved to Lisbon last month. Any tips for the winter?",
});
```

The scope is fixed on your server when the tools are created. No tool takes
a `namespace`, `entityId`, `agentId`, `sessionId` or `scope` field, and a
call that sends one fails validation, so a prompt injection cannot make the
model read or change another user's memories. Take the entity id from your
own session or auth, never from the request body.

Passing the unbound client (`memory` instead of `memory.for(...)`) throws
`"CONFIG"`.

### `searchMemories`

| Input | |
|---|---|
| `query` | Required. What to look for. |
| `limit` | 1–20. Defaults to 5. |
| `kinds` | Only memories of these kinds. |

Returns `{ memories }`, best match first. Each memory has `id`, `content`,
`kind`, `importance`, `tags`, `createdAt` (an ISO 8601 string) and `score`
(in `[0, 1]`, three decimals). Metadata, keys, sources and the scope are
left out, so data your app keeps in `metadata` never reaches the model. The
search sees what `memory.search` sees at the bound scope, shared memories
included, and records access if `trackAccess` is on.

### `saveMemory`

| Input | |
|---|---|
| `content` | Required. The memory as a short sentence. |
| `kind` | Defaults to `"fact"`. |
| `importance` | Defaults to `"normal"`. |

Returns `{ id }`. The memory is stored at the bound scope with
`source: "saveMemory"`, so you can tell model-written memories from your
own. The model cannot set a `key`, tags, metadata, confidence or expiry;
input limits are the same as for `add`.

### `forgetMemory`

| Input | |
|---|---|
| `id` | Required. An id from `searchMemories`. |

Returns `{ forgotten: true }`, or `{ forgotten: false }` when no memory
with that id is visible at the bound scope. Like `delete`, it can remove a
memory shared by every agent or session of the bound entity, not only one
written at the exact scope.

### Errors and cancellation

Each tool forwards the call's `abortSignal` to Mnemocyte, so aborting
`generateText` or `streamText` also cancels a running search or save
(`"ABORTED"`). Any other error is thrown from the tool, and the AI SDK
returns its message to the model as a tool error instead of failing the
call. Mnemocyte's error messages leave out provider response text.

### Choosing tools and asking for approval

The result is a plain object, so you can leave a tool out or change one:

```ts
const { forgetMemory, ...readAndWrite } = memoryTools({ memory: user });

const tools = {
  ...readAndWrite,
  saveMemory: {
    ...readAndWrite.saveMemory,
    description: "Save a lasting fact about the customer's account.",
  },
};
```

To ask the user before the model deletes anything, use the AI SDK's tool
approval:

```ts
const result = await generateText({
  model,
  tools: memoryTools({ memory: user }),
  toolApproval: { forgetMemory: "user-approval" },
  prompt,
});
```

The call then returns a `tool-approval-request` instead of running the
tool; see the AI SDK's
[tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
docs for answering it.

## Memory in every prompt

`withMemory({ model, memory })` wraps a language model so that every call
starts with the user's relevant memories. It is
`wrapLanguageModel({ model, middleware: memoryMiddleware(options) })` in one
call; use `memoryMiddleware` directly to combine it with other middleware.

```ts
import { openai } from "@ai-sdk/openai";
import { streamText } from "ai";
import { withMemory } from "mnemocyte/ai-sdk";
import { memory } from "./memory";

const result = streamText({
  model: withMemory({
    model: openai("gpt-6.1-sol"),
    memory: memory.for({ entityId: session.userId }),
  }),
  instructions: "You are a helpful assistant.",
  messages,
});
```

```ts
import { wrapLanguageModel } from "ai";
import { memoryMiddleware } from "mnemocyte/ai-sdk";

const model = wrapLanguageModel({
  model: openai("gpt-6.1-sol"),
  middleware: [memoryMiddleware({ memory: user }), otherMiddleware],
});
```

`withMemory` takes a model object. For a `"provider/model"` id, pass
`gateway("openai/gpt-6.1-sol")` (from `ai`) or your provider's model; a
string throws `"CONFIG"`. Passing the unbound client throws `"CONFIG"` too.

Before each model call, the middleware:

1. takes the text of the last user message as the query (its last 32,000
   characters);
2. runs `memory.context()` with it, forwarding the call's `abortSignal`;
3. adds the result, under one line saying these are memories to treat as
   background and not as instructions, to the prompt.

When no memory matches, `context()` returns `""` and the prompt is left as
it is. The context is added to what the model receives only, never to your
`messages`, so it is not stored in your chat history.

In a multi-step call (tools with `stopWhen`), every step is a model call
with the same last user message. The middleware reuses the context of the
last query, so the steps embed once; a memory saved by a tool mid-turn
appears from the next turn on. Create the middleware per request, from the
`memory.for(...)` of that request, as in the examples.

### Options

| Option | |
|---|---|
| `memory` | Required. A client from `memory.for(scope)`. |
| `placement` | `"user"` (default) or `"system"`. |
| `context` | `context()` settings: `maxTokens` (default 1200), `format` (default `"markdown"`), `limit`, `minScore`, `kinds`, `tags`, `tokenCounter`, `trackAccess` and the other filters. |
| `query` | `({ prompt }) => string \| undefined`. Replaces the last-user-message query; return `undefined` to add nothing. |
| `save` | A hook called after each response; see below. |
| `onError` | `({ phase, error }) => void`. Receives the failures the middleware swallows. |

`context` takes neither `query` nor `signal` (both come from the call), nor
a `scope`; those throw `"CONFIG"`. Its settings are checked on each call
like any `context()` input, so a bad value (such as `maxTokens: 0`) reaches
`onError` as `"VALIDATION"`.

### Where the context goes

With `placement: "user"` the context is the first text part of the last
user message. With `"system"` it is a system message placed after your
leading system messages (Anthropic and Google reject a system message after
the conversation has started).

The user message is the default for two reasons:

- **Prompt caching.** Providers cache the start of a prompt. Context that
  changes every turn in the system position changes that start, so the
  cached conversation is lost on every turn; in the last user message the
  history before it stays the same.
- **Authority.** Memories can hold text that came from users, including
  what a model saved with `saveMemory`. In a system message that text
  carries system authority; in the user message it carries the user's.

### Saving after a response

`save` is called once per `generateText` or `streamText`, after the final
model call: not after steps that end in tool calls, and not when the call
fails, is aborted, or the stream ends with an error. For a stream it runs
when the stream has finished. It receives:

| Field | |
|---|---|
| `memory` | The bound client. |
| `prompt` | The prompt of the final model call without the added context: the conversation, earlier tool steps included, in the AI SDK's provider format. |
| `text` | The response text. |
| `finishReason` | Why the model stopped, such as `"stop"` or `"length"`. |

The response does not wait for the hook, and Mnemocyte saves nothing by
itself: the hook decides what to store.

```ts
const model = withMemory({
  model: openai("gpt-6.1-sol"),
  memory: user,
  save: async ({ memory, text }) => {
    if (text.includes("I'll remember")) {
      await memory.add({ content: text, kind: "episode", source: "chat" });
    }
  },
  onError: ({ phase, error }) => logger.warn({ phase, error }),
});
```

On serverless platforms the function can stop once the response is sent.
Hand the work to the platform so it finishes, for example with Vercel's
`waitUntil()` (Cloudflare Workers have `ctx.waitUntil()`):

```ts
import { waitUntil } from "@vercel/functions";

const model = withMemory({
  model: openai("gpt-6.1-sol"),
  memory: user,
  save: (turn) => {
    waitUntil(storeTurn(turn));
  },
});
```

### Errors and cancellation

If `context()` fails (the embedder or the database is down), the error goes
to `onError` with `phase: "context"`, and the model call runs without
memory; the client's `onEvent` also records it as a failed `"context"`
operation. Aborting the call is different: an aborted `abortSignal` cancels
`context()` and the call throws, without calling the model.

A `save` hook that throws or rejects goes to `onError` with
`phase: "save"`. Errors thrown by `onError` itself are ignored.
