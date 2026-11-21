<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Mnemocyte site

The website for the `mnemocyte` library, in `apps/site/` of the library's
repository. `CLAUDE.md` only imports this file. The spec is
`design/BRIEF.md`. The visual reference is `design/reference/index.html`:
take layout, values and behaviour from its CSS instead of guessing, but
pixel-perfect parity is not the goal. A clean, conventional codebase
comes first.

## Architecture

```text
src/
├─ app/               routes only; page files are thin and compose
│  ├─ layout.tsx      fonts, header, <main>, footer, site metadata
│  ├─ globals.css     tokens, @theme, base styles
│  ├─ not-found.tsx   the 404 (also replaces Next's default, see below)
│  ├─ icon.svg, opengraph-image.tsx, sitemap.ts, robots.ts
│  ├─ (home)/         page.tsx + _sections/ (hero, code-example, …)
│  ├─ docs/           not built yet: layout.tsx, [[...slug]]/page.tsx
│  ├─ changelog/      page.tsx, _components/ (release, markdown)
│  └─ community/      page.tsx
├─ components/        shared by more than one route
│  ├─ ui/             button, text-link, install-box, copy-button,
│  │                  code-block, inline-code
│  ├─ layout/         site-header, nav-links, mobile-menu, site-footer
│  ├─ brand/          logo (exports the mark's paths), github-icon
│  └─ art/            colony, lifecycle-icon (client canvases)
└─ lib/               plain TypeScript, no JSX, unit-testable
   ├─ site.ts         URLs, nav links, tagline, description, SITE_URL
   ├─ cn.ts           class merging
   ├─ highlight.ts    Shiki, themed from the --code-* tokens
   ├─ changelog.ts    parses ../../CHANGELOG.md (fixture in fixtures/)
   ├─ markdown.ts     Markdown → hast, relative links → GitHub
   ├─ tokens.ts       color tokens read from globals.css
   ├─ png.ts          RGBA → PNG, for the Open Graph image
   ├─ og.ts           the Open Graph colors and colony frame
   └─ colony/         the pixel colony engine; still.ts renders a
                      frame without a browser
```

- `app/` holds routing. A component used by one route lives next to it in a
  private folder (`_sections/`, `_components/`), which Next keeps out of
  the URL. When a second route needs it, move it to `components/`.
- `components/` is grouped by role: `ui/` building blocks, `layout/` page
  chrome, `brand/` marks and icons, `art/` canvases.
- `lib/` has no React. Parsers, link rewriting and the colony engine live
  here, with colocated Vitest tests (`*.test.ts`). The docs and changelog
  are read from the repository at build time; every route is static.
- Cache Components is on, so async work during prerendering must be
  cached: build-time work (highlighting, reading guides and the changelog)
  goes in an async `lib/` function with `"use cache"` and
  `cacheLife("max")`, as `lib/highlight.ts` does. Otherwise the build
  fails with "uncached or runtime data during prerendering".
- Server Components by default. `"use client"` only on interactive leaves
  (`nav-links`, `mobile-menu`, `copy-button`, the canvases).
- Imports: `@/…` across folders, `./…` within one.
- Keep `app/not-found.tsx`. Next's default 404 injects a `<style>` that
  paints the body black in dark mode, and it stays in the document after a
  client-side navigation back to a real page.
- `SITE_URL` (`lib/site.ts`) is `VERCEL_PROJECT_PRODUCTION_URL` on Vercel
  and `http://localhost:3000` elsewhere. Metadata, the sitemap and
  robots.txt build absolute URLs from it; set the domain there once there
  is one. The Vercel project's Root Directory must be `apps/site`.
- The Open Graph image can't read CSS variables, so `lib/og.ts` reads the
  color tokens from `globals.css` and draws a colony frame with the same
  engine as the hero.

## Rules

- Only touch `apps/site/` (and, when the brief says so,
  `pnpm-workspace.yaml`, `.gitignore` and the CI workflow). Never change
  the library (`packages/mnemocyte/`), `examples/`, `scripts/` or
  `docs/`.
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
- Tailwind is the only styling system: no CSS modules. Variants are small
  class maps (see `ui/button.tsx`), joined with `cn` from `@/lib/cn`.
- `cn` is the shadcn `cn` package configured for our tokens. A new
  `--text-*` size in `globals.css` must be added to `lib/cn.ts` too,
  otherwise `cn` reads it as a color and drops it in a merge.
- File names are kebab-case everywhere (`site-header.tsx` exports
  `SiteHeader`). Components use named exports; Next's special files
  (`page`, `layout`, `opengraph-image`, …) keep their default export. No
  redundant folder prefix (`lib/colony/engine.ts`, not
  `lib/colony/colony-engine.ts`).
- Formatting and linting come from `apps/site/biome.json`: Next's Biome
  defaults (2-space indent, the Next and React rule domains), separate from the
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
pnpm --filter site test   # Vitest, src/**/*.test.ts
pnpm --filter site build
pnpm lint            # root: must keep passing
```

`.claude/launch.json` (untracked) starts `next start` on port 3100 for
the browser preview, so run `build` before previewing a change.

## Workflow

- `design/PROMPTS.md` holds one prompt per step; its status section says
  what is done and what is next. Each remaining step is a branch from
  `main` and a PR, following the repository's git rules. Write
  conventional commits, such as `feat(site): render guides from docs/guide`.
- Before you call a step done, run lint, typecheck, test and build. Then check
  the pages at 1440 × 900 and 390 × 844 against the reference and fix what
  is clearly off.
