@AGENTS.md

# Mnemocyte

Memory for TypeScript AI apps that lives in the app's own database: no
service, no API key, no provider SDK. Callers bring the embedder and the
database; Mnemocyte adds scoped storage, hybrid recall, prompt-ready context
and maintenance (prune, dedup, consolidation, audit).

Today it is one ESM package (`mnemocyte`, 0.x) with an in-memory backend and a
Postgres + pgvector backend. The target design (zero-dependency core, driver
adapters, more SQL backends, AI SDK integration) is in
`docs/ARCHITECTURE.md`; the plan to get there is `docs/ROADMAP.md`.

## Read before starting work

- `docs/ROADMAP.md`: continue with the first unchecked item.
- `docs/DEVELOPMENT.md`: what is built today, conventions, testing, releasing.
- `docs/ARCHITECTURE.md`: the target design and the dated decisions behind it.
- `docs/features/<area>.md` for the area you touch.
- `README.md` and `docs/guide/` before changing anything users see.

## Rules

- ESM-only, strict TypeScript. No `any` without a written reason, no
  `@ts-ignore` or `@ts-nocheck`.
- Public API additions take a single object parameter.
- The client never creates extensions, tables or indexes as a side effect.
  Schema changes ship as explicit, numbered migrations.
- Never hold a database transaction open across an embedder or other network
  call.
- The root `mnemocyte` import stays provider-free. No provider SDKs anywhere;
  embedders use `fetch`. Optional integrations (AI SDK, drivers) are optional
  peer dependencies behind subpaths.
- Every query that reads or writes memories is scoped. A global operation
  needs an explicit opt-in in its input.
- Unstable API lives under `client.experimental.*`.
- The storage contract is named `MemoryStore`; do not call it `Store`.
- Postgres index changes need `EXPLAIN (ANALYZE, BUFFERS)` evidence on
  representative data and a written tradeoff.
- Tests use Vitest `expect`; no `node:assert`.
- Docs follow the code: when an `ARCHITECTURE.md` item lands, move its section
  to `DEVELOPMENT.md` (or `docs/features/`) in the same PR, tick it in
  `ROADMAP.md`, and add a `CHANGELOG.md` entry if users can see the change.

## How we work

- Before building, read the official docs for what the change touches
  (Postgres, pgvector, postgres.js, Drizzle, the AI SDK, provider APIs). Use
  official sources for versions and migration guides, not memory.
- Ask only the decisions that are the maintainer's to make, each with a
  recommendation. Then sum up the plan and wait for "go".
- One roadmap item per branch and PR.
- Before reporting, run `pnpm checktypes`, `pnpm lint`, `pnpm test` and
  `pnpm build`. Say which ones ran.
- Reports are short: what changed, what was checked, what was not.
- Name concepts when explaining a change (for example a `SELECT … FOR UPDATE`,
  an HNSW index, reciprocal rank fusion) and say briefly why they matter.

## Git workflow

- Work on a branch named `feat/…`, `fix/…`, `docs/…` or `chore/…`; never
  commit to `main`.
- Commit messages and PR titles: `type(scope): summary`, lower case, 3–7
  words, at most 50 characters, one line, no body, no co-author lines.
- PR body: 3–6 bullets.
- Ask before every commit.
- To merge: push, open the PR, wait for CI to pass, squash merge with
  `--delete-branch`, then pull `main`.
