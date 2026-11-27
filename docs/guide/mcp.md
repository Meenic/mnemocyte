# MCP server

`@mnemocyte/mcp` lets MCP clients such as Claude Code and Cursor search
and save memories in your app's database. It runs on your machine, loads
the memory file your app already has, and serves one user's memories, the
one you name when you start it.

Install it next to `mnemocyte` (1.1 or newer):

```bash
pnpm add -D @mnemocyte/mcp
```

Start it for one user:

```bash
pnpm exec mnemocyte-mcp --entity-id user_123
```

Run by hand, it waits for a client on standard input; press Ctrl+C to
stop it. Usually your MCP client starts it, as shown below. It needs Node.js 22.18 or newer, like `mnemocyte`. The package is at 0.x,
so its flags and tools can still change in a minor release; the
[changelog](../../packages/mcp/CHANGELOG.md) says when.

## How it works

The server talks MCP over stdio: the client starts it as a child process
and sends requests on its standard input. On start it:

1. loads `.env.local`, then `.env`, from your app's folder, as the
   [CLI does](./cli.md#environment-variables), or the file in `--env-file`;
2. imports your memory file, the same file and lookup the
   [CLI uses](./cli.md#the-memory-file), TypeScript and
   [`import "server-only"`](./cli.md#typescript-files) included;
3. binds the client to the scope in its flags with `memory.for(...)`;
4. prints one line to standard error, such as:

   ```text
   mnemocyte-mcp 0.2.0: src/memory.ts, scope namespace=app entityId=user_123, tools searchMemories, saveMemory, env .env.local, .env
   ```

The server uses your app's embedder and store, so it reads and writes
the same database with the same embedding model.

Standard output carries only MCP messages. Anything your memory file or
its imports print with `console.log` goes to standard error instead.

## Add it to your client

Clients do not all say which folder they start a server in, so pass your
app's folder with `--project`. `npx -y @mnemocyte/mcp` runs the copy
installed in the folder the client starts it in, and downloads the package
when there is none; either way it loads your app's memory file and its
`mnemocyte`.

Claude Code, in `.mcp.json` at the root of your project:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": [
        "-y",
        "@mnemocyte/mcp",
        "--project",
        "${CLAUDE_PROJECT_DIR:-.}",
        "--entity-id",
        "me"
      ]
    }
  }
}
```

Or from a terminal in your project:

```bash
claude mcp add memory -- npx -y @mnemocyte/mcp --project "$PWD" --entity-id me
```

Cursor, in `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "@mnemocyte/mcp",
        "--project",
        "${workspaceFolder}",
        "--entity-id",
        "me"
      ]
    }
  }
}
```

Any other client that starts a stdio server takes the same command and
arguments. Give `--project` the absolute path of your app.

### Environment variables

Your embedder's API key and your database URL must reach the server.
Some clients start a server with only a few of your shell's variables, so
put them in your app's `.env.local` or `.env`, which the server loads from
`--project`, or in the client's own `env` (or `envFile`) setting. As in
the CLI, `.env.local` wins over `.env`, a variable that is already set
wins over both, and `.env.local` is skipped when `NODE_ENV` is `test`. The
startup line ends with the files it read (`env none` when there were
none), so you can tell whether it found your app's files.

## Choose the scope

The scope comes from the flags and nothing else. No tool takes a scope
field, and a call that sends one (`entityId`, `namespace`, `scope`, ...)
fails, so a prompt cannot make the model read or change another user's
memories.

| Flag | |
|---|---|
| `--entity-id <id>` | Required. The user or entity whose memories the tools use. |
| `--namespace <name>` | Defaults to `createMemory({ namespace })` in your memory file. Without either, the server stops with a message. |
| `--agent-id <id>` | Narrow the scope to one agent. |
| `--session-id <id>` | Narrow the scope to one session. |

Searches see what `memory.search` sees at that scope, so memories shared
by every agent or session of the entity show up too. To keep what one
coding agent saves apart from the rest, give it an agent id:
`--agent-id claude-code`. Its saves then carry that agent id, and a
server or app call without `--agent-id claude-code` does not find them.

One server serves one scope. For several users, start one server per
user, or see [your own server](#in-your-own-server).

## Tools

The tools are the [AI SDK memory tools](./ai-sdk.md#memory-tools) with the
same names, inputs and outputs:

| Tool | Listed | Does |
|---|---|---|
| `searchMemories` | always | Finds memories by `query`, with an optional `limit` (1–20, default 5) and `kinds`. Returns `{ memories }`, best match first, each with `id`, `content`, `kind`, `importance`, `tags`, `createdAt` and `score`. |
| `saveMemory` | unless `--read-only` | Saves `content` with an optional `kind` and `importance`, with `source: "saveMemory"`. Returns `{ id }`. |
| `forgetMemory` | with `--allow-forget` | Deletes the memory with that `id`, and duplicates merged into it, for good. Returns `{ forgotten: true, content }` with the deleted memory's content, or `{ forgotten: false }` when no memory has that `id`, and then deletes nothing. Like `delete`, it can remove a memory shared by every agent or session of the entity. |

`forgetMemory` is off unless you pass `--allow-forget`, because a deletion
cannot be undone and some clients run tools without asking. `--read-only`
lists only `searchMemories`; it cannot be combined with
`--allow-forget`.

Each result has the JSON as text and as structured content. Bad input and
failures, such as a down embedder, come back as tool errors the model can
read; Mnemocyte's messages leave out provider response text. When the
client cancels a call, the search or save is cancelled too.

The tools tell the client that search only reads, that save does not
delete anything, and that forget deletes and is safe to repeat. Clients
can use these hints to decide when to ask you first.

## All flags

| Flag | |
|---|---|
| `--project <dir>` | Your app's folder. `--config`, `--env-file` and the memory file lookup are relative to it. Defaults to the working directory. |
| `--config <file>` | Your memory file, when it is not one of `memory.ts`, `memory.mts`, `memory.js` or `memory.mjs` in the folder, `lib`, `src` or `src/lib`. |
| `--env-file <file>` | Load this file instead of `.env.local` and `.env`. |
| `--allow-forget` | List `forgetMemory`. |
| `--read-only` | List only `searchMemories`. |
| `-h`, `--help` | Print the flags. |
| `-v`, `--version` | Print the version. |

The memory file must export the client from `createMemory()`, not one
from `memory.for(...)`: the server binds it to the scope in the flags.

The server exits 2 when the flags are wrong or the memory file cannot be
used, 1 when it fails for another reason, with the reason on standard
error in both cases, and 0 when the client closes the connection.

## In your own server

`createMemoryMcpServer` returns the server without a transport, so you can
serve it over HTTP or any other transport from the MCP TypeScript SDK
(`@modelcontextprotocol/server`):

```ts
import { createMemoryMcpServer } from "@mnemocyte/mcp";
import { memory } from "./memory.ts";

const server = createMemoryMcpServer({
  memory: memory.for({ entityId: session.userId }),
  allowForget: false,
});
```

It takes `memory` (a bound client), `allowForget` and `readOnly`. Create
one server per connection. Over HTTP, take the entity id from your own
authentication, never from the request, and check the request's `Origin`,
as the MCP specification requires.

## Limitations

- The bin speaks stdio only. Serving over HTTP needs your own server
  with authentication, as above.
- One process serves one scope.
- The memory file loads as it does for the CLI, with the same
  [TypeScript limits](./cli.md#typescript-files).
- `console` output is moved to standard error, but code that writes to
  `process.stdout` directly breaks the connection.
- The tools search, save and forget. There are no MCP resources or
  prompts, and no tool for `context()`.
- When the client closes the connection, the server exits without closing
  your database client; ending the process closes its connections.
