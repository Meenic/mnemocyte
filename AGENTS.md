# AGENTS.md

Guidance for AI agents working in this repository.

## Project

Mnemocyte is an ESM-only TypeScript memory library for AI applications.
The package is intentionally infrastructure-native:

- callers provide an `Embedder`
- Postgres + pgvector is the first persistent backend
- migrations are explicit and live in `migrations/`
- provider SDKs should not enter the core dependency graph
- future backend work should use the `MemoryStore` name for the planned storage
  abstraction

Read these files before substantial changes:

- `README.md` for user-facing behavior
- `ARCHITECTURE.md` for module boundaries and public API
- `ROADMAP.md` for forward-looking direction
- `CHANGELOG.md` for release notes
- `PROJECT_MEMORY.md` for maintainer notes

## Engineering Rules

- Keep the package ESM-only unless build output and tests explicitly add CJS.
- Use strict TypeScript. Avoid `any` unless there is a strong reason.
- Prefer object-parameter APIs for public surface additions.
- Do not add hidden schema creation to client constructors.
- Do not hold database transactions open while calling external embedding APIs.
- Keep experimental APIs under `client.experimental.*`.
- Keep root `mnemocyte` imports provider-free.
- Do not add provider SDKs to the core package.
- Preserve the no-SDK `fetch` boundary for provider helpers such as
  `mnemocyte/embedders/openai`.
- Test files should not use `node:assert`, `assert.*`, `@ts-ignore`, or
  `@ts-nocheck`.

## Documentation Rules

- Keep `README.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `PROJECT_MEMORY.md`, and
  `CHANGELOG.md` consistent after public behavior changes.
- `ROADMAP.md` is forward-looking; shipped work belongs in `CHANGELOG.md`.
- Keep limitations concrete: what works now, what fails fast, and what is
  planned next.
- For Postgres/index work, document operational tradeoffs and avoid adding
  default indexes without representative benchmark or `EXPLAIN` evidence.
- Use `MemoryStore` when referring to the future backend abstraction; avoid the
  generic name `Store` for that concept.

## Commands

Preferred validation commands:

```bash
pnpm checktypes
pnpm test
pnpm run pack:check
```

Additional useful commands:

```bash
pnpm lint
pnpm run test:ci
pnpm run test:integration
pnpm run bench:retrieval
pnpm tsc -p tsconfig.test.json
```

Notes:

- `pnpm lint` is read-only; `pnpm lint:fix` and `pnpm format` use `--write`.
- `test:integration` needs a compatible Postgres + pgvector `DATABASE_URL`.
- Do not print `.env` contents or database credentials.
- Local integration may fail if the configured database is unavailable.

## Release Guidance

Agents may run or suggest validation commands, edit release notes, and draft
release text. Agents must not publish packages, push tags, or create GitHub
releases. Publishing and release creation are manual maintainer actions.

When release guidance is relevant, provide:

- a short Conventional Commit message for the actual code/docs change
- suggested validation commands
- the recommended version bump command
- a GitHub release title
- a GitHub release description

Preferred validation commands:

```bash
pnpm checktypes
pnpm test
pnpm run pack:check
```

Use this version bump command for patch releases:

```bash
pnpm version patch
```

Use `minor` or `major` only when the change clearly requires it. Do not suggest
a separate release commit such as `chore: release vX.Y.Z`; `pnpm version`
handles the version bump commit and tag.

GitHub release title format:

```text
mnemocyte vX.Y.Z
```

GitHub release description format:

```markdown
### Category
- **Short label**: concise description of the change
- **Short label**: concise description of the change

### Category
- **Short label**: concise description of the change

**Full Changelog**: https://github.com/Meenic/mnemocyte/compare/vPREVIOUS...vCURRENT
```

Prefer categories like:

- Performance
- Accuracy
- Reliability
- Embedders
- Documentation
- Tooling
- API

Keep release descriptions concise, developer-friendly, and factual. Avoid hype,
long summaries, and vague marketing language. Do not include a Validation
section in GitHub release descriptions.

The maintainer manually runs publish and release steps after validation and
version bumping.
