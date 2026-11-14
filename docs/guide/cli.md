# CLI

`mnemocyte` is a command that ships with the package. It creates and
upgrades the Postgres schema, checks an installation, and prints the schema
as SQL. It uses the memory client your app already exports, so the command
and the app share one database client and one embedder.

```bash
npx mnemocyte migrate
npx mnemocyte check
npx mnemocyte sql --dimensions 1536
```

`npx` runs the copy installed in your project; `pnpm exec mnemocyte` and
`yarn mnemocyte` do the same. It needs Node.js 22.18 or newer, like the
package.

## The memory file

`migrate` and `check` load the file where your app creates its client and
read its `memory` export:

```ts
// memory.ts
import { createMemory } from "mnemocyte";
import { openaiEmbedder } from "mnemocyte/embedders";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);

export const memory = createMemory({
  store: sql,
  embedder: openaiEmbedder({ model: "text-embedding-3-small" }),
});
```

The command looks for `memory.ts`, `memory.mts`, `memory.js` or
`memory.mjs` in the project root, then `lib/`, `src/` and `src/lib/`, and
takes the first one. `--config <path>` (`-c`) names any other file. A
default export works when there is no `memory` export.

The embedder is never called: the command only reads its `dimensions` and
`model`. The file still has to load, though, and the hosted embedders
(`openaiEmbedder`, `voyageEmbedder`, …) throw when they are created without
an API key. So the key's variable, such as `OPENAI_API_KEY`, must be set
where the command runs; no request is made with it.

### TypeScript files

The file is loaded by Node itself, which runs TypeScript by removing the
types. On top of that the command resolves the imports TypeScript projects
write that Node alone does not:

- relative imports without an extension (`./db`) and folders with an
  `index.ts` (`./settings`);
- `.js` for a `.ts` file (`./db.js`), as `module: nodenext` projects write;
- `paths` from the nearest `tsconfig.json`, such as `@/lib/db`, including a
  `tsconfig.json` that `extends` another.

What does not load, and fails with a message that says so:

- `enum`, `namespace` with code, and constructor parameter properties,
  which need a compiler (the
  [Node.js docs](https://nodejs.org/docs/latest-v22.x/api/typescript.html)
  list them);
- `.tsx` files;
- a type imported without `import type`;
- aliases set up only in a bundler config.

For those, build the file and pass the output (`--config
dist/memory.js`), or call [`migrate({ memory })`](./postgres.md#migrate-from-code)
from a script of your own.

Loading the file runs it. Whatever it does at the top level, such as
connecting or reading environment variables, happens.

### Environment variables

Before loading the memory file the command reads `.env` in the current
folder, when there is one. A variable that is already set keeps its value,
so real variables in CI or on a server win over the file. `--env-file
<path>` reads another file instead, and fails when it does not exist.

### Without a memory file

When there is no memory file, `migrate` and `check` connect to
`DATABASE_URL` with the `postgres` package from your project and take the
embedding size from `--dimensions`:

```bash
DATABASE_URL=postgres://… npx mnemocyte migrate --dimensions 1536
```

`--dimensions` is required only to create the schema; upgrading an existing
installation and `check` work without it. Without the `postgres` package
the command stops with an install hint.

## `migrate`

```bash
npx mnemocyte migrate [--config <path>] [--yes] [--dry-run] [--dimensions <n>]
```

Creates the schema in an empty database and applies pending migrations to
an existing one. It is [`migrate()`](./postgres.md#what-migrate-does) with
the store and embedding size from the memory file, and it changes nothing
when the schema is current, so run it on every deploy.

```txt
Using memory.ts
pgvector is not enabled in this database. Run CREATE EXTENSION vector now? [y/N] y
Enabled pgvector.
Applied: 0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2
```

- **pgvector.** When the extension is not enabled, `migrate` asks before
  running `CREATE EXTENSION vector`, which needs a superuser or your
  provider's admin role. `--yes` (`-y`) answers yes, for CI. On "no", or
  when there is no terminal to ask on, it changes nothing, prints the
  statement for an admin to run, and exits 1.
- **`--dry-run`** prints what would be applied and changes nothing. It
  asks no question.
- **`--dimensions <n>`** with a memory file must equal the embedder's.

## `check`

```bash
npx mnemocyte check [--config <path>] [--dimensions <n>]
```

Reads the database and reports what is installed. It changes nothing.

```txt
Using memory.ts
pgvector    0.8.7
migrations  4 of 4 applied
dimensions  1536 (vector)
model       text-embedding-3-small

ok
```

It exits 1, with one `problem:` line each, for anything that would make
your app throw:

- pgvector is not enabled, or is older than 0.8.0;
- the Mnemocyte tables are missing, or migrations are pending;
- the schema is one `migrate` refuses: it matches no migration, the
  recorded versions have gaps, or a newer Mnemocyte migrated the database;
- the installed dimensions differ from the embedder's (or `--dimensions`);
- the `installation` row of `mnemocyte_meta` is missing or contradicts the
  embedding column;
- the recorded embedding model differs from the embedder's.

Two states are reported as a `note:` and pass: a current schema that was
installed with `psql` (the next `migrate` only records it), and an empty
installation with no embedding model recorded yet.

Without a memory file there is no embedder to compare with, so only the
database's own state is judged, plus `--dimensions` when given.

## `sql`

```bash
npx mnemocyte sql --dimensions 768 --out migrations/mnemocyte.sql
```

Prints the schema a fresh install creates, for teams that apply SQL with
their own tools. It never queries a database. With `--dimensions` it loads
nothing; without it, the size is the embedder's in the memory file.
`--out <file>` writes a file instead of standard output. Above 2,000
dimensions the column is `halfvec`. How to apply the file is in the
[Postgres guide](./postgres.md#apply-the-sql-files-yourself).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done; `check` found no problem. |
| 1 | `check` found a problem, `migrate` failed or pgvector was not enabled. |
| 2 | The command could not run: an unknown flag, no memory file and no `DATABASE_URL`, a memory file that does not load, or, for `check`, a database it cannot read. |

Errors go to standard error as `mnemocyte: <message>`, followed by the
database driver's own message as `cause:`.

## In CI

```yaml
- run: npx mnemocyte migrate --yes
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
- run: npx mnemocyte check
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Set whatever your memory file reads when it loads; here that is the
database URL and the embedder's key. Leave out `--yes` when the deploy role
may not create extensions; `migrate` then fails with the statement to hand
to an admin instead of trying.

## Limits

- **PGlite.** A PGlite data folder opens in one process at a time, so run
  the command while the app is stopped, or call
  `migrate({ memory, createExtension: true })` when the app starts.
- **HTTP drivers.** `migrate` needs interactive transactions. With a
  stateless HTTP driver in the memory file, run `migrate` against a regular
  connection (`DATABASE_URL` and `--dimensions`, without `--config`, from a
  folder with no memory file).
- **`--env-file` and Node.** Node also reads `--env-file` from a script's
  arguments, so a file that does not exist is reported by Node itself
  (`node: nope.env: not found`, exit code 9) before the command starts.
- **Aliases that shadow packages.** The command asks Node to resolve an
  import first and applies `paths` only when Node finds nothing, so a
  `paths` entry with the name of an installed package is ignored.
