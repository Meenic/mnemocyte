import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Heading, ListItem, RootContent, Strong } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { cacheLife } from "next/cache";

/** A release in the expected shape: heading, summary, bold lead-ins. */
export interface Release {
  kind: "release";
  version: string;
  /** ISO date, as written in the heading (2026-11-16). */
  date: string;
  /** The first paragraph, as Markdown on one line. */
  title: string;
  /** The bold lead-in of each entry, as Markdown, without the `**`. */
  entries: string[];
}

/** A section that doesn't match the expected shape, shown as written. */
export interface RawSection {
  kind: "raw";
  /** The heading text without `## `, such as `[1.3.0] - 2026-12-01`. */
  heading: string;
  /** The section's Markdown below its heading. */
  markdown: string;
}

export type ChangelogSection = Release | RawSection;

/** The oldest release the site shows. */
const FIRST_SHOWN = [1, 0, 0, 1]; // 1.0.0, as parseVersion reads it

/**
 * Reads the sections of a Keep a Changelog file from 1.0.0 up, newest first.
 * "Unreleased" is skipped. A release whose heading or body doesn't match is
 * returned as a `RawSection` instead of throwing, so an odd entry never
 * fails the build.
 */
export function parseChangelog(source: string): ChangelogSection[] {
  const tree = fromMarkdown(source);
  const sections: ChangelogSection[] = [];
  const nodes = tree.children;

  for (let i = 0; i < nodes.length; i++) {
    const heading = nodes[i];
    if (heading.type !== "heading" || heading.depth !== 2) continue;

    let end = i + 1;
    while (end < nodes.length && !isSectionBreak(nodes[end])) end++;
    const body = nodes.slice(i + 1, end);

    const headingText = collapse(sliceInner(source, heading));
    if (/^\[?unreleased\]?$/i.test(headingText)) continue;

    const version = parseVersion(headingText);
    if (version && compareVersions(version, FIRST_SHOWN) < 0) break;

    sections.push(
      parseRelease(source, headingText, body) ?? {
        kind: "raw",
        heading: headingText,
        markdown: sliceBody(source, heading, nodes[end]),
      },
    );
  }

  return sections;
}

/** The changelog of the repository, read once at build time. */
export async function getChangelog(): Promise<ChangelogSection[]> {
  "use cache";
  cacheLife("max");
  // The site lives in site/ of the library's repository.
  const source = await readFile(
    join(process.cwd(), "..", "CHANGELOG.md"),
    "utf8",
  );
  return parseChangelog(source);
}

/** "2026-11-16" as "16 November 2026". */
export function formatDate(date: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

const HEADING =
  /^\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?\s+[-–—]\s+(\d{4}-\d{2}-\d{2})$/;

function parseRelease(
  source: string,
  heading: string,
  body: RootContent[],
): Release | undefined {
  const match = HEADING.exec(heading);
  if (!match) return undefined;

  const [first, ...rest] = body;
  if (first?.type !== "paragraph") return undefined;

  const entries: string[] = [];
  for (const node of rest) {
    if (node.type !== "list") continue;
    for (const item of node.children) {
      const leadIn = readLeadIn(source, item);
      if (leadIn === undefined) return undefined;
      entries.push(leadIn);
    }
  }
  if (entries.length === 0) return undefined;

  return {
    kind: "release",
    version: match[1],
    date: match[2],
    title: collapse(slice(source, first)),
    entries,
  };
}

/** The bold text an entry opens with, or undefined when it has none. */
function readLeadIn(source: string, item: ListItem): string | undefined {
  const paragraph = item.children[0];
  if (paragraph?.type !== "paragraph") return undefined;
  const strong = paragraph.children[0];
  if (strong?.type !== "strong" || strong.children.length === 0) {
    return undefined;
  }
  const text = collapse(sliceInner(source, strong));
  return text === "" ? undefined : text;
}

/** A new `#` or `##` heading ends a release section. */
function isSectionBreak(node: RootContent): boolean {
  return node.type === "heading" && node.depth <= 2;
}

/** `1.2.0` or `1.0.0-rc.2` at the start of a heading, if there is one. */
function parseVersion(text: string): number[] | undefined {
  const match = /^\[?v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(text);
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  // A prerelease sorts before its release: 1.0.0-rc.2 < 1.0.0.
  return [Number(major), Number(minor), Number(patch), prerelease ? 0 : 1];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** The source text of a node. */
function slice(source: string, node: RootContent): string {
  return source.slice(node.position?.start.offset, node.position?.end.offset);
}

/** The source text of a node's children, without its own markers. */
function sliceInner(source: string, node: Heading | Strong): string {
  const first = node.children[0];
  const last = node.children.at(-1);
  if (!first || !last) return "";
  return source.slice(first.position?.start.offset, last.position?.end.offset);
}

/** Everything between a heading and the next section, trimmed. */
function sliceBody(
  source: string,
  heading: Heading,
  next: RootContent | undefined,
): string {
  return source
    .slice(heading.position?.end.offset, next?.position?.start.offset)
    .trim();
}

/** Joins wrapped lines into one: "a\n  b" becomes "a b". */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
