# CLI

`mnemocyte` is a command that ships with the package. It writes a starting
memory file, creates and upgrades the Postgres schema, checks an
installation, prints the schema as SQL or as a Drizzle schema, and changes
the keyword search language. It uses the memory client your
app already exports, so the command and the app share one database client
and one embedder.

```bash
pnpm exec mnemocyte init
pnpm exec mnemocyte migrate
pnpm exec mnemocyte check
pnpm exec mnemocyte sql --dimensions 1536
```

These guides use pnpm. Each package manager runs the copy installed in
your project: `pnpm exec mnemocyte` with pnpm, `npx mnemocyte` with npm and
`yarn mnemocyte` with Yarn. Use the one your project uses. In a project
whose `package.json` names pnpm in `devEngines`, which `pnpm init` writes,
npm refuses to run `npx` and fails with `EBADDEVENGINES`. The command needs
Node.js 22.18 or newer, like the package.

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

Before loading the memory file the command reads `.env.local`, then
`.env`, from the current folder, each when it exists. This is the order
Next.js uses, so a Next.js app needs no flag. When both files set a
variable, `.env.local` wins. A variable that is already set keeps its
value, so real variables in CI or on a server win over both files.

When `NODE_ENV` is `test`, `.env.local` is skipped, as in Next.js, so tests
get the same values on every machine. The `.env.development`,
`.env.production` and `.env.test` files, and their `.local` versions, are
not read: the command does not run in a mode, and guessing one could pick
the wrong file.

`--env-file <path>` reads that one file instead, and fails when it does
not exist.

### Without a memory file

When there is no memory file, `migrate` and `check` connect to
`DATABASE_URL` with the `postgres` package from your project and take the
embedding size from `--dimensions`:

```bash
DATABASE_URL=postgres://… pnpm exec mnemocyte migrate --dimensions 1536
```

`--dimensions` is required only to create the schema; upgrading an existing
installation and `check` work without it. Without the `postgres` package
the command stops with an install hint.

### Stores that cannot migrate

Neon's `neon()` function, a Drizzle `neon-http` `db` and other
batch-only `SqlExecutor`s have no interactive transactions, which
`migrate` and `text-search` need. With such a memory file they open a
connection of their own, run there, and close it:

- for Neon, Neon's `Pool` on `DATABASE_URL_UNPOOLED`, the direct
  connection string Neon's Vercel integration sets, or on `DATABASE_URL`
  when that one is not set;
- for any other store, the `postgres` package on `DATABASE_URL`.

The embedding size and the schema name still come from the memory file,
so the app and the migration agree. The command says which variable it
used and never prints the URL:

```txt
Using src/lib/memory.ts
Connecting with Neon's Pool on DATABASE_URL_UNPOOLED: The store in src/lib/memory.ts uses Neon's HTTP driver, which cannot run migrations: they need a transaction on one connection.
Applied: 0000_initial, …
```

Before it changes anything, the command reads the installation through
both connections. When they differ, the URL points at another database:
it exits 2 with nothing changed and prints what each one sees. Two
identical installations, such as a new Neon branch and its parent, look
the same, so after the change it reads again through the memory file's
client and exits 1 when that client does not see it. Without the URL
variable, or without the driver package, the command exits 2 and says
what to set or install. `check` only reads, so it uses the memory file's
own client.

A libSQL database needs a memory file: the command has no libSQL
connection of its own. `migrate`, `check` and `text-search` work with one
([libsql.md](./libsql.md#install-the-schema)); `sql`, `generate` and
`init` are Postgres only.

If the tables live in [a schema of their own](./postgres.md#keep-the-tables-in-their-own-schema),
add `--schema <name>` to `migrate`, `check`, `sql` and `text-search`. With
a memory file, the schema comes from its `postgresStore({ schemaName })`,
and `--schema` may only repeat it; a different name exits 2.

## `init`

```bash
pnpm exec mnemocyte init [--embedder <openai|openai-compatible>] [--dry-run]
```

Writes `memory.ts` in the project root, the file `migrate` and `check`
then load, and adds `OPENAI_API_KEY=` to `.env.local` when your project
has one, as a Next.js app does, or else to `.env`. Run it in the folder with
your `package.json`. For a local model, see
[A local Ollama](#a-local-ollama).

```txt
Found drizzle-orm, postgres in package.json: using Drizzle on postgres.js.
Wrote memory.ts
Created .env with OPENAI_API_KEY=

Next:
  Put your OpenAI API key after OPENAI_API_KEY= in .env
  Add DATABASE_URL=postgres://… to .env
  Create the schema: pnpm exec mnemocyte migrate
```

The last hint names the runner of your project's package manager. `init`
takes it from `devEngines.packageManager` or `packageManager` in
`package.json`, else from the lockfile, else it names `npx`. The example
above is from a pnpm project.

- **The driver** comes from `dependencies` and `devDependencies`. With
  `drizzle-orm`, the file uses Drizzle over the driver next to it:
  `postgres`, else `pg`, else `@electric-sql/pglite` (`postgres` when there
  is none, with an install hint). Without Drizzle the order is `postgres`,
  `pg`, `@electric-sql/pglite`. Without any of them the file uses the
  in-memory backend; to switch later, install a driver, delete
  `memory.ts` and run `init` again.
- **The file** is the matching one from
  [Getting started](./getting-started.md#4-write-memoryts) with
  `openaiEmbedder` and `text-embedding-3-small`, and `namespace` set to
  your package's `name` (`"my-agent"` without one). Change the embedder
  before the first `migrate`: the schema is created for its dimensions.
- **The env file.** When neither `.env.local` nor `.env` defines
  `OPENAI_API_KEY` (an empty value counts as defined), `init` appends the
  line to `.env.local` if it exists, else to `.env`, which it creates when
  needed. A key in `.env` counts even when `.env.local` exists, because an
  empty line in `.env.local` would hide it. Other lines are not touched.
  `init` prints a note when `.gitignore` has no line for the file it wrote
  to (`.env*` covers both).
- **It never overwrites.** A memory file that already exists anywhere
  `migrate` looks (`memory.ts`, `.mts`, `.js` or `.mjs` in the root,
  `lib/`, `src/` or `src/lib/`) is left as is, and so is a defined
  `OPENAI_API_KEY`; a second run changes nothing.
- **`--dry-run`** prints the file and the env file change and writes
  nothing.
- **`"type": "module"`.** Without it in `package.json`, Node still loads
  `memory.ts` as an ES module but warns on every run, so `init` prints a
  note with `npm pkg set type=module`.

### A local Ollama

`--embedder openai-compatible` writes the same file with the embedder from
[Use Ollama instead of OpenAI](./getting-started.md#use-ollama-instead-of-openai):
`openaiCompatibleEmbedder` with `nomic-embed-text` (768 dimensions) at
`http://localhost:11434/v1`. A local server needs no key, so `init` leaves
the env files alone:

```bash
pnpm exec mnemocyte init --embedder openai-compatible
```

```txt
Found postgres in package.json: using postgres.js.
Embedder: nomic-embed-text (768 dimensions) on a local Ollama at http://localhost:11434/v1.
Wrote memory.ts

Next:
  Add DATABASE_URL=postgres://… to .env
  Pull the model: ollama pull nomic-embed-text (for another server, change baseURL, model and dimensions in memory.ts first)
  Create the schema: pnpm exec mnemocyte migrate
```

For LM Studio, vLLM or another OpenAI-compatible server, change `baseURL`,
`model` and `dimensions` in `memory.ts` before the first `migrate`, and add
`apiKey` if the server needs one (see the
[embedders guide](./embedders.md#openaicompatibleembedder)).
`--embedder openai` is the default. Other embedders are not offered yet:
write the default file and swap the embedder by hand.

## `migrate`

```bash
pnpm exec mnemocyte migrate [--config <path>] [--yes] [--dry-run [--json]] [--dimensions <n>] [--text-search-config <name>] [--schema <name>]
```

Creates the schema in an empty database and applies pending migrations to
an existing one. It is [`migrate()`](./postgres.md#what-migrate-does) with
the store and embedding size from the memory file, and it changes nothing
when the schema is current, so run it on every deploy.

```txt
Using memory.ts
pgvector is not enabled in this database. Run CREATE EXTENSION vector now? [y/N] y
Enabled pgvector.
Applied: 0000_initial, 0001_add_mnemocyte_meta, 0002_add_embedding_model, 0003_schema_v2, 0004_audit_memory_id
```

- **pgvector.** When the extension is not enabled, `migrate` asks before
  running `CREATE EXTENSION vector`, which needs a superuser or your
  provider's admin role. `--yes` (`-y`) answers yes, for CI. On "no", or
  when there is no terminal to ask on, it changes nothing, prints the
  statement for an admin to run, and exits 1.
- **`--dry-run`** prints what would be applied and changes nothing. It
  asks no question. Add `--json` to get the plan as
  [JSON](#json-output).
- **`--dimensions <n>`** with a memory file must equal the embedder's.
- **`--text-search-config <name>`** picks the
  [keyword search language](./postgres.md#keyword-search-language) of a
  new installation, such as `simple`; `english` without it. On an existing
  installation it must match the installed one, or `migrate` fails and
  changes nothing; `text-search` changes it.
- **A schema name.** With `schemaName` (or `--schema`), a fresh install
  creates the schema when it is missing and says so first:
  `Created the schema memory.` It will not install next to Mnemocyte
  tables that `search_path` finds in another schema; see
  [moving an installation](./postgres.md#move-an-existing-installation).

## `check`

```bash
pnpm exec mnemocyte check [--config <path>] [--dimensions <n>] [--text-search-config <name>] [--schema <name>] [--json]
```

Reads the database and reports what is installed. It changes nothing.
`--json` prints the same report as [JSON](#json-output).

```txt
Using memory.ts
pgvector    0.8.7
migrations  5 of 5 applied
dimensions  1536 (vector)
model       text-embedding-3-small
text search english

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
- the recorded embedding model differs from the embedder's;
- the keyword search language differs from `--text-search-config`, when
  you pass it.

With a schema name, the report starts with a `schema` line, such as
`schema      memory`, and looks only in that schema.

Two states are reported as a `note:` and pass: a current schema that was
installed with `psql` (the next `migrate` only records it), and an empty
installation with no embedding model recorded yet.

Without a memory file there is no embedder to compare with, so only the
database's own state is judged, plus `--dimensions` when given.

## `sql`

```bash
pnpm exec mnemocyte sql --dimensions 768 --out migrations/mnemocyte.sql
```

Prints the schema a fresh install creates, for teams that apply SQL with
their own tools. It never queries a database. With `--dimensions` it loads
nothing; without it, the size is the embedder's in the memory file.
`--out <file>` writes a file instead of standard output. Above 2,000
dimensions the column is `halfvec`. `--text-search-config <name>` sets the
[keyword search language](./postgres.md#keyword-search-language); Postgres
checks the name when you apply the file. With `--schema <name>`, or a
memory file whose store has a `schemaName`, the file starts with
`CREATE SCHEMA IF NOT EXISTS` and a `SET search_path` that puts the schema
first, so the tables land there. How to apply the file is in the
[Postgres guide](./postgres.md#apply-the-sql-files-yourself).

## `generate`

```bash
pnpm exec mnemocyte generate --adapter drizzle [--out <file>] [--dry-run] [--dimensions <n>] [--text-search-config <name>] [--schema <name>]
```

Writes the tables as a Drizzle schema, so drizzle-kit can create and
upgrade them with the rest of your schema. `drizzle` is the only adapter
for now. Like `sql`, it never queries a database, and it takes the size
from `--dimensions` or your memory file's embedder.

```txt
Wrote mnemocyte-schema.ts (1536 dimensions, text search configuration english).

Next, with drizzle-kit:
  1. Add "./mnemocyte-schema.ts" to schema in drizzle.config.ts.
  2. Unless pgvector is enabled already, run
       pnpm exec drizzle-kit generate --custom --name=pgvector
  ...
```

- **`--out <file>`** picks the path (default `mnemocyte-schema.ts`). Missing
  folders are created.
- **Running it again** replaces the file only when `generate` wrote it,
  and says so when nothing changed. Any other file at that path is left as
  is and the command exits 2. So is a file whose embedding size or schema
  differs from the new one, because an installation keeps both.
- **`--text-search-config <name>`** is `english` for a new file. When you
  run `generate` again, the file's own language stays unless you pass the
  flag, since changing it makes drizzle-kit rewrite the table. If the
  file's `content_tsv` line was edited by hand, `generate` exits 2 unless
  you pass the flag.
- **`--dry-run`** prints the file to standard output and the steps to
  standard error, and writes nothing. It shows the language of the
  existing file, or `english` with a note when it cannot read it.
- It prints the SQL drizzle-kit cannot write, for two custom migrations:
  pgvector, then the key index and the installation row. The whole setup,
  and what to do after an upgrade, is in the
  [Postgres guide](./postgres.md#manage-the-tables-with-drizzle-kit).

## `text-search`

```bash
pnpm exec mnemocyte text-search <name> [--config <path>] [--yes] [--dry-run [--json]] [--schema <name>]
```

Changes the [keyword search language](./postgres.md#keyword-search-language)
of an existing installation, for example from `english` to `simple`. It is
[`setTextSearchConfig()`](./api.md#settextsearchconfig) with the store from
the memory file.

```txt
Using memory.ts
Change keyword search from "english" to "simple"? This rewrites the memories table and rebuilds every index on it, the HNSW index included. Reads and writes of memories wait until it finishes, which can take minutes on a large installation. Every app process must run Mnemocyte 1.2 or later: 1.1 searches with "english" whatever the installation uses, so its keyword matches are lost. [y/N] y
Changed keyword search from "english" to "simple". Restart other app processes so their keyword search uses it. Every app process must run Mnemocyte 1.2 or later: 1.1 searches with "english" whatever the installation uses, so its keyword matches are lost.
```

- It asks before the rewrite. `--yes` (`-y`) answers yes, for CI; without
  it and without a terminal to ask on, it changes nothing and exits 1.
- **`--dry-run`** checks the name and the schema and says what would
  change. Add `--json` to get it as [JSON](#json-output).
- When the installation already uses that configuration, it says so,
  changes nothing and exits 0.
- Every migration must be applied first; run `migrate` before it.
- When the migrations are not recorded, as with drizzle-kit, it adds a
  note: change the language with
  `generate --adapter drizzle --text-search-config <name>` and
  `drizzle-kit generate` instead. Changing the column here leaves
  drizzle-kit's schema file behind.

## JSON output

`check --json`, `migrate --dry-run --json` and
`text-search <name> --dry-run --json` print one JSON object on
one line, so a CI step can read the result. The exit codes stay the same.

```bash
pnpm exec mnemocyte check --json
```

```json
{
  "command": "check",
  "ok": false,
  "target": "memory.ts",
  "backend": "postgres",
  "installation": {
    "schema": null,
    "pgvectorVersion": "0.8.7",
    "migrations": {
      "state": "tracked",
      "applied": ["0000_initial", "0001_add_mnemocyte_meta", "0002_add_embedding_model", "0003_schema_v2"],
      "pending": ["0004_audit_memory_id"]
    },
    "dimensions": 1536,
    "vectorType": "vector",
    "model": null,
    "textSearchConfig": null
  },
  "problems": [
    {
      "code": "MIGRATIONS_PENDING",
      "message": "1 migration is pending (0004_audit_memory_id). Run mnemocyte migrate."
    }
  ],
  "notes": []
}
```

(Shown on several lines here; the command prints one.)

- **`ok`** is true exactly when the exit code is 0.
- **`target`** is the memory file the command loaded, or `DATABASE_URL`.
  `migrate` and `text-search` also print **`connection`**: the variable
  the command connected with (`DATABASE_URL`, or `DATABASE_URL_UNPOOLED`
  for [a store that cannot migrate](#stores-that-cannot-migrate)), or
  `null` when the memory file's own client ran it.
  **`backend`** is `"postgres"`, `"libsql"`, `"in-memory"` or `"custom"`;
  on the in-memory backend and a custom store `installation` is `null`
  and `ok` is true.
- **`installation`** holds the facts the text prints. Anything missing is
  `null`. `migrations.applied` and `migrations.pending` are always there,
  and empty when `state` is `"none"` (no tables) or `"invalid"` (a schema
  `migrate` refuses). The other states are `"tracked"` and `"untracked"`
  (installed with `psql`). `model` is `null` until one is recorded, and
  `textSearchConfig` while migrations are pending. `schema` is the schema
  name the store or `--schema` gave, and `null` when the tables are found
  through `search_path`.
- **`problems`** fail the check and **`notes`** pass. Each has a `code` to
  branch on and a `message` for people:

  | Code | Problem |
  |---|---|
  | `PGVECTOR_MISSING` | pgvector is not enabled |
  | `PGVECTOR_OUTDATED` | pgvector is older than 0.8.0 |
  | `NOT_INSTALLED` | the Mnemocyte tables are missing |
  | `SCHEMA_INVALID` | a schema `migrate` refuses |
  | `MIGRATIONS_PENDING` | migrations are pending |
  | `DIMENSIONS_MISMATCH` | the installed dimensions differ from the embedder's or `--dimensions` |
  | `DIMENSIONS_FLAG_MISMATCH` | `--dimensions` differs from the embedder's |
  | `INSTALLATION_ROW_MISSING` | the `installation` row of `mnemocyte_meta` is missing |
  | `INSTALLATION_ROW_MISMATCH` | that row contradicts the embedding column |
  | `MODEL_AMBIGUOUS` | no model is recorded and the stored memories use several |
  | `MODEL_MISMATCH` | the recorded model differs from the embedder's |
  | `TEXT_SEARCH_CONFIG_MISMATCH` | the keyword search language differs from `--text-search-config` |

  The notes are `SCHEMA_UNTRACKED` (a current schema installed without
  `migrate`) and `MODEL_NOT_RECORDED` (an empty installation).

`migrate --dry-run --json` prints the plan, with the same fields as
[`migrate()`](./postgres.md#what-migrate-does) returns:

```json
{"command":"migrate","ok":true,"dryRun":true,"target":"memory.ts","backend":"postgres","connection":null,"applied":["0004_audit_memory_id"],"adopted":[],"extensionCreated":false,"schemaCreated":false,"upToDate":false}
```

`applied` is what a real run would apply, `adopted` what it would record
as already applied (a schema installed with `psql`), and
`extensionCreated` whether it would ask to enable pgvector, and
`schemaCreated` whether it would create the store's schema. `upToDate` is
true when a real run would change nothing. `connection` is described
under `target` above. `--json` works only with
`--dry-run`, because a real `migrate` may stop to ask a question.

`text-search <name> --dry-run --json` prints what
[`setTextSearchConfig()`](./api.md#settextsearchconfig) would return:

```json
{"command":"text-search","ok":true,"dryRun":true,"target":"memory.ts","backend":"postgres","connection":null,"previous":"english","current":"simple","changed":true}
```

`previous` and `current` are `null` on the in-memory backend. `--json`
needs `--dry-run` here too.

When the command cannot run, for example when the database cannot be
reached, it still prints one object, and the usual message goes to
standard error:

```json
{"command":"check","ok":false,"error":{"message":"Could not read the database, so nothing was checked.","code":"DB","causes":["Could not inspect the Postgres installation.","ECONNREFUSED"]}}
```

`code` and `reason` are the [`MnemocyteError`](./api.md#errors) ones, when
the error has them. A mistake on the command line itself, such as an
unknown flag, prints no JSON.

Good to know:

- **The last line.** Loading the memory file runs it, so anything it
  prints (a `console.log` at the top level) comes before the JSON. Read
  the last line of standard output.
- **What stays the same.** Field names, their types and the codes are
  covered by [semver](./api.md#stability). The `message` text is not, so
  branch on `code`. A minor release may add fields and codes, so treat an
  unknown problem code as a problem.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done; `check` found no problem; `init` also when it left existing files as they were. |
| 1 | `check` found a problem, `migrate` or `text-search` failed, pgvector was not enabled, the rewrite was not confirmed, or the memory file's client does not see the change made over the command's own connection. |
| 2 | The command could not run: an unknown flag, no memory file and no `DATABASE_URL`, a memory file that does not load, no readable `package.json` for `init`, a file `generate` would not replace, for `check` a database it cannot read, or, for a [store that cannot migrate](#stores-that-cannot-migrate), no URL variable, no driver package or a URL that reaches another installation. |

Errors go to standard error as `mnemocyte: <message>`, followed by the
database driver's own message as `cause:`. With `--json` they also go to
standard output as [JSON](#json-output).

## In CI

```yaml
- run: pnpm exec mnemocyte migrate --yes
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
- run: pnpm exec mnemocyte check
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Set whatever your memory file reads when it loads; here that is the
database URL and the embedder's key. Leave out `--yes` when the deploy role
may not create extensions; `migrate` then fails with the statement to hand
to an admin instead of trying.

To read the result in a later step, use `--json`. This step fails when a
deploy would run a migration, using `jq -e`, which exits 1 on `false`:

```yaml
- run: pnpm exec mnemocyte migrate --dry-run --json | tail -n 1 | jq -e '.upToDate'
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Limits

- **PGlite.** A PGlite data folder opens in one process at a time, so run
  the command while the app is stopped, or call
  `migrate({ memory, createExtension: true })` when the app starts.
- **HTTP drivers.** With a memory file whose store is Neon's `neon()` (or
  another batch-only `SqlExecutor`), `migrate` and `text-search` need a
  URL variable to open [a connection of their own](#stores-that-cannot-migrate).
  The check that it reaches the app's database compares installations, so
  two identical ones are told apart only after the change.
- **libSQL.** Only through a memory file, for `migrate`, `check` and
  `text-search`. `--schema` exits 2 with a libSQL store, and
  `--dimensions` stops at 4,000.
- **`--env-file` and Node.** Node also reads `--env-file` from a script's
  arguments, so a file that does not exist is reported by Node itself
  (`node: nope.env: not found`, exit code 9) before the command starts.
- **`$VAR` in env files.** Next.js expands `$VARIABLE` references inside
  its env files. The command reads them with Node's parser, which does
  not, so `URL=https://x.com/$USER` stays as written. Spell the value out
  in the file the command reads.
- **Aliases that shadow packages.** The command asks Node to resolve an
  import first and applies `paths` only when Node finds nothing, so a
  `paths` entry with the name of an installed package is ignored.
