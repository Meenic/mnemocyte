# Prompts for Claude Code

Paste these into Claude Code one at a time, from the repository root. If a
step goes wrong, say what you see ("the hero headline wraps to three lines
at 390px") instead of starting over.

## Status

Steps 0–2 and 4–6 were built as one commit each on `chore/site-workspace`
and merged as one PR. Step 3 is the one left; it gets its own branch from
`main` (its `Branch:` line below) and its own PR.

- Done: 0 workspace, 1 foundation, 2 home, 4 changelog, 5 community, 6
  metadata and the launch checklist (Lighthouse: Accessibility 100, Best
  Practices 96–100, CLS ≤ 0.005 on every page).
- Next: 3 docs. Until it lands, /docs is a 404. When it does, add the docs
  routes to `src/app/sitemap.ts` and run the docs link check from BRIEF.md
  section 9.
- Not deployed: deploy on Vercel when the maintainer says so, and set the
  domain in `src/lib/site.ts` then.

---

## 0 · Set up the workspace (done)

Done in `chore/site-workspace`, with these changes from the prompt below:
Tailwind v4 is on, the site has its own `site/biome.json`, the CSS lives in
`src/app/globals.css`, the rules are in `site/AGENTS.md` (imported by
`site/CLAUDE.md`), and Pixelify Sans is dropped.

```text
Read site-handoff/BRIEF.md (sections 2 and 3) and site-handoff/site-CLAUDE.md.

Branch: chore/site-workspace

1. Scaffold a Next.js 16 App Router app in site/ with TypeScript, src/ dir,
   the @/* import alias, React Compiler on, and no Tailwind and no ESLint
   (Biome comes from the repository root). Check the current create-next-app
   flags first.
2. Make it a pnpm workspace package as BRIEF.md section 2 says:
   pnpm-workspace.yaml, site/package.json (name @mnemocyte/site, private,
   scripts dev/build/start/lint/typecheck), .gitignore and biome.json, plus
   the CI job.
3. Move site-handoff/ into the app: site-CLAUDE.md → site/CLAUDE.md,
   BRIEF.md → site/design/BRIEF.md, reference/ → site/design/reference/,
   and starter/* → site/src/ (keeping the folders). Delete site-handoff/.
4. Add the fonts with next/font as BRIEF.md section 3 says, and import
   src/styles/globals.css in the root layout.
5. Check: pnpm install, pnpm --filter site build, pnpm --filter site lint,
   and the root pnpm lint and pnpm checktypes. The library must not change.

Commit: chore(site): add Next.js site as a pnpm workspace package
```

## 1 · Foundation: layout, nav, footer (done)

```text
Read site/CLAUDE.md and site/design/BRIEF.md. Open
site/design/reference/index.html in a browser and use it as the visual
source of truth.

Branch: feat/site-foundation

Build the root layout: the sticky header (plain background, no border, no
blur) with Logo, the Docs, Changelog and Community links (the current page
underlined) and the GitHub button; the Menu button and list under 720px
(Escape closes it); and the footer, with its line aligned to the content
and equal space above and below. Add Button and InstallBox components
(InstallBox uses CopyButton). Use only the tokens. Add a skip link.

Port the exact values from the reference CSS. Then screenshot / at
1440×900 and 390×844 and compare with the reference.

Commit: feat(site): add layout, header and footer
```

## 2 · Home page (done)

```text
Read site/CLAUDE.md and BRIEF.md section 6 (Home). Use the reference for
copy, layout and every CSS value.

Branch: feat/site-home

Build the home page from six section components in
src/app/(home)/_sections/ (hero, code-example, works-with, life-cycle,
conversation, closing-card), styled with Tailwind utilities from the
tokens. Use the starter Colony (variant hero, and card in the closing card)
and LifecycleIcon (kinds add, recall, merge, prune). Keep the texts array a
module-level constant.

Check:
- The hero headline is at most two lines at 1440 and 390, and the colony
  bleeds off the right edge on desktop and runs edge to edge on a phone.
- Section gaps are equal (measure them).
- Reduced motion shows still frames; the colony works with the keyboard.
Compare screenshots with the reference at both sizes and fix what differs.

Commit: feat(site): add home page
```

## 3 · Docs from docs/guide

```text
Read site/CLAUDE.md and BRIEF.md section 6 (/docs). Check the current
Fumadocs docs for fumadocs-mdx and fumadocs-core first; use them headless,
without fumadocs-ui.

Branch: feat/site-docs

Render ../docs/guide/*.md at /docs (getting-started) and /docs/[slug]. The
guides have no frontmatter: make title optional and take it from the first
heading. Rewrite relative links as the brief says, and make the heading
anchors match GitHub's slugs. Build the docs layout from the reference: the
grouped sidebar with the "All guides" toggle under 960px, the code slabs
with a Shiki theme from the --code-* tokens and a copy button, and the
previous/next and "Edit on GitHub" links.

Add a build-time check that every link in docs/guide resolves to a page or
an anchor, and fail the build if one doesn't.

Commit: feat(site): render guides from docs/guide
```

## 4 · Changelog (done)

```text
Read site/CLAUDE.md and BRIEF.md section 6 (/changelog).

Branch: feat/site-changelog

Parse ../CHANGELOG.md at build time in src/lib/changelog.ts: the releases
from 1.0.0 up, each with its version, date, first paragraph and the bold
lead-ins of its entries. If a section doesn't match, render its Markdown
instead of failing. Build /changelog like the reference: the latest
version's number on a pink notched block, then the link to the full
changelog on GitHub. Add unit tests for the parser using a fixture copied
from the real file.

Commit: feat(site): add changelog page from CHANGELOG.md
```

## 5 · Community (done)

```text
Read site/CLAUDE.md and BRIEF.md section 6 (/community). Copy the copy and
layout from the reference. Check the four "What's next" items against the
open items in docs/ROADMAP.md, and update them if the roadmap has moved on.

Branch: feat/site-community
Commit: feat(site): add community page
```

## 6 · Metadata, polish, deploy (done, not deployed)

```text
Read site/CLAUDE.md and BRIEF.md sections 6 (Shared), 8 and 9.

Branch: chore/site-polish

Add the metadata, the title template, app/icon.svg from the logo mark, an
Open Graph image with next/og (a still colony frame and the tagline),
sitemap.ts and robots.ts. Then go through the whole "Done means" list in
BRIEF.md section 9 and fix everything it finds: screenshot every page at
both sizes, measure the section gaps, tab through every page, and run
Lighthouse. Report what you checked and what you fixed.

Commit: chore(site): add metadata and pass the launch checklist
```

After this, deploy on Vercel with Root Directory `site`.
