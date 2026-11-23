# @mnemocyte/mcp

An MCP server for [Mnemocyte](https://github.com/Meenic/mnemocyte) memory.
MCP clients such as Claude Code and Cursor can search and save memories
in your app's database, for one user you name when you start it.

Install it next to `mnemocyte` (1.1 or newer):

```bash
pnpm add -D @mnemocyte/mcp
```

Start it for one user, from your app's folder:

```bash
pnpm exec mnemocyte-mcp --entity-id user_123
```

Add it to Claude Code:

```bash
claude mcp add memory -- npx -y @mnemocyte/mcp --project "$PWD" --entity-id me
```

The server loads your app's memory file, as the `mnemocyte` CLI does, and
lists `searchMemories` and `saveMemory`; `--allow-forget` adds
`forgetMemory`. The scope comes from the flags only: no tool input can name
another user. It speaks MCP over stdio and needs Node.js 22.18 or newer.

The guide covers client setup, every flag, the tools and the limits:
[docs/guide/mcp.md](https://github.com/Meenic/mnemocyte/blob/main/docs/guide/mcp.md).
Changes are in the
[changelog](https://github.com/Meenic/mnemocyte/blob/main/packages/mcp/CHANGELOG.md).

## License

[MIT](https://github.com/Meenic/mnemocyte/blob/main/LICENSE)
