# MCP server

How `@mnemocyte/mcp` (`packages/mcp/`) is built (ARCHITECTURE decisions
84 to 89). The user reference is [guide/mcp.md](../guide/mcp.md).

## Package

- A separate package because it brings dependencies of its own: the MCP
  TypeScript SDK v2, `@modelcontextprotocol/server` (`^2.4.0`, which
  brings `zod` 4), and a bin. `mnemocyte` stays dependency-free.
- `mnemocyte` is a peer dependency, `^1.1.0`: `forgetMemory` passes
  `dependents: "delete"` to `delete`, which arrived in 1.1.0. In the
  workspace it is also a `workspace:*` dev dependency, so the package
  builds and tests against `packages/mnemocyte/dist/`, the public API an
  app sees. Its scripts therefore need `mnemocyte` built first; the root
  `*:mcp` scripts do that.
- Only public exports of `mnemocyte` are used: `isMnemocyteError` and
  types. Clients are recognised by shape, not by the CLI's internal
  `Symbol.for("mnemocyte.memory-client")`.
- `dist/index.mjs` exports `createMemoryMcpServer` and the tool types.
  `dist/cli.mjs` is the `mnemocyte-mcp` bin, not an export; tsdown keeps
  its `#!/usr/bin/env node` line, and the `drop-cli-declarations` plugin
  deletes its empty declaration file, as in `mnemocyte`. Its
  `server-only-stub` plugin writes `dist/server-only.cjs` the same way.
- `prepack` copies the root `LICENSE` in (gitignored). The package has a
  committed README of its own with absolute links, and its own
  `CHANGELOG.md`, which does not ship.
- The SDK serves both protocol eras: the 2026-07-28 revision (no
  initialize handshake, no sessions) and 2025-era clients that open with
  `initialize`. `serveStdio` picks one per connection and calls the
  server factory once for it.

## Files

| File | What it holds |
|---|---|
| `src/index.ts` | The package entry. |
| `src/server.ts` | `createMemoryMcpServer`: option checks, `toolNames`, registration, `SERVER_INFO` (name `mnemocyte-mcp`, version from `package.json`, or `"unknown"` when a bundler moved the module away from it). |
| `src/tools.ts` | The three tools: JSON Schemas, input validation, handlers, annotations. |
| `src/cli.ts` | The bin: redirects `console`, runs `prepare`, then `serveStdio`, and exits when stdin ends. |
| `src/cli/args.ts` | `parseCliArgs` (`node:util` `parseArgs`, strict), `USAGE`, `UsageError`. |
| `src/cli/main.ts` | `prepare(argv, io, version)`: `--project`, `.env`, the memory file, `memory.for(scope)`, the startup line. Never rejects. |
| `src/cli/memory-file.ts` | `locateMemoryFile` (`--config`, else `findMemoryFile` from `@mnemocyte/loader`) and `loadMemoryClient`. |
| `src/cli/console.ts` | `redirectConsoleToStderr`. |

## Tools

The tools repeat `memoryTools` from `mnemocyte/ai-sdk` (names,
descriptions, input fields, limits, output shapes, error messages, `source:
"saveMemory"`, `dependents: "delete"`), because that entry imports `ai`.
A change to one should reach the other in the same PR; no test compares
them, since this package does not depend on `ai`.

- **Schemas.** The SDK's `registerTool` takes a Standard Schema with a
  JSON Schema converter (`StandardSchemaWithJSON`). Each input schema is a
  small object whose `~standard.jsonSchema` returns the fixed JSON Schema
  (with `additionalProperties: false`) and whose `~standard.validate` is
  the hand-written check, so the messages match `memoryTools` ("entityId
  is not accepted: the memory scope is fixed by the server.") and no
  schema library is needed. The SDK reports a failed check as a tool
  result with `isError: true` and the text `Input validation error:
  Invalid arguments for tool …: <message>`, which is what the spec asks
  for (invalid arguments are tool execution errors, not protocol errors).
- **Results.** Each tool returns `structuredContent` and the same JSON as
  a text block, which the spec recommends for clients that read only
  text, and declares an `outputSchema`. The output schemas' `validate`
  accepts anything, since the server builds the values.
- **Errors.** A handler that throws becomes an `isError` result with the
  error's message (for example `Failed to embed text.`). `forgetMemory`
  reads the memory with `get` first and returns
  `{ forgotten: true, content }`, or `{ forgotten: false }` without
  deleting when there is none; a `"NOT_FOUND"` from `delete` gives the
  same (decision 105).
- **Cancellation.** Handlers pass `ctx.mcpReq.signal` to `search`, `add`,
  `get` and `delete`, so a client's `notifications/cancelled` aborts the call.
- **Annotations.** `searchMemories`: `readOnlyHint`. `saveMemory`: not
  destructive, not idempotent. `forgetMemory`: `destructiveHint` and
  `idempotentHint` (deleting twice leaves the same state; the second call
  reports `forgotten: false`). All three set `openWorldHint: false`: they
  touch only the app's own database. The spec says clients must treat
  annotations from untrusted servers as hints only.
- **Which tools.** `toolNames` decides: search always, save unless
  `readOnly`, forget only with `allowForget`. An unlisted tool is a
  protocol error ("Tool forgetMemory not found"), not a tool result.

## The bin

1. `redirectConsoleToStderr` replaces the `console` methods that write to
   standard output (`log`, `info`, `debug`, `dir`, `table`, `group`,
   `count`, `time` and their relatives) with those of a `Console` on
   standard error, before anything of the app's is imported. On stdio,
   standard output carries only MCP messages; one `console.log` in the
   memory file would corrupt the stream. Direct `process.stdout.write`
   calls are not caught: the SDK's transport writes through that same
   stream.
2. `prepare` parses the flags. `--project` (default: the working
   directory) is the folder for the env files, the lookup, `--config` and
   `--env-file`, because MCP clients do not document which folder they
   start a server in. `loadEnvironment` reads `--env-file`, else calls
   `loadEnvFiles` from the shared loader, the CLI's own order:
   `.env.local`, then `.env`, no `.env.local` when `NODE_ENV` is `test`
   (decision 78). It returns the files it read, and the startup line ends
   with them (`env .env.local, .env`, or `env none`).
3. `loadMemoryClient` imports the memory file as the CLI does: Node's type
   stripping plus `registerAppResolver` from the shared loader. It
   takes the `memory` export, else the default export's `memory`, else
   the default export, and accepts the first value with `for`, `search`,
   `add` and `delete` functions. A bound client (a `scope` and no `for`)
   gets its own message, since the scope must come from the flags.
4. `memory.for(scope)` binds it. A `"VALIDATION"` error there, typically
   no namespace in the flags or the memory file, becomes a usage error
   that suggests `--namespace`. One server is built here so a bad option
   fails at startup, and the startup line goes to standard error.
5. `serveStdio(createServer)` serves the connection. The bin exits 0 once
   stdin ends (`end` or `close`), after flushing both streams: the app's
   database client, which the bin does not own, would otherwise keep the
   process alive. A usage problem exits 2 with the message and, for bad
   flags, the usage; anything unexpected exits 1.

### The shared loader

The env file order, the memory file lookup, the resolve hook and the
tsconfig reader come from `@mnemocyte/loader` (`packages/loader/`), a
private workspace package that this package and `mnemocyte` list as a
`workspace:*` dev dependency and tsdown bundles into `dist/cli.mjs`
(decision 93). The env files and a TypeScript memory file therefore load
the same way in both bins; see
[features/cli.md](./cli.md#loading-the-memory-file) for how it works. The
published `package.json` gains no dependency (pnpm writes the dev
dependency as `0.0.0` when it packs). A change to the loader, such as
mapping `import "server-only"` to an empty module (decision 97), is made
once, but reaches this bin's users only with this package's next
release. Exporting the loader from `mnemocyte`
would add public API that only tools use and tie this package to a newer
`mnemocyte` (decision 85).

## Tests

`pnpm test:mcp` at the root builds `mnemocyte`, then runs the package's
`test`: its build and Vitest (`packages/mcp/vitest.config.ts`, one
project). `mnemocyte` resolves to its `dist/`. None of the tests needs a
database or a network: they use the in-memory store and a letter-count
embedder (`test/fixtures/app/src/embedder.ts`).

| File | Covers |
|---|---|
| `test/server.test.ts` | `tools/list` per option, schemas and annotations; save, search and forget over `InMemoryTransport` with the SDK's `Client`; scope fields and bad input rejected as tool errors; another entity's memories invisible and not deletable; an embedder failure as a tool error; a client's cancel reaching the embedder's signal; `createMemoryMcpServer`'s option checks. |
| `test/cli.test.ts` | `parseCliArgs`; `prepare` in process with a recording `CliIo`: help, usage errors on stderr only, the lookup and `--project`, a bound export, a file without a client, a missing namespace, `--env-file`; the env files from `--project`, with `test/fixtures/env/memory.ts` taking its namespace from the environment, and the files named on the startup line. |
| `test/bin.test.ts` | The built `dist/cli.mjs` over real stdio with `StdioClientTransport`: Node loads `test/fixtures/app/src/memory.ts` with an extensionless import, which needs the resolve hook, and its `console.log` must not break the stream; `test/fixtures/server-only/memory.ts`, which imports `server-only` and a `.cjs` file that `require()`s it, starting without the package and with a stand-in of 0.0.1 written to its `node_modules` (removed afterwards); exit 2 on bad flags with nothing on stdout; exit 0 when stdin closes. |
| `test/loader-bundle.test.ts` | The loader sources embedded in `dist/cli.mjs.map` are exactly `packages/loader/src/` (index aside), and `dist/index.mjs` does not reach `registerHooks`. The loader's own tests are in `packages/loader/test/`. |

The `prepare` tests import memory files inside Vitest, which transforms
them itself, so only `test/bin.test.ts` exercises Node's own loading.
`test/fixtures/` is outside `tsconfig.json`'s checks except the
embedder, which `test/helpers.ts` imports.

## CI and releases

The `MCP` job runs `test:mcp` on Node 22.18, 24 and 26, since type
stripping differs between them, and `checktypes:mcp`, `lint` and
`lint:package:mcp` (publint and attw on the packed tarball) on Node 24.
See DEVELOPMENT.md, "What CI runs" for the files that start it and
"Releasing" for the `mcp-vX.Y.Z` tags.

## Known limits

- stdio only; one scope per process. An HTTP transport needs the scope
  from authentication, which is a design of its own (ROADMAP).
- The tools are written twice (here and `mnemocyte/ai-sdk`), and nothing
  checks that they agree.
- A direct `process.stdout.write` in the app's modules corrupts the
  stream.
