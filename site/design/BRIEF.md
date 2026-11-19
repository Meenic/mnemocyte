# Mnemocyte website: build brief

The spec for rebuilding the Mnemocyte site in Next.js. Read it end to end
before writing code. `reference/index.html` is the visual source of truth: open
it in a browser, and copy exact CSS values from it rather than guessing.

## 1. What we are building

A home for the `mnemocyte` open-source library: a landing page, the docs, a
changelog and a community page. It is not a SaaS site, so it has no pricing,
sign-up, accounts or dashboard. The site's job is to get a developer to
install the package, read the guides and star the repo.

Non-goals: dark mode (the site is deliberately single-theme), a blog, search
in v1, analytics.

## 2. Where it lives

Put the site in the library's repository as a pnpm workspace package at
`site/`. The library stays at the repository root and is not moved.

Why here and not in a separate repository:

- The docs pages render `docs/guide/*.md` and `CHANGELOG.md` straight from
  the repository at build time, so the site can never drift from the docs.
- `docs/ROADMAP.md` already plans a pnpm workspace in this repository for
  `@mnemocyte/mcp`. This is the first step of that.
- `package.json` publishes only `dist` and `migrations/*.sql` (`files`), so
  nothing in `site/` can reach npm.

Repository changes this needs (make them in the first PR):

| File                       | Change                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm-workspace.yaml`      | Add `packages: ["site"]`. Keep `allowBuilds`.                                                                                                                                        |
| `biome.json`               | No change. The site has its own nested `site/biome.json` (`"root": false`) with Next's Biome defaults, so the library's formatting stays separate. Both use the root's Biome binary. |
| `.gitignore`               | No change. `site/.gitignore` (Next's default) ignores `.next`, `out` and `next-env.d.ts`, plus `.source` (Fumadocs output).                                                          |
| `tsconfig.json` (root)     | No change: its `include` covers only `src`, `test` and configs. `site/` has its own `tsconfig.json`.                                                                                 |
| `.github/workflows/ci.yml` | Add a `site` job: `pnpm install --frozen-lockfile`, `pnpm --filter site lint`, `pnpm --filter site typecheck`, `pnpm --filter site build`. Leave the library jobs alone.             |
| `site/package.json`        | `"name": "@mnemocyte/site"`, `"private": true`. It does not depend on `mnemocyte`.                                                                                                   |

Hosting: Vercel, with Root Directory `site`. Vercel detects the pnpm
workspace and installs from the repository root.

Never change library code (`src/`, `test/`, `migrations/`, `scripts/`) as
part of site work.

## 3. Stack

Check every version against the current docs before installing; don't trust
the numbers here.

- **Next.js 16** (App Router, Turbopack), **React 19.2+**, TypeScript strict.
- **React Compiler** on. So no `useMemo`, `useCallback` or `memo`. Use
  `RefObject<T>` (React 19), not `MutableRefObject`.
- **Styling: Tailwind v4 mapped to the tokens.** The tokens, an
  `@theme inline` block that maps them with their names kept (`bg-ink`,
  `text-md`) and the base styles are all in `src/app/globals.css`.
  Tailwind's default colors, font sizes and breakpoints are removed, so
  there is no second palette. Components use tokens only, never a
  hard-coded color. Every component uses Tailwind utilities; there are no CSS modules.
  See `site/AGENTS.md` for the architecture.
- **Fonts with `next/font`:** Geist and Geist Mono, from the `geist`
  package (`geist/font/sans`, `geist/font/mono`), exposing
  `--font-geist-sans` and `--font-geist-mono`.
- **Docs: Fumadocs, headless.** Use `fumadocs-mdx` and `fumadocs-core` for
  loading, the page tree and the table of contents. Don't use `fumadocs-ui`:
  its styles fight this design. Build the docs layout from the reference.
- **Biome** with the site's own `site/biome.json`. No ESLint or Prettier.

## 4. Starter code (written, type-checked, linted, tested)

These files are in `site/src/`, a faithful TypeScript port of the
reference's JavaScript.

| File                           | What it is                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app/globals.css`              | Every color, font, size and space token, the Tailwind theme, base styles and the shared `.key`, `.wrap` and `.lead` classes (Tailwind's `sr-only` replaces the old class). |
| `lib/colony/pixel.ts`          | Bayer dither, hash, `toAbgr` and `cssVar` helpers.                                                                                                                         |
| `lib/colony/cell.ts`           | `drawCell`: one cell at any life stage.                                                                                                                                    |
| `lib/colony/engine.ts`         | `Colony`: the growing, decaying, linking colony. Framework-free.                                                                                                           |
| `lib/colony/glyph.ts`          | `drawGlyph`: the four 20 × 20 life-cycle icons.                                                                                                                            |
| `components/art/colony.tsx`   | Client component, `variant="hero"` or `"card"`. Handles layout, the bleed, resize, visibility, reduced motion, pointer and keyboard.                                       |
| `components/art/lifecycle-icon.tsx` | Client component for one icon, animated at 10 fps when on screen.                                                                                                          |
| `components/brand/logo.tsx`   | `Logo` (mark + wordmark link) and `LogoMark`.                                                                                                                              |
| `components/ui/copy-button.tsx` | Copy with "Copied" confirmation for 1.5 s, clipboard fallback and a status message for screen readers.                                                                     |

The colony reads its colors from tokens at mount. Pass `texts` as a
module-level constant: a new array on every render restarts the colony.

## 5. Design system

The tokens in `src/app/globals.css` are the system. The summary below is so you know how to use it.

**Palette.** Background `--bg` #ECEEE8. Near-black `--ink`. One loud color,
`--primary` #FF4F9A (pink). Pink only ever sits next to ink: ink text on
pink, or pink text on ink, both about 6:1. Pink never carries text on the
light background. It appears in only a few places: active cells in the
artwork, the key word on the pink card, the conversation highlights, the
latest version on the changelog, and the copy confirmation.

**Type.** Headings use Geist at weight 440 with -0.03em tracking. Hierarchy
comes from size and space, not weight. One scale:

| Token       | Size                | Used for                                                                  |
| ----------- | ------------------- | ------------------------------------------------------------------------- |
| `--fs-2xl`  | 40 → 64px           | Hero and page titles, the pink card heading                               |
| `--fs-xl`   | 32 → 44px           | Section headings                                                          |
| `--fs-lg`   | 28px                | Docs step headings, version numbers                                       |
| `--fs-md`   | 20px (18 on phones) | Leads, h3, conversation text                                              |
| `--fs-base` | 16px                | Body                                                                      |
| `--fs-sm`   | 14px                | Labels, dates, the footer. Nothing is smaller, except 13–13.5px for code. |

Monospace appears only for code, commands, import paths and version numbers.

**The key word.** Each of a few headings sets one word in a notched ink
block (`<span class="key">`). Use it on four headings at most: the hero,
"Lives in the **Postgres** you already run.", "it still **knows her**." and the
pink card's "**open source**". A heading with a key gets line-height 1.28, so
the block has room above and below. When the key word starts the heading,
add `hang` so the block hangs and the letters align with the text below. The
trailing period sits right after the block.

**Pixel details.** The pixel feel lives in the artwork, the logo, the
`--notch` stepped corners on dark and pink blocks, and the key blocks. It is
never in the body letters.

**Spacing rhythm.**

- `--page-top`: the header to the first heading, on every page.
- `--section`: the gap between sections, and between the last section and
  the footer line. Sections have top padding only, so gaps never double.
- The footer has `--s-5` above and below its content, and its line aligns
  with the content column.

**Breakpoints:** 960px (two columns become one; the hero colony becomes a
full-width strip), 720px (the nav collapses into a Menu button), 560px
(phone type sizes, buttons go full width).

**Header.** Sticky, a plain `--bg` background, no border, no blur.

**States.** Every link and button has hover, `:focus-visible` (2px ink
outline; light outline on dark blocks) and `:active` states. Copy them from
the reference.

## 6. Pages

Real routes replace the reference's `#hash` views. The reference only used
hashes because of where it was hosted.

### `/` Home

Six blocks, separated by `--section`. Exact copy and layout are in the
reference.

1. **Hero.** Copy on the left (13fr); the colony on the right (10fr) at the
   height of the copy, bleeding off the right edge of the viewport.
   - h1: "**Memory** for TypeScript AI apps." (the README tagline; don't
     change it), with `key hang` on "Memory". At most two lines.
   - Lead, at most two lines: "Save what your AI app learns, then pull back
     what matters when you build a prompt."
   - The `pnpm add mnemocyte` install box with a copy button, then the
     **Get started** primary button (→ `/docs`).
   - Under 960px the colony becomes a full-bleed strip, 180px tall, below the
     buttons.
2. **Code.** "Save once. Recall as a prompt." The README example in an ink
   code block (7fr), next to an outlined panel showing the Markdown
   `context()` returns (5fr). Below them, a link to the getting started
   guide.
3. **Works with.** "Lives in the **Postgres** you already run." Three
   columns, each with an import path, a name and a line: Postgres
   (`mnemocyte/postgres`), the AI SDK (`mnemocyte/ai-sdk`), Embedders
   (`mnemocyte/embedders`).
4. **Life cycle.** The heading and lead on the left; a 2 × 2 grid on the
   right: Add, Recall, Merge, Prune, each with a `LifecycleIcon`. The icon
   kinds are named after the stages.
5. **Conversation.** "Seven weeks later, it still **knows her**." Two
   staggered cards: a light card (Ada, 3 March) and an ink card (Ada and
   the assistant, 19 April). Remembered facts are ink-on-pink highlights in
   the light card and pink underlined text in the ink card.
6. **Closing card.** A pink notched block: "Free and **open source**.", one
   line, **Star on GitHub** and the install box, with `<Colony
   variant="card" />` on the right.

### `/docs` and `/docs/[slug]`

Rendered from `../docs/guide/*.md` with Fumadocs. `getting-started.md` is
`/docs`, and every other guide is `/docs/<file-name>`.

- **Layout** (copy it from the reference's docs view): a 200px sticky
  sidebar of guides in four groups, then the article, at most 700px. Under
  960px the sidebar becomes an "All guides" toggle. Add an "On this page"
  table of contents on the right above 1180px only, if it fits without
  crowding.
- **Sidebar groups:**
  - Start: Getting started, Recipes, FAQ
  - Reference: API, CLI, Limitations
  - Integrations: Postgres, Embedders, AI SDK, AI coding tools
  - Upgrading: From 0.x
- **The guides have no frontmatter.** Relax the Fumadocs schema so `title`
  is optional, and take the title from the first `#` heading. Remove that
  heading from the body, since the layout renders the title.
- **Rewrite links:**
  - `./api.md#scopes` → `/docs/api#scopes`
  - `../ROADMAP.md`, `../DEVELOPMENT.md`, `../ARCHITECTURE.md` and
    `../../CHANGELOG.md` → `/changelog` for the changelog, GitHub blob URLs
    for the rest
  - Heading anchors must match GitHub's slugs, because the guides link to
    them. Test a few, such as `#4-write-memoryts` and `#use-ollama-instead-of-openai`.
- **Code blocks:** use the same ink slab as the home page, with a Shiki theme
  built from the `--code-*` tokens and a `CopyButton tone="dark"` on each
  block.
- **Footer of each guide:** previous and next guide links, plus "Edit this
  page on GitHub".

### `/changelog`

Built from `../CHANGELOG.md` at build time. Show 1.0.0 and later. For each
release:

- the version in mono on the left, with its date; the latest version's
  number sits on a pink notched block
- the release's first paragraph as the title
- the bold lead-in of each entry, without the rest, as the list

End with "Full changelog, back to 0.1" linking to the file on GitHub. Skip
"Unreleased". Parse defensively: if a section doesn't match the expected
shape, render its Markdown as-is instead of failing the build.

### `/community`

As in the reference:

- "Built in the **open**." with "View on GitHub"
- three ways to help, linking to issues, the guides and `DEVELOPMENT.md`
- "What's next": four items summarised from the open items in
  `docs/ROADMAP.md`. They are hand-written copy; update them when the
  roadmap changes.

### Shared

- **Nav:** the logo, then Docs, Changelog and Community, then a GitHub
  button. Under 720px, a Menu button opens a list; Escape closes it.
- **Footer:** the logo; Docs, Changelog, Community, GitHub, npm and Sponsor
  (`https://github.com/sponsors/Meenic`); "MIT License · © 2026 Meenic".
- **Metadata:**
  - title template `%s · Mnemocyte`, with "Mnemocyte" on the home page
  - description: the README's first paragraph
  - `app/icon.svg` from the logo mark
  - an Open Graph image made from a still colony frame and the tagline,
    with `next/og`
  - `sitemap.ts` and `robots.ts`
- **Links:** repository `https://github.com/Meenic/mnemocyte`, package
  `https://www.npmjs.com/package/mnemocyte`.

## 7. Content rules

- The source of truth is the repository: `README.md`, `docs/guide/*`,
  `CHANGELOG.md` and `docs/ROADMAP.md`. Never describe an API the library
  does not have.
- Keep the README tagline, "Memory for TypeScript AI apps.", word for word.
- Write in plain words and short sentences. No tiny decorative text (no
  eyebrow labels, badges, figure numbers or status chips), no emoji, no
  invented numbers such as star counts or downloads.
- The Ada conversation is an illustration. Keep it, and don't present it as
  real output.

## 8. Accessibility and motion

- Every text pair meets WCAG AA. The tokens are chosen for it; don't add
  colors.
- The hero colony is a focusable `role="img"`: arrow keys pick a memory,
  Enter recalls it, and a polite live region reads the memory.
- Decorative canvases are `aria-hidden`.
- With `prefers-reduced-motion`, all canvases draw one still frame and every
  transition stops: each component turns off its own transitions in a
  reduced-motion media query (no global `!important`). Hover recall still
  works, without the pulse.
- Canvases only animate while on screen and while the tab is visible.
- No layout shift: the colony boxes have fixed heights, and the fonts come
  from `next/font`.

## 9. Done means

- [ ] Each page matches `reference/index.html` at 1440 × 900 and 390 × 844
  (compare screenshots side by side).
- [ ] The hero headline is at most two lines at both widths; nothing scrolls
  sideways on a phone.
- [ ] Section gaps are equal: measure them, don't eyeball them.
- [ ] Keyboard: you can tab through everything with a visible focus ring;
  the colony works with the arrow keys; Escape closes the menu.
- [ ] `pnpm --filter site lint`, `typecheck` and `build` pass, and the root
  `pnpm lint` still passes.
- [ ] Lighthouse: Accessibility ≥ 95, Best Practices ≥ 95, CLS < 0.05.
- [ ] Every docs link in `docs/guide/*` resolves (write a small link check
  for the build).
