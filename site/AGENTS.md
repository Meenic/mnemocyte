<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Mnemocyte site

The website for the `mnemocyte` library, in `site/` of the library's
repository. `CLAUDE.md` only imports this file. The spec is
`design/BRIEF.md`. The visual source of truth is
`design/reference/index.html`; open it in a browser, and copy exact values
from its CSS instead of guessing.

## Rules

- Only touch `site/` (and, when the brief says so, `pnpm-workspace.yaml`,
  `.gitignore` and the CI workflow). Never change the library: `src/`,
  `test/`, `migrations/`, `scripts/`, `docs/`.
- Content comes from the repository (`README.md`, `docs/guide/*`,
  `CHANGELOG.md`, `docs/ROADMAP.md`). Never describe an API the library does
  not have. Keep the tagline "Memory for TypeScript AI apps." word for word.
- Check framework APIs against the current docs for the installed versions
  (Next.js 16, React 19.2+, Tailwind v4, Fumadocs) before using them. Prefer
  the Next.js docs in `node_modules/next/dist/docs/` over memory.
- React Compiler is on: no `useMemo`, `useCallback` or `memo`. Use
  `RefObject<T>`, not `MutableRefObject`.
- Styles: Tailwind v4 utilities built from the tokens. The tokens, the
  `@theme` that maps them and the base styles all live in
  `src/app/globals.css`. Tailwind's default colors, font sizes and
  breakpoints are removed, so only token utilities exist (`bg-ink`,
  `text-primary`, `text-md`, `lg:`). No hard-coded colors, font sizes outside
  the scale, or spacing outside the scale. Pink (`--primary`) only next to
  `--ink`.
- The starter components (`Colony`, `LifecycleIcon`, `Logo`, `CopyButton`)
  keep their CSS modules. Move one to Tailwind only when you are changing it
  anyway.
- File names: kebab-case for non-component files (`colony.module.css`,
  `parse-changelog.ts`), PascalCase for React components (`Colony.tsx`). No
  redundant folder prefix (`lib/colony/engine.ts`, not
  `lib/colony/colony-engine.ts`).
- Formatting and linting come from `site/biome.json`: Next's Biome defaults
  (2-space indent, the Next and React rule domains), separate from the
  library's config. The Biome binary is the repository root's. Fix lint
  errors properly; don't suppress them unless there is a real reason, and
  then write the reason in the suppression comment.
- Accessibility and reduced motion are requirements, not extras. See the
  brief, section 8.

## Commands

```bash
pnpm --filter site dev
pnpm --filter site lint
pnpm --filter site typecheck
pnpm --filter site build
pnpm lint            # root: must keep passing
```

## Workflow

- One branch and one PR per task. Name the branch `<type>/site-<topic>`,
  such as `feat/site-docs`, and write conventional commits, such as
  `feat(site): render guides from docs/guide`.
- Before you call a task done, run lint, typecheck and build. Then take
  screenshots at 1440 × 900 and 390 × 844, compare them with the reference,
  and fix what differs.
