import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseChangelog as parseSections,
  type ChangelogSection as Section,
} from "@mnemocyte/release/changelog";
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
 * fails the build. The parsing is shared with the release scripts
 * (`@mnemocyte/release`), so the release text lists the same lead-ins.
 */
export function parseChangelog(source: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];

  for (const section of parseSections(source).releases) {
    const version = parseVersion(section.heading);
    if (version && compareVersions(version, FIRST_SHOWN) < 0) break;

    sections.push(
      toRelease(section) ?? {
        kind: "raw",
        heading: section.heading,
        markdown: section.markdown,
      },
    );
  }

  return sections;
}

/** The changelog of the repository, read once at build time. */
export async function getChangelog(): Promise<ChangelogSection[]> {
  "use cache";
  cacheLife("max");
  // The site lives in apps/site/ of the library's repository.
  const source = await readFile(
    join(process.cwd(), "..", "..", "CHANGELOG.md"),
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

function toRelease(section: Section): Release | undefined {
  const match = HEADING.exec(section.heading);
  if (!match || section.intro === undefined) return undefined;

  const entries: string[] = [];
  for (const group of section.groups) {
    for (const entry of group.entries) {
      if (entry.leadIn === undefined) return undefined;
      entries.push(entry.leadIn);
    }
  }
  if (entries.length === 0) return undefined;

  return {
    kind: "release",
    version: match[1],
    date: match[2],
    title: section.intro,
    entries,
  };
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
