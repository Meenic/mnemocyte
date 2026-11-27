# Changelog

All notable changes to `@mnemocyte/mcp` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Before
1.0, a minor version (`0.x.0`) can change flags or tools; such changes are
marked **Breaking**. `mnemocyte`'s own changes are in the
[root changelog](../../CHANGELOG.md).

## [Unreleased]

`forgetMemory` returns the content it deleted, so a model that passed the
wrong id can see it, as the `mnemocyte` 1.5 AI SDK tool does. The peer
range is unchanged (`mnemocyte` `^1.1.0`).

### Added

- **`forgetMemory` returns the content it deleted.** A forgotten memory
  comes back as `{ forgotten: true, content }`, so the model can see when
  it passed the wrong id, and the tool's description asks it to check.
  The output schema gains an optional `content`. An id with no visible
  memory still deletes nothing and returns `{ forgotten: false, message }`,
  where the new `message` tells the model to search for the id, and the
  description says never to guess one
  ([the guide](../../docs/guide/mcp.md#tools)).

## [0.2.0] - 2026-11-24

For Next.js apps: the server reads `.env.local` and loads memory files
that import `server-only`, as the `mnemocyte` 1.4 CLI does. The peer
range is unchanged (`mnemocyte` `^1.1.0`).

### Added

- **Memory files that import `server-only` load.** Next.js apps guard
  server code with `import "server-only"`, and the package throws when
  Node loads it outside React Server Components, so the server could not
  start on such a file. The import now loads as an empty module, whether
  or not the package is installed, as in the `mnemocyte` CLI
  ([the guide](../../docs/guide/cli.md#typescript-files)).

### Changed

- **The server reads `.env.local`, then `.env`.** It reads them from the
  app's folder, as the `mnemocyte` CLI now does and Next.js does. A value
  in `.env.local` wins over `.env`, a variable that is already set wins
  over both, and `.env.local` is skipped when `NODE_ENV` is `test`.
  `--env-file` still replaces both files.
- **The startup line names the env files it read.** The line on standard
  error ends with them, such as `env .env.local, .env`, or `env none`
  ([the guide](../../docs/guide/mcp.md#environment-variables)).

## [0.1.0] - 2026-11-23

The first release: an MCP server for Mnemocyte memory.

### Added

- **The MCP server.** `mnemocyte-mcp` serves Mnemocyte memory to MCP
  clients over stdio for one scope set by its flags (`--entity-id`,
  `--namespace`, `--agent-id`, `--session-id`). It loads the app's memory
  file as the `mnemocyte` CLI does (`--project`, `--config`,
  `--env-file`) and lists `searchMemories` and `saveMemory`, the AI SDK
  memory tools' names, inputs and outputs; `--allow-forget` adds
  `forgetMemory` and `--read-only` leaves only search. No tool input can
  name a scope. See [the guide](../../docs/guide/mcp.md).
- **`createMemoryMcpServer({ memory })` for apps that serve MCP
  themselves.** It returns the same server over a bound client, without a
  transport.

[0.2.0]: https://github.com/Meenic/mnemocyte/releases/tag/mcp-v0.2.0
[0.1.0]: https://www.npmjs.com/package/@mnemocyte/mcp/v/0.1.0
