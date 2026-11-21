# Contributing

Thanks for helping with Mnemocyte. This page covers the basics. The details
live in two places:

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): how the code is laid out, the
  conventions, testing and releasing.
- [docs/ROADMAP.md](docs/ROADMAP.md): the work queue. Pick the first
  unchecked item, or open an issue to talk about something else first.

Found a security problem? Don't open an issue. Follow
[SECURITY.md](SECURITY.md) instead.

## Set up

You need Node.js 22.18 or newer and pnpm (the version in `packageManager`
in the root `package.json`).

Install the dependencies:

```bash
pnpm install --frozen-lockfile
```

## Check your change

Run these before you open a pull request. CI runs the same checks and a
few more, for the parts of the repository your pull request changes:

```bash
pnpm checktypes
pnpm lint
pnpm test
pnpm build
```

`pnpm lint:fix` fixes what Biome can fix on its own.

The integration suite needs a Postgres database with pgvector that it can
throw away. It drops tables and extensions, so never point it at real data.
[DEVELOPMENT.md](docs/DEVELOPMENT.md#testing) shows how to run it against a
Docker container.

Changed the website in `apps/site/`? Run its checks too. Its own rules
are in [apps/site/AGENTS.md](apps/site/AGENTS.md):

```bash
pnpm --filter site lint
pnpm --filter site typecheck
pnpm --filter site test
pnpm --filter site build
```

## Branches, commits and pull requests

- Name the branch `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Commit messages and PR titles look like `type(scope): summary`: lower
  case, 3 to 7 words, at most 50 characters, one line. For example
  `fix(postgres): keep schema name in check`.
- Keep the PR body to 3 to 6 bullets.
- One roadmap item or one fix per pull request.
- If users can see the change, update the matching page in
  [docs/guide/](docs/guide/) and add an entry under `[Unreleased]` in
  [CHANGELOG.md](CHANGELOG.md).
