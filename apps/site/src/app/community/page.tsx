import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { InlineCode } from "@/components/ui/inline-code";
import { TextLink } from "@/components/ui/text-link";
import { REPO_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Community",
  description:
    "Mnemocyte is MIT licensed and developed on GitHub. Report a bug, improve the guides or pick a roadmap item.",
};

const WAYS_TO_HELP = [
  {
    title: "Report a bug",
    text: "Include your Node version, your database’s versions (Postgres and pgvector, or libSQL) and a small reproduction.",
    href: `${REPO_URL}/issues`,
    link: "Open an issue",
  },
  {
    title: "Improve the docs",
    text: "The guides live in the repository. Fix a step, add a recipe or answer a question in the FAQ.",
    href: `${REPO_URL}/tree/main/docs/guide`,
    link: "Browse the guides",
  },
  {
    title: "Pick a roadmap item",
    text: "Each item is one branch and one pull request. Start with the contributing guide.",
    href: `${REPO_URL}/blob/main/CONTRIBUTING.md`,
    link: "Read CONTRIBUTING.md",
  },
] as const;

/*
 * Hand-written summaries of docs/ROADMAP.md: the open items in roadmap
 * order, then ideas from "Later" with the condition they wait on. Update
 * them when the roadmap moves on.
 */
const NEXT: { title: string; text: ReactNode }[] = [
  {
    title: "An MCP server",
    text: (
      <>
        <InlineCode>@mnemocyte/mcp</InlineCode>, so any MCP client can read and
        save memories.
      </>
    ),
  },
  {
    title: "SQLite and sqlite-vec",
    text: "Later, once sqlite-vec has a stable release.",
  },
  {
    title: "A libSQL vector index",
    text: "Later, when a scope grows too large for the exact scan libSQL search uses today.",
  },
];

export default function CommunityPage() {
  return (
    <>
      <header className="wrap pt-(--page-top) pb-(--s-5)">
        <h1>
          Built in the <span className="key">open</span>.
        </h1>
        <p className="lead mt-(--s-3) max-w-[28em]">
          Mnemocyte is MIT licensed and developed on GitHub. Issues, fixes and
          better docs are all welcome.
        </p>
        <Button href={REPO_URL} className="mt-(--s-4)">
          View on GitHub
        </Button>
      </header>

      <section className="wrap">
        <h2 className="sr-only">Ways to help</h2>
        <div className="grid grid-cols-3 gap-x-(--s-4) border-t border-ink max-lg:grid-cols-1 max-lg:gap-y-(--s-4)">
          {WAYS_TO_HELP.map(({ title, text, href, link }) => (
            <div key={title} className="pt-(--s-4)">
              <h3>{title}</h3>
              <p className="mt-(--s-1) mb-(--s-3) max-w-[24em] text-ink-soft">
                {text}
              </p>
              <TextLink href={href}>{link}</TextLink>
            </div>
          ))}
        </div>
      </section>

      <section className="pt-(--section)">
        <div className="wrap grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] items-start gap-(--split) max-lg:grid-cols-1">
          <div>
            <h2>What’s next</h2>
            <p className="lead mt-(--s-3) max-w-[20em]">
              The next item on the roadmap, then ideas that wait on a condition.
            </p>
          </div>
          <ul className="m-0 list-none border-t border-ink p-0">
            {NEXT.map(({ title, text }) => (
              <li key={title} className="border-b border-line py-(--s-3)">
                <h3>{title}</h3>
                <p className="mt-1.5 max-w-[34em] text-ink-soft">{text}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
