# Mnemocyte website: brief

The spec for the Mnemocyte site in `apps/site/`. Read it end to end before
writing code. The built site is the visual reference: build it
(`pnpm --filter site build`), start it (`pnpm --filter site start`, or the
`site` entry in `.claude/launch.json` on port 3100) and take values from
the code rather than guessing: the tokens in `src/app/globals.css` and the
components in `src/components/`. A new page reuses them. The docs pages
are not built yet; section 6 gives their layout in full.

## 1. What we are building

A home for the `mnemocyte` open-source library: a landing page, the docs, a
changelog and a community page. It is not a SaaS site, so it has no pricing,
sign-up, accounts or dashboard. The site's job is to get a developer to
install the package, read the guides and star the repo.

Non-goals: dark mode (the site is deliberately single-theme), a blog, search
in v1, analytics.

## 2. Where it lives

The site is the private workspace package `@mnemocyte/site` in
`apps/site/` of the library's repository. Things that are run or deployed
go under `apps/`, libraries under `packages/` (ARCHITECTURE.md, decision
53).

It stays in this repository because the docs pages render
`docs/guide/*.md` and `CHANGELOG.md` straight from it at build time, so a
docs fix and the site change land in one PR and cannot drift. It never
reaches npm: both packages publish only what their `files` field lists.

The site has its own `tsconfig.json`, its own `biome.json` (`"root": false`,
Next's Biome defaults, using the root's Biome binary) and its own
`.gitignore` (`.next`, `out`, `next-env.d.ts`, `.source`). CI's `Site` job
runs the root `pnpm lint`, then the site's typecheck, test and build.

Hosting: Vercel, with Root Directory `apps/site`. Vercel detects the pnpm
workspace and installs from the repository root. The site is not deployed
yet; the maintainer deploys it and then sets the domain in
`src/lib/site.ts`.

Never change library code (`packages/`, `examples/`, `scripts/`, `docs/`)
as part of site work. The one exception is ticking the site's own item in
`docs/ROADMAP.md` in the PR that completes it.

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
  hard-coded color. Every component uses Tailwind utilities; there are no
  CSS modules. See `apps/site/AGENTS.md` for the architecture.
- **Fonts with `next/font`:** Geist and Geist Mono, from the `geist`
  package (`geist/font/sans`, `geist/font/mono`), exposing
  `--font-geist-sans` and `--font-geist-mono`.
- **Docs: Fumadocs, headless.** Use `fumadocs-mdx` and `fumadocs-core` for
  loading, the page tree and the table of contents. Don't use `fumadocs-ui`:
  its styles fight this design. Build the docs layout from section 6.
- **Biome** with the site's own `apps/site/biome.json`. No ESLint or
  Prettier.

## 4. Building blocks

The pieces a new page is made of already exist; `apps/site/AGENTS.md` maps
every folder.

| Piece                                               | Where                                                                |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| Tokens, Tailwind theme, base styles, `.key`, `.wrap` | `src/app/globals.css`                                               |
| Buttons, text links, install box, copy button       | `src/components/ui/`                                                 |
| The ink code slab, highlighted with Shiki           | `src/components/ui/code-block.tsx`, `src/lib/highlight.ts`           |
| Inline code                                         | `src/components/ui/inline-code.tsx`                                  |
| Header, nav, mobile menu, footer                    | `src/components/layout/`                                             |
| Logo and mark                                       | `src/components/brand/logo.tsx`                                      |
| The colony and the life-cycle icons                 | `src/components/art/`, engine in `src/lib/colony/`                   |
| Markdown to hast, relative links to GitHub          | `src/lib/markdown.ts`                                                |

The colony reads its colors from tokens at mount. Pass `texts` as a
module-level constant: a new array on every render restarts the colony.

## 5. Design system

The tokens in `src/app/globals.css` are the system. The summary below is so
you know how to use it.

**Palette.** Background `--bg` #ECEEE8. Near-black `--ink`. One loud color,
`--primary` #FF4F9A (pink). Pink only ever sits next to ink: ink text on
pink, or pink text on ink, both about 6:1. Pink never carries text on the
light background. It appears in only a few places: active cells in the
artwork, the key word on the pink card, the conversation highlights, the
latest version on the changelog, the copy confirmation and the current
guide's marker in the docs sidebar (a bar beside the ink link text).

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
outline; light outline on dark blocks) and `:active` states. Reuse the ones
in `src/components/ui/` instead of writing new ones.

## 6. Pages

Every page is a real route; every route is static.

### `/` Home (built)

Six blocks, separated by `--section`, in `src/app/(home)/_sections/`. The
copy there is the current copy.

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

### `/docs` and `/docs/[slug]` (not built yet)

Rendered from `../../docs/guide/*.md` with Fumadocs. `getting-started.md` is
`/docs`, and every other guide is `/docs/<file-name>`.

- **Layout.** A grid of a 200px sidebar and the article, at most 700px
  wide (`minmax(0, 700px)`), with a gap of `clamp(48px, 8vw, 120px)` and
  `--page-top` above. Add an "On this page" table of contents on the right
  above 1180px only, if it fits without crowding.
- **Sidebar.** Sticky, `--nav-h` plus 40px from the top, aligned to the
  top of the grid. Four groups, each a small heading in `--ink-soft`,
  weight 600, 32px above (none above the first) and 10px below, then a list
  without bullets, 2px between links. A link is a block with 5px above and
  below, in `--ink-soft`, turning `--ink` on hover with a 0.15s color
  transition. The current guide (`aria-current="page"`) is `--ink`, weight
  600, with 12px of left padding and a 3px `--primary` bar on its left edge
  (an inset box-shadow).
- **Under 960px.** One column, `--s-3` gap. The sidebar stops being sticky,
  gets a `--line` hairline below and `--s-2` of bottom padding, and its
  groups hide behind a full-width "All guides" button: a row with the label
  left and a `+` right (`aria-hidden`), no background or border, 8px above
  and below, `--fs-base`, weight 500, with `aria-expanded` and
  `aria-controls`. Open, the groups show with `--s-2` above them.
- **Sidebar groups:**
  - Start: Getting started, Recipes, FAQ
  - Reference: API, CLI, Limitations
  - Integrations: Postgres, Embedders, AI SDK, AI coding tools
  - Upgrading: From 0.x
- **Article.** The page title as on the other pages, then a lead
  `--s-3` below it. `h2` is `--fs-lg`
  with -0.03em tracking, `--s-5` above and `--s-2` below. Paragraphs have
  `--s-2` above and below and a line height of 1.7. Inline code is
  `InlineCode` (`--fs-sm`, `--surface`, a 1px `--line` border).
- **Code blocks.** The home page's `CodeBlock` slab with its
  `CopyButton tone="dark"`, `--s-3` above and below, with 28px 32px 30px of
  padding and `--fs-sm` text in the article, and the copy button 10px from
  the top and right. Under 560px the padding is 52px 20px 24px, so the code
  starts below the button.
- **Callouts.** A guide's "No database yet?"-style note is an outlined box:
  a 1px `--line` border, a `--surface` background, `--s-3` above and below
  and 28px left and right inside, `--s-4` outside. A list of requirements
  (the getting started guide's Node.js, Postgres with pgvector and an
  embedder) is a list without bullets with a
  `--line` hairline above and between rows, each row the name on the left
  and the value on the right in `--ink-soft`, 14px above and below,
  `--s-4` above the list.
- **Footer of each guide.** Previous and next guide links in two equal
  columns, `--s-2` apart and `--s-6` above, then "Edit this page on
  GitHub". Each link is a 1px `--line` box with 20px 24px of padding:
  "Previous" or "Next" in `--fs-sm` `--ink-soft`, 4px above the guide's
  name at 18px, weight 500. Hover turns the border `--ink` and the
  background `--surface`; active, the background is `--bg`. The next link
  is right-aligned. Under 560px the two stack in one column, both
  left-aligned.
- **Off-scale values.** The values above are the reference design's,
  which mixed tokens with raw pixels. Its type sizes outside the scale
  (13px, 15px, 18px) and its spacing outside the scale (2px, 4px, 5px,
  10px, 12px, 14px, 20px, 28px, 30px and 32px) become the nearest token,
  as `apps/site/AGENTS.md` requires. The layout values stay as written:
  the 200px and 700px columns, the column gap, the sticky offset and the
  3px marker. Hover and border changes use 0.15s transitions, like the
  rest of the site.
- **The guides have no frontmatter.** Relax the Fumadocs schema so `title`
  is optional, and take the title from the first `#` heading. Remove that
  heading from the body, since the layout renders the title.
- **Rewrite links:**
  - `./api.md#scopes` → `/docs/api#scopes`
  - `../ROADMAP.md`, `../DEVELOPMENT.md`, `../ARCHITECTURE.md` and
    `../../CHANGELOG.md` → `/changelog` for the changelog, GitHub blob URLs
    for the rest
  - Heading anchors must match GitHub's slugs, because the guides link to
    them. Test a few, such as `#4-write-memoryts` and
    `#use-ollama-instead-of-openai`.

### `/changelog` (built)

Built from `../../CHANGELOG.md` at build time (`src/lib/changelog.ts`). Show
1.0.0 and later. For each release:

- the version in mono on the left, with its date; the latest version's
  number sits on a pink notched block
- the release's first paragraph as the title
- the bold lead-in of each entry, without the rest, as the list

End with "Full changelog, back to 0.1" linking to the file on GitHub. Skip
"Unreleased". Parse defensively: if a section doesn't match the expected
shape, render its Markdown as-is instead of failing the build.

### `/community` (built)

In `src/app/community/page.tsx`:

- "Built in the **open**." with "View on GitHub"
- three ways to help, linking to issues, the guides and `DEVELOPMENT.md`
- "What's next": four items summarised from the open items in
  `docs/ROADMAP.md`. They are hand-written copy; update them when the
  roadmap changes.

### Shared (built)

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
  - `sitemap.ts` and `robots.ts`; add the docs routes to the sitemap when
    they land
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

For every new or changed page:

- [ ] It sits in the same system as the built pages at 1440 × 900 and
  390 × 844: the same header-to-heading gap, section rhythm, type scale and
  states. Compare screenshots with an existing page side by side.
- [ ] Headings are at most two lines at both widths where this brief says
  so; nothing scrolls sideways on a phone.
- [ ] Section gaps are equal: measure them, don't eyeball them.
- [ ] Keyboard: you can tab through everything with a visible focus ring;
  the colony works with the arrow keys; Escape closes the menu.
- [ ] `pnpm --filter site lint`, `typecheck`, `test` and `build` pass, and
  the root `pnpm lint` still passes.
- [ ] Lighthouse: Accessibility ≥ 95, Best Practices ≥ 95, CLS < 0.05.
- [ ] For the docs: every link in `docs/guide/*` resolves to a page or an
  anchor, checked at build time, and the build fails if one doesn't.
