# CLI

The `mnemocyte` bin: `migrate`, `check` and `sql`. The user reference is
[guide/cli.md](../guide/cli.md); this page is how it is built and why.

## Packaging

- `package.json` has `"bin": { "mnemocyte": "./dist/cli.mjs" }`. The bin is
  not in `exports`: nothing in `src/cli/` is public API.
- `src/cli.ts` is a tsdown entry. Its `#!/usr/bin/env node` line is kept in
  `dist/cli.mjs`, and tsdown marks the file executable. tsdown also writes
  an empty `dist/cli.d.mts`, which nothing references.
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
  io.ts                  CliIo (cwd, write, error, confirm), CliError, the process's own CliIo
  memory-file.ts         where the memory file is looked up, loading it, reading the client
  resolve-hook.ts        the resolve hook for a TypeScript app's imports
  tsconfig.ts            JSON with comments, `extends`, `paths`
  target.ts              .env, then a memory file or DATABASE_URL → what a command runs against
  migrate.ts             migrateTarget / migrateCommand
  check.ts               evaluateInstallation, describeInstallation, checkTarget / checkCommand
  sql.ts                 sqlCommand
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
`max: 1` and no notice output, wrapped by `resolveStore`, and ended by the
command.

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
- when no migration is pending, the `installation` row, and the stored
  models when the row records none.

`evaluateInstallation` (pure, unit-tested) turns the report into problems
and notes. A problem is what makes the app throw (the maintainer's choice,
2026-11-14): pgvector missing or older than 0.8.0, no tables, pending
migrations, an invalid schema, dimensions that differ from the embedder's
or `--dimensions`, a missing or contradicting installation row, a recorded
model that differs. For an unrecorded model it follows the client: one
stored model is what the client would record and then compare; several are
a problem. Notes pass: an untracked but current schema, and an empty
installation without a model.

Exit 1 on a problem. A report that cannot be read (no connection) is exit
2, so CI can tell "wrong" from "could not look".

## `sql`

`renderInitialSchema(dimensions)`, the string the runner applies on a fresh
install and that `fresh-install.sql` holds at 1536. `--dimensions` alone
imports nothing else; without it the memory file is loaded for
`embedder.dimensions`. `migrations/render-initial.mjs` still ships, for
anyone who calls it by path, and `pnpm migration:render` still uses it.

## Exit

`src/cli.ts` ends the process with `process.exit(code)`: the CLI does not
own the app's database client and cannot close it, and an open pool would
keep Node alive. Before exiting it writes an empty string to each output
stream and exits in the callback, because pipes are asynchronous on
Windows and an immediate exit can cut output short.

## Tests

- `test/cli/` (unit): argument parsing, `parseJsonc`, `paths` through
  `extends`, import candidates and `resolveAppImport` on temporary folders,
  memory file lookup, every `check` verdict, `main` for help, usage errors
  and `sql`, and error printing.
- `test/contract/cli.test.ts` (PGlite, in process): `migrateTarget` with a
  terminal that says yes, no, or is absent, `--yes`, `--dry-run`; `check`
  on a fresh, adopted, behind, untracked and broken schema, with a recorded
  model and with mismatches.
- `test/package/cli.test.ts`: runs `dist/cli.mjs` as a child process in
  temporary projects whose `node_modules` link to this package. One project
  has a TypeScript memory file on PGlite with a `.js` import, an
  extensionless folder import and a `paths` alias behind an `extends`, and
  goes through `check`, `migrate --dry-run`, `migrate` without a terminal,
  `migrate --yes`, `check` and `sql`, with `.env` supplying the embedder's
  size. This is the test of type stripping and the resolve hook on each CI
  Node version. It also checks the shebang, the `bin` field, that the bin
  imports no driver, and the load errors.
- `test/integration/cli.test.ts`: `main` in process against real Postgres
  through `DATABASE_URL`: fresh install, the missing `--dimensions`,
  `halfvec`, the extension question after `DROP EXTENSION vector`, and an
  unreachable database. Like `migrate.test.ts` it drops the Mnemocyte
  tables and the extension, and leaves a tracked 1536-dimension schema.

## Known limits

- The interactive prompt itself (a real terminal) is not tested; the code
  behind `io.confirm` is.
- The hook is not consulted for imports made from inside `node_modules`.
- `module.registerHooks` is "active development" on Node 22 and a release
  candidate from 24.13.1 and 25.4; type stripping is a release candidate on
  Node 22.
