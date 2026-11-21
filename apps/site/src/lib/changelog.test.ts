import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatDate, parseChangelog, type Release } from "./changelog";

/* The top of the real CHANGELOG.md, from the intro to 1.0.0-rc.2. */
const fixture = readFileSync(
  new URL("./fixtures/changelog.md", import.meta.url),
  "utf8",
);

function releases(source: string): Release[] {
  return parseChangelog(source).filter(
    (section): section is Release => section.kind === "release",
  );
}

describe("parseChangelog", () => {
  it("reads the releases from 1.0.0 up, newest first", () => {
    const sections = parseChangelog(fixture);
    expect(sections.map((s) => s.kind)).toEqual([
      "release",
      "release",
      "release",
      "release",
    ]);
    expect(releases(fixture).map((r) => [r.version, r.date])).toEqual([
      ["1.2.0", "2026-11-16"],
      ["1.1.0", "2026-11-16"],
      ["1.0.1", "2026-11-15"],
      ["1.0.0", "2026-11-15"],
    ]);
  });

  it("uses the first paragraph, on one line, as the title", () => {
    const [, , patch] = releases(fixture);
    expect(patch.title).toBe(
      "A patch release: the hints that tell you how to run `migrate` now work in pnpm projects. No API change.",
    );
  });

  it("lists the bold lead-in of every entry, across subsections", () => {
    const [minor, feature, patch, stable] = releases(fixture);
    expect(minor.entries).toEqual([
      "Pick the keyword search language.",
      "`setTextSearchConfig` and `mnemocyte text-search <name>`.",
      "`TEXT_SEARCH_CONFIG_MISMATCH`.",
      "Keep the tables in their own schema.",
      "Let drizzle-kit manage the tables.",
      "`mnemocyte check` on a schema installed without `migrate`",
    ]);
    expect(feature.entries).toHaveLength(18);
    expect(feature.entries).toContain(
      "`listAuditLog({ memoryId })` and migration `0004_audit_memory_id.sql`.",
    );
    expect(patch.entries).toEqual([
      "The `migrate` hints no longer name `npx`.",
    ]);
    expect(stable.entries).toEqual([
      "README and guides rewritten for a first-time user.",
      "The guides run the command with `pnpm exec mnemocyte`.",
    ]);
  });

  it("skips Unreleased and stops before the 1.0.0 release candidates", () => {
    const versions = releases(fixture).map((r) => r.version);
    expect(versions).not.toContain("1.0.0-rc.2");
    expect(
      parseChangelog("## [Unreleased]\n\n### Fixed\n\n- **A.** b\n"),
    ).toEqual([]);
  });

  it("returns a section without a bold lead-in as Markdown", () => {
    const source = fixture.replace(
      "- **The `migrate` hints no longer name `npx`.** In a project",
      "- The `migrate` hints no longer name `npx`. In a project",
    );
    const raw = parseChangelog(source)[2];
    expect(raw).toMatchObject({
      kind: "raw",
      heading: "[1.0.1] - 2026-11-15",
    });
    expect(raw.kind === "raw" && raw.markdown).toMatch(
      /^A patch release:[\s\S]*The error code and reason are unchanged\.$/,
    );
    expect(releases(source).map((r) => r.version)).toEqual([
      "1.2.0",
      "1.1.0",
      "1.0.0",
    ]);
  });

  it("returns a section with an unexpected heading as Markdown", () => {
    const source = fixture.replace(
      "## [1.0.1] - 2026-11-15",
      "## [1.0.1] - soon",
    );
    expect(parseChangelog(source)[2]).toMatchObject({
      kind: "raw",
      heading: "[1.0.1] - soon",
    });
  });

  it("returns a section without a summary paragraph as Markdown", () => {
    const source = "## [2.0.0] - 2027-01-01\n\n### Changed\n\n- **A.** b\n";
    expect(parseChangelog(source)).toEqual([
      {
        kind: "raw",
        heading: "[2.0.0] - 2027-01-01",
        markdown: "### Changed\n\n- **A.** b",
      },
    ]);
  });

  it("accepts an em dash between version and date", () => {
    const source = "## [1.3.0] — 2026-12-01\n\nSummary.\n\n- **A.** b\n";
    expect(parseChangelog(source)).toEqual([
      {
        kind: "release",
        version: "1.3.0",
        date: "2026-12-01",
        title: "Summary.",
        entries: ["A."],
      },
    ]);
  });
});

describe("formatDate", () => {
  it("writes the day, month name and year", () => {
    expect(formatDate("2026-11-16")).toBe("16 November 2026");
  });
});
