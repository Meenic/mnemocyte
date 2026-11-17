# FAQ

Short answers, with a link to the guide that has the details.

## Do I need Postgres?

No. Leave out `store` and memories live in process memory until the process
exits, which is enough for a prototype or a test. For memories that last,
use Postgres with pgvector 0.8.0 or later. PGlite runs it inside your
process, so a local setup needs no Docker. See
[prototype without a database](./getting-started.md#prototype-without-a-database)
and [PGlite](./getting-started.md#pglite).

Search differs a little between the two: Postgres matches keywords with
full-text search and the in-memory store with substrings
([limitations](./limitations.md#retrieval)).

## Which database drivers work?

postgres.js, a node-postgres `Pool`, PGlite, and Drizzle over any of the
three. A `pg.Client` and other Drizzle drivers throw `"CONFIG"`. For
anything else you can write a `SqlExecutor` by hand. See
[connect](./postgres.md#connect) and
[bring another driver](./postgres.md#bring-another-driver).

## Does it work with MySQL, SQLite or MongoDB?

Not yet. Postgres and the in-memory store are the only backends. A libSQL
backend is planned; see the [roadmap](../ROADMAP.md).

## Can I use it from CommonJS?

Yes, on Node.js 22.18 and later: `require("mnemocyte")` works, because
Node can `require()` ES modules. A TypeScript project needs
`module: "node20"` or `"nodenext"`. See
[CommonJS](./limitations.md#commonjs).

## Does Mnemocyte call an LLM?

No, unless you ask for it. It calls your embedder to turn text into
vectors, and your database to store and search them. The one feature that
calls a language model is extraction (`save: { model }` in `withMemory`),
which is off by default and uses the model and key you pass. See
[extracting memories with your model](./ai-sdk.md#extracting-memories-with-your-model).

## Where does my data go?

Memories are rows in your database. The text of a memory, and of every
query, goes to your embedder's provider when it is embedded. A local
embedder such as Ollama keeps it on your machine; see
[Use Ollama instead of OpenAI](./getting-started.md#use-ollama-instead-of-openai).

## Does it create tables for me?

No. Run `mnemocyte migrate` (or `migrate()` from code) on every deploy. See
[install the schema](./postgres.md#install-the-schema).

## Can I switch to another embedding model?

Not with a supported command. A Postgres installation stores one model and
one dimension count, and a different embedder throws `"CONFIG"`. To change,
either install in a fresh database and add the memories again, or, for a
model with the same dimensions, re-embed the rows by hand. See
[switching embedding models](./limitations.md#storage) and
[one embedding model per installation](./postgres.md#one-embedding-model-per-installation).
Pick the model before you store much.

## How do I build a multi-tenant app?

Use one `namespace` per tenant and an `entityId` per user. A read or write
never sees another namespace. Set a default with `createMemory({ namespace })`, or
pass `scope: { namespace, entityId }` per call, and bind a client per
request with `memory.for(...)`. Take the ids from your own session, never
from the request body. See [scopes](./api.md#scopes).

All tenants share one installation, so they share its embedding model and
keyword search language.

## How do I erase a user?

`memory.for({ entityId }).deleteScope()` deletes every memory of the user
across all agents and sessions, and their audit events. See the
[recipe](./recipes.md#erase-a-user).

## Can an agent read another agent's memories?

Not by default. Memories with an `agentId` are visible to that agent only,
and memories without one are shared by every agent of the entity. See
[scopes](./api.md#scopes).

## Do memories expire?

Only if you set `expiresAt`. Expired memories are left out of search, and
`prune({ expired: true })` deletes them. Mnemocyte holds no timers, so you
schedule the cleanup; see the [recipe](./recipes.md#nightly-maintenance).

## Can I use it without the AI SDK?

Yes. The AI SDK integration is optional and lives at `mnemocyte/ai-sdk`.
`context({ query })` returns a Markdown string you can put in any prompt,
and `search` returns the memories as objects.

## How do I handle errors?

Use `isMnemocyteError(error)` and branch on `error.code` and `error.reason`.
See [errors](./api.md#errors).

## What can change in a minor release?

Everything under `client.experimental`. The rest follows semver. See
[stability](./api.md#stability).

## More

- [Recipes](./recipes.md)
- [Limitations](./limitations.md)
- [Using Mnemocyte with AI coding tools](./ai-tools.md)
