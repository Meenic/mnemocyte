# Changelog

All notable changes to `@mnemocyte/mcp` are documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Before
1.0, a minor version (`0.x.0`) can change flags or tools; such changes are
marked **Breaking**. `mnemocyte`'s own changes are in the
[root changelog](../../CHANGELOG.md).

## [Unreleased]

### Added

- **The MCP server.** `mnemocyte-mcp` serves Mnemocyte memory to MCP
  clients over stdio for one scope set by its flags (`--entity-id`,
  `--namespace`, `--agent-id`, `--session-id`). It loads the app's memory
  file as the `mnemocyte` CLI does (`--project`, `--config`,
  `--env-file`) and lists `searchMemories` and `saveMemory`, the AI SDK
  memory tools' names, inputs and outputs; `--allow-forget` adds
  `forgetMemory` and `--read-only` leaves only search. No tool input can
  name a scope. See [the guide](../../docs/guide/mcp.md).
- **`createMemoryMcpServer({ memory })`** returns the same server over a
  bound client, without a transport, for apps that serve MCP themselves.
