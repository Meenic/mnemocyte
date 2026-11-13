# AI SDK

`mnemocyte/ai-sdk` connects Mnemocyte to the [AI SDK](https://ai-sdk.dev):
memory tools a model can call, and an embedder built on an AI SDK embedding
model (see [embedders](./embedders.md#aisdkembedder)). It needs the `ai`
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
  model: "openai/gpt-5",
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
