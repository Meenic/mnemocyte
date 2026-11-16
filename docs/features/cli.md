# CLI

The `mnemocyte` bin: `init`, `migrate`, `check`, `sql`, `generate` and
`text-search`.
The user reference is
[guide/cli.md](../guide/cli.md); this page is how it is built and why.

## Packaging

- `package.json` has `"bin": { "mnemocyte": "./dist/cli.mjs" }`. The bin is
  not in `exports`: nothing in `src/cli/` is public API.
- `src/cli.ts` is a tsdown entry. Its `#!/usr/bin/env node` line is kept in
  `dist/cli.mjs`, and tsdown marks the file executable. The
  `drop-cli-declarations` plugin in `tsdown.config.ts` deletes the empty
  `dist/cli.d.mts` tsdown would write, which nothing references; a
  separate build for the bin would instead duplicate the shared chunks.
- No new dependency. Arguments are parsed with `node:util` `parseArgs`,
  the prompt is `node:readline`, the `.env` file is read with
  `process.loadEnvFile`.
- The entry has no top-level `await`, like the rest of `dist/`, and reads
  the version from `../package.json`, which is the package root from both
  `src/cli.ts` and `dist/cli.mjs`.
- The bin shares chunks with the root entry. `renderInitialSchema` and the
  bundled SQL moved into a chunk of their own that the bin imports
  statically; the root entry still reaches them only through the dynamic
  `import()` of the Postgres backend, which a package test checks.

## Structure

```txt
src/cli.ts               the bin: version, process I/O, exit
src/cli/
  main.ts                main(argv, io, version) → exit code; error printing
  args.ts                parseCliArgs, USAGE
  io.ts                  CliIo (cwd, write, error, confirm), CliError, errorCauses, the process's own CliIo
  json.ts                what --json prints: CheckJson, MigratePlanJson, TextSearchPlanJson, ErrorJson, writeJson, errorJson
  memory-file.ts         where the memory file is looked up, loading it, reading the client
  resolve-hook.ts        the resolve hook for a TypeScript app's imports
  tsconfig.ts            JSON with comments, `extends`, `paths`
  target.ts              .env, then a memory file or DATABASE_URL → what a command runs against
  init.ts                chooseDriver, renderMemoryFile, planEnvChange, initCommand
  migrate.ts             migrateTarget / migrateCommand
  check.ts               evaluateInstallation, describeInstallation, installationJson, checkTarget / checkCommand
  sql.ts                 resolveSchemaShape (shared with generate), sqlCommand
  drizzle.ts             renderDrizzleSchema, renderDrizzleSetupSql, renderDrizzleTextSearchIndexSql, readDrizzleSchemaShape
  generate.ts            generateCommand and the steps it prints
  text-search.ts         textSearchTarget / textSearchCommand
src/db/migrations/inspect.ts   inspectPostgresInstallation: the facts check reports
src/db/pgvector.ts             assertPgvectorVersion (shared with the store)
```

`main` never exits the process and never rejects; it resolves with the exit
code, and every command writes through a `CliIo`. Tests therefore run
commands in process with a recording `CliIo` (`test/cli/io.ts`). Only
`src/cli.ts` touches `process.exit`.

## Loading the memory file

The CLI has no config format of its own (ARCHITECTURE decision 20): it
imports the app's memory file and reads the store and embedder that
`createMemory` attached under `Symbol.for("mnemocyte.memory-client")`
(`readMemoryClientInternals`), the same way `migrate({ memory })` does. A
`Symbol.for` key means a client built by the app's copy of the package is
readable by the bin's copy.

- **Lookup.** `memory.ts`, `memory.mts`, `memory.js`, `memory.mjs` in `.`,
  `lib`, `src`, `src/lib`, folder first; or `--config`, which must be a
  file. The client is the `memory` export, else the default export's
  `memory` (a CommonJS file's `module.exports`), else the default export.
- **TypeScript.** The file is loaded with a dynamic `import()` of its file
  URL. Node removes the types itself (type stripping: on by default from
  22.18, release candidate there, stable from 24.12). Node refuses to strip
  files under `node_modules`, which is why the bin is built JavaScript and
  only the app's own files are TypeScript.
- **The resolve hook.** Type stripping needs full specifiers and reads no
  `tsconfig.json`, so `./db`, `./db.js` for `db.ts` and `@/lib/db` fail.
  `registerAppResolver` installs a synchronous `resolve` hook with
  `module.registerHooks` (see decision 36 for why not `module.register`).
  The hook calls Node's resolution first and only acts when that throws,
  for an importer that is a file outside `node_modules`:
  - a relative specifier is resolved against the importer and tried as
    itself, as `.ts` for `.js` (`.mts` for `.mjs`, `.cts` for `.cjs`), with
    each of `.ts .mts .cts .js .mjs .cjs` appended, and as a folder's
    `index.ts`, `index.mts`, `index.js` or `index.mjs`;
  - any other specifier goes through `compilerOptions.paths` of the nearest
    `tsconfig.json` above the importer (cached per folder), and each
    target gets the same candidates.

  Because Node goes first, the hook cannot change how a package or an
  existing file resolves. The price is that a `paths` entry named like an
  installed package is ignored, where TypeScript would prefer it.
- **`tsconfig.json`.** `parseJsonc` drops comments and trailing commas with
  a scanner that copies string literals whole. `extends` is followed for
  relative paths (with or without `.json`) and for packages (through
  `createRequire`), with a cycle guard. As in TypeScript, a config's own
  `paths` replace the inherited ones, and targets are relative to `baseUrl`
  when set, otherwise to the folder of the config that defines `paths`.
  The longest matching prefix wins. A config that cannot be read or parsed
  contributes nothing. `baseUrl` on its own (bare imports relative to it)
  is not resolved.
- **Errors.** `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (enum, namespace,
  parameter properties), `ERR_UNKNOWN_FILE_EXTENSION` (`.tsx`, or type
  stripping turned off) and `ERR_MODULE_NOT_FOUND` each get a message that
  names the file and points to `--config <built .js>`; anything else is
  "Loading *file* failed" with the first line of the error. All exit 2.

## `.env`

`loadEnvironment` runs before the memory file is imported: `--env-file`
when given, else `./.env` when it exists. `process.loadEnvFile` does not
override a variable that is already set. Node also scans a script's own
arguments for `--env-file` (observed on 24.22 and 26.5): with a missing
file Node exits 9 with its own message before the bin's code runs, and
with an existing file it does not apply it, so the bin still loads it. The
bin's own check (exit 2) covers a Node that does not scan.

## Without a memory file

`resolveTarget` falls back to `DATABASE_URL` and postgres.js. The package
is resolved at run time with `createRequire(…).resolve("postgres")`, first
from the project, then from the bin's own location (under pnpm an optional
peer is linked next to the package), and imported by path. There is no
`import("postgres")` in the build, so the package keeps zero dependencies
and the "no driver import" package tests hold. The client is created with
`max: 1` and no notice output, wrapped by `resolveStore` (with `--schema`
as the store's `schemaName`), and ended by the command. `migrate` and
`text-search` pass that store to the public functions as a store config
(`DatabaseUrlTarget.storeConfig`), so they use the same schema.

## `--schema`

`--schema <name>` is for `migrate`, `check`, `sql` and `text-search`, and
`parseCliArgs` checks it with the same `assertSchemaName` as
`postgresStore()`, as a usage error (exit 2). With a memory file the
store already knows its schema: `MemoryStore.schemaName`, which
`createPostgresStore` and the lazy client store set, is what the CLI reads.
`assertSchemaFlag` allows the flag only when it repeats that name, and
exits 2 otherwise, so the file stays the one place the schema is set. A
store from an older copy of the package has no `schemaName` and counts as
none.

## `init`

`initCommand` reads `package.json` and nothing else of the app: it loads
no memory file and no `.env` into the environment, and it connects to
nothing, so it takes only `--dry-run` and `--embedder` (`--config`,
`--env-file` and `--dimensions` are usage errors).

- **Driver.** `chooseDriver` (pure) looks at the keys of `dependencies`
  and `devDependencies`. `drizzle-orm` wins and wraps `postgres`, else
  `pg`, else `@electric-sql/pglite`, else `postgres` with an install hint;
  without Drizzle the order is `postgres`, `pg`, PGlite; without a driver
  it is the in-memory file (the maintainer's choices, decision 37). A
  PGlite file without `@electric-sql/pglite-pgvector` listed gets an
  install hint too, in the package manager the lockfile names.
- **Templates.** `renderMemoryFile` builds each file from its imports,
  client setup (exported, so a script can end the client) and `store`
  expression.
  `test/cli/init.test.ts` takes every `memory.ts` block from
  `docs/guide/getting-started.md` and checks that the seven templates,
  with namespace `"my-agent"`, are exactly those blocks, so the guide and
  `init` cannot drift. The namespace is `package.json` `name` through
  `JSON.stringify`.
- **Embedder.** `--embedder` takes `openai` (the default) or
  `openai-compatible` (`INIT_EMBEDDERS`; anything else exits 2, and the
  flag on another command is a usage error). Each entry of `EMBEDDERS`
  holds the import, the `embedder:` property, the `.env` variable (none
  for `openai-compatible`) and its output lines. `renderMemoryFile` swaps
  the `openaiEmbedder` import and property, so every driver template
  works with every embedder. The guide has whole files only for
  `openaiEmbedder`; for the other, the test takes the Ollama block of
  getting-started (an import and an `embedder:` property) and checks that
  each `openai-compatible` file is the `openai` one with those two
  swapped. Decision 48 has the maintainer's choices.
- **No overwrite.** `findMemoryFile` runs first: a file anywhere the CLI
  looks is kept, because a new `./memory.ts` would hide `src/memory.ts`
  from `migrate`. `memory.ts` and a new `.env` are then created with
  `writeFile(…, { flag: "wx" })`, which is `O_CREAT | O_EXCL`: the
  operating system refuses if the file appeared after the check. An
  `EEXIST` on `memory.ts` is reported as "exists, left as is".
- **`.env`.** `planEnvChange` (pure) parses the file with `util.parseEnv`
  (from Node 20.12; no longer experimental from 22.21 and 24.10, and
  Node's own `.env` parser, so `export` and quotes read as
  `process.loadEnvFile` reads them). A defined variable (`OPENAI_API_KEY`
  for the default embedder), even empty, means no change; otherwise one
  line is appended in the file's own line ending (CRLF when the file has
  one), after a line break when the last line has none. With an embedder
  that has no variable, `init` never writes `.env` and prints nothing
  about it; it still reads it for the `DATABASE_URL` hint. `.gitignore` is only read: a line `.env`, `/.env`, `.env*`,
  `*.env` or `*` counts as ignoring it.
- **`"type"`.** Without `"type": "module"`, Node loads an ESM `memory.ts`
  through syntax detection and prints `MODULE_TYPELESS_PACKAGE_JSON` on
  every run (observed on 24.22), so `init` prints a note.
- **Output.** One line per change or kept file on stdout, then a "Next"
  list built from what is missing: install hints, an empty key,
  `DATABASE_URL` for a server driver when `.env` has none, the embedder's
  own step (`ollama pull nomic-embed-text`), `migrate`.
  `--dry-run` prints the file's content instead of writing it. The exit
  code is 0 unless `package.json` is missing or not a JSON object (2).

## `migrate`

`migrateTarget` calls the public `migrate()`:

1. A dry run with `createExtension: true`. Its `extensionCreated` is true
   exactly when pgvector is missing on a fresh install, which is the only
   place the runner would create it. `--dry-run` prints this plan and
   stops.
2. When pgvector is missing and `--yes` is not set, `io.confirm` asks. It
   resolves `undefined` when stdin or stdout is not a terminal, so CI never
   waits. Anything but yes prints the `CREATE EXTENSION` statement and
   returns 1, with nothing changed.
3. The real run, with `createExtension` only when the plan needed it.

With a schema name, `schemaCreated` in the plan prints "Would create the
schema *name*." and the run "Created the schema *name*.", before the
other lines. Creating a schema needs no question: naming it is the
request, and it stays inside the database's own privileges.

With the `DATABASE_URL` target and no `--dimensions`, the runner's
`"VALIDATION"` for a fresh install becomes exit 2 naming `--dimensions`.
An in-memory client prints a note and returns 0.

The prompt uses `node:readline` with a `SIGINT` listener that closes it:
without one, Ctrl+C only pauses the input, and the app's pool would keep
the process alive. A closed prompt counts as "no".

## `check`

`MemoryStore.inspectInstallation()` returns an `InstallationReport`, or
`null` for a store without persistent schema. The Postgres one,
`inspectPostgresInstallation`, sends only `SELECT`s, takes no advisory lock
and needs no transaction, so it also works on a `batch`-only executor:

- `pg_extension.extversion` for `vector`;
- the embedding column's size and type from `pg_attribute`;
- the migrations, with the runner's own `readAppliedVersions`,
  `readCatalogState`, `installedVersion` and `assertContiguous`, so `check`
  and `migrate` cannot disagree about a schema: `none`, `tracked`,
  `untracked` or `invalid` (the runner's refusal, as the reason);
- when no migration is pending, the text search configuration from
  `content_tsv`'s generated expression (a missing column or an expression
  of another shape makes the migrations `invalid`), the `installation`
  row, and the stored models when the row records none.

The report carries the store's `schema` (null without one).
`describeInstallation` prints a `schema` line only when it is set, so the
default output did not change, and `check --json` always has
`installation.schema`.

`evaluateInstallation` (pure, unit-tested) turns the report into problems
and notes. A problem is what makes the app throw (the maintainer's choice,
2026-11-14): pgvector missing or older than 0.8.0, no tables, pending
migrations, an invalid schema, dimensions that differ from the embedder's
or `--dimensions`, a missing or contradicting installation row, a recorded
model that differs, a text search configuration that differs from
`--text-search-config`. For an unrecorded model it follows the client: one
stored model is what the client would record and then compare; several are
a problem. Notes pass: an untracked but current schema, and an empty
installation without a model.

Exit 1 on a problem. A report that cannot be read (no connection) is exit
2, so CI can tell "wrong" from "could not look".

Each problem and note is a `{ code, message }` (`CheckFinding`), one code
per branch of `evaluateInstallation`; the text output prints only the
message.

## `text-search`

`textSearchTarget` calls the public `setTextSearchConfig()`
(ARCHITECTURE decision 50):

1. A dry run, which checks the name against the database and the schema
   (every migration applied) under the migration advisory lock, and says
   whether anything would change. `--json` (with `--dry-run`) prints it as
   a `TextSearchPlanJson` and stops; so does `--dry-run` as text.
2. Nothing to change: it says so and returns 0, asking nothing.
3. Otherwise `io.confirm` asks, with the rewrite warning, unless `--yes`.
   No terminal or anything but yes returns 1 with nothing changed.
4. The real run, which prints the old and new names and asks to restart
   other app processes, since their stores cached the old configuration.

The name is the command's one positional argument; `parseCliArgs` stores
it as `textSearchConfig`, the field `--text-search-config` fills for
`migrate`, `check` and `sql`, and rejects `--text-search-config` and
`--dimensions` on `text-search`. An in-memory client prints a note and
returns 0.

`--text-search-config` elsewhere: `migrate` passes it to `migrate()`;
`sql` renders it into the schema without a database, so Postgres checks
the name when the file is applied; `check` compares it with the
installation's configuration after `normalizeTextSearchConfig` (unquoted
names fold to lower case, a `pg_catalog.` prefix is dropped), because
`check` sends only reads and never asks the server to resolve the name.

## `generate`

`generateCommand` writes the tables as a Drizzle schema for an app whose
migrations drizzle-kit runs (ARCHITECTURE decision 52). `--adapter` is
required and `drizzle` is its only value, so another format can be added
without changing what the bare command means.

- **Input.** `resolveSchemaShape`, shared with `sql`: `--dimensions`
  alone loads no file; otherwise the memory file gives
  `embedder.dimensions` and the store's `schemaName`, and `--schema` may
  only repeat it. `--text-search-config` defaults to `english`. Nothing
  connects to a database.
- **Rendering.** `renderDrizzleSchema` (pure) returns the module as text;
  nothing in the package imports drizzle-orm. It targets drizzle-orm
  0.45: `pgTable` (or `pgSchema(name).table` with a schema, exported as
  `mnemocyteSchema` so drizzle-kit writes `CREATE SCHEMA`), the array form
  of the extra config, `vector`/`halfvec` with `dimensions`, a `tsvector`
  `customType`, `generatedAlwaysAs(sql…)` for `content_tsv` and
  `memory_id`, `index().using()` with `.op("…_cosine_ops")` and `.where()`,
  `check()` and a named self `foreignKey()`. `tags` uses `.default([])`;
  ``sql`'{}'::text[]` `` gives the same catalog. Template text is escaped
  for a JavaScript template literal (backslash, backtick, `${`), because
  drizzle's `sql` tag reads the cooked strings, so any configuration name
  comes out as written.
- **What drizzle-kit cannot write.** `renderDrizzleSetupSql` returns the
  SQL for two custom migrations: `CREATE EXTENSION IF NOT EXISTS vector`
  before the tables, then `mnemocyte_memories_scope_key_idx` (partial and
  `NULLS NOT DISTINCT`, which drizzle-orm has only on unique constraints)
  and the `installation` row, with schema-qualified names.
- **Overwrite.** A file that starts with `DRIZZLE_SCHEMA_HEADER` is the
  command's own and may be replaced; any other file is kept (exit 2). An
  identical file prints "is up to date". `readDrizzleSchemaShape` reads
  the dimensions and schema back from the file's own lines; a different
  size or schema, or a file whose embedding line was edited, is exit 2.
  A new file is created with `wx` after `mkdir -p` of its folder.
- **Output.** The steps name the project's runner (`projectRunner` in
  `init.ts`: `pnpm exec`, `yarn`, `bunx` or `npx`, from `package.json`
  or the lockfile) and the path as `drizzle.config.ts` takes it (`./`,
  forward slashes). After a replace, the steps are `drizzle-kit generate`
  and `migrate`, plus `renderDrizzleTextSearchIndexSql` when the file did
  not contain the new `content_tsv` expression: drizzle-kit drops and adds
  the column, which drops its GIN index, and its snapshot still lists the
  index. `--dry-run` writes the file to stdout and the steps to stderr.

## `--json`

`check --json`, `migrate --dry-run --json` and
`text-search <name> --dry-run --json` print one result instead of the text
(ARCHITECTURE decision 47). The shapes are the types in
`src/cli/json.ts`: `CheckJson`, `MigratePlanJson`, `TextSearchPlanJson` and
`ErrorJson`.

- **One line, last.** `writeJson` prints `JSON.stringify(value)` and a
  newline, and the `Using …` line is skipped. Loading the memory file runs
  it, so a top-level `console.log` in the app still reaches stdout first;
  a reader takes the last line.
- **`check`.** `installationJson` turns the report into
  `installation`: both migration lists are always present (empty for
  `none` and `invalid`), missing facts are `null`, and `model` is read the
  way the client reads it (recorded, else the first stored model).
  `installation` is `null` on the in-memory backend.
- **`migrate`.** `--json` needs `--dry-run`: a real run can ask about
  pgvector on stdout, which would break the JSON. `printPlanJson` reports
  the same dry run as the text (`planMigrate`), as `migrate()`'s
  `MigrateResult` plus `upToDate`; the in-memory backend gets an empty plan.
- **Errors.** When a command started with `--json` throws, `main` writes
  `errorJson(command, error)` to stdout and the usual text to stderr.
  `error.code` and `error.reason` come from the first `MnemocyteError` in
  the `cause` chain (a `CliError` wraps the store's error), and `causes`
  is the same list the text prints (`errorCauses` in `io.ts`). A bad
  command line fails in `parseCliArgs`, before the flag is known, and
  prints no JSON.

## `sql`

`renderInitialSchema(dimensions, textSearchConfig, schema)`, the string the
runner applies on a fresh install and that `fresh-install.sql` holds at
1536 and `english`. With a schema (`--schema`, or the memory file's
`schemaName`) the self foreign key names it, and the output starts with
`CREATE SCHEMA IF NOT EXISTS` and `SET search_path TO "<schema>", public`,
because the template's other names are bare; the comment above them says
to keep pgvector's schema on the path. `--dimensions` alone
imports nothing else; without it the memory file is loaded for
`embedder.dimensions`. It replaced `migrations/render-initial.mjs`, which
was removed for 1.0.

## Exit

`src/cli.ts` ends the process with `process.exit(code)`: the CLI does not
own the app's database client and cannot close it, and an open pool would
keep Node alive. Before exiting it writes an empty string to each output
stream and exits in the callback, because pipes are asynchronous on
Windows and an immediate exit can cut output short.

## Tests

- `test/cli/` (unit): argument parsing, `init` (driver choice, templates
  against the guide, `.env` plans, runs in temporary folders), `parseJsonc`, `paths` through
  `extends`, import candidates and `resolveAppImport` on temporary folders,
  memory file lookup, every `check` verdict and its code, `installationJson`,
  `main` for help, usage errors, `sql` and errors under `--json`, and error
  printing.
- `test/contract/cli.test.ts` (PGlite, in process): `migrateTarget` with a
  terminal that says yes, no, or is absent, `--yes`, `--dry-run`; `check`
  on a fresh, adopted, behind, untracked and broken schema, with a recorded
  model and with mismatches; `migrate --dry-run --json` and `check --json`
  as exactly one JSON line; `migrate --text-search-config` with `check`
  comparing it, and `text-search` with a yes, a no, no terminal, `--yes`,
  `--dry-run` and `--dry-run --json`; a memory file whose store has a
  `schemaName` through `migrate` and `check`, and `assertSchemaFlag`.
- `test/cli/generate.test.ts` (unit): the rendered text (`vector` and
  `halfvec`, `pgSchema`, a configuration name with a backtick, `${` and a
  backslash evaluated through a stand-in `sql` tag), the setup SQL, and
  the command's writes, replaces, refusals, `--dry-run`, `--out` and the
  printed runner.
- `test/contract/drizzle-schema.test.ts` (PGlite, drizzle-kit 0.31.11's
  `drizzle-kit/api`): each generated schema goes through
  `generateDrizzleJson` and `generateMigration` from an empty snapshot,
  between the two custom migrations, and its catalog (columns in order,
  defaults and generated expressions, constraints, indexes, the
  `installation` row) must equal a `migrate` fresh install at 1536, 3072
  (`halfvec`), `simple` and in a schema. `check` reports it untracked
  with no problem; a client's keyed `add` without `agentId` updates in
  place; a configuration change through drizzle-kit plus the printed
  index matches a fresh `simple` install; `pushSchema` would drop the key
  index (and sets the `text[]` default again, which changes nothing).
- `test/package/cli.test.ts`: runs `dist/cli.mjs` as a child process in
  temporary projects whose `node_modules` link to this package. One project
  has a TypeScript memory file on PGlite with a `.js` import, an
  extensionless folder import and a `paths` alias behind an `extends`, and
  goes through `check`, `migrate --dry-run`, `migrate` without a terminal,
  `migrate --yes`, `check` and `sql`, with `.env` supplying the embedder's
  size. This is the test of type stripping and the resolve hook on each CI
  Node version. Two more projects (PGlite, and Drizzle on PGlite) run
  `init --dry-run`, `init`, then `sql`, `migrate --yes` and `check` on the
  file `init` wrote, and `init` again. An in-memory project whose memory
  file prints a line runs `check --json` and `migrate --dry-run --json`
  and reads the JSON from the last line. A Drizzle project runs
  `generate --adapter drizzle`, with and without `--schema` and `--out`
  in a folder that does not exist, and type-checks both files with `tsc`
  (strict, `exactOptionalPropertyTypes`) against drizzle-orm 0.45.4. It also checks the shebang, the `bin` field, that the bin
  imports no driver, and the load errors.
- `test/integration/cli.test.ts`: `main` in process against real Postgres
  through `DATABASE_URL`: fresh install, the missing `--dimensions`,
  `halfvec`, the extension question after `DROP EXTENSION vector`, and an
  unreachable database, also with `check --json`. Like `migrate.test.ts` it drops the Mnemocyte
  tables and the extension, and leaves a tracked 1536-dimension schema.
  `test/integration/schema-name.test.ts` runs `migrate`, `check`,
  `text-search` and `sql` with `--schema` through `DATABASE_URL`.

## Known limits

- The interactive prompt itself (a real terminal) is not tested; the code
  behind `io.confirm` is.
- The hook is not consulted for imports made from inside `node_modules`.
- `module.registerHooks` is "active development" on Node 22 and a release
  candidate from 24.13.1 and 25.4; type stripping is a release candidate on
  Node 22.
