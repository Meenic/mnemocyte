import { describe, expect, it } from "vitest";
import { parseChangelog } from "../src/changelog.ts";
import { lineOf, MCP_CHANGELOG, ROOT_CHANGELOG } from "./repo.ts";

describe("parseChangelog", () => {
	const changelog = parseChangelog(ROOT_CHANGELOG);

	it("splits Unreleased from the releases, newest first", () => {
		expect(changelog.unreleased?.heading).toBe("[Unreleased]");
		expect(changelog.releases.map((r) => [r.heading, r.version])).toEqual([
			["[1.1.0] - 2026-11-16", "1.1.0"],
			["[1.0.0] - 2026-11-15", "1.0.0"],
			["[0.9.0] - 2026-11-01", "0.9.0"],
		]);
	});

	it("groups the entries by ### heading, with their lead-ins and lines", () => {
		const [minor] = changelog.releases;
		expect(
			minor?.groups.map((g) => [g.heading, g.entries.map((e) => e.leadIn)]),
		).toEqual([
			[
				"Added",
				[
					"Pick the keyword search language.",
					"`mnemocyte check` reads the [installation](docs/guide/cli.md#check).",
				],
			],
			["Changed", ["Errors name the option."]],
		]);
		expect(minor?.groups[0]?.entries[0]?.line).toBe(lineOf("**Pick"));
	});

	it("reads the first paragraph on one line as the intro", () => {
		expect(changelog.releases[0]?.intro).toBe(
			"The first minor, for teams on Drizzle; see [upgrading](docs/guide/upgrading.md#10--11).",
		);
		expect(changelog.unreleased?.intro).toBeUndefined();
	});

	it("puts entries before any ### heading in a group of their own", () => {
		const old = changelog.releases[2];
		expect(old?.groups).toEqual([
			{
				heading: "",
				entries: [{ leadIn: undefined, line: lineOf("before lead-ins") }],
			},
		]);
	});

	it("lists the link definitions", () => {
		expect(changelog.links.map((l) => [l.label, l.line])).toEqual([
			["Unreleased", lineOf("[Unreleased]:")],
			["1.1.0", lineOf("[1.1.0]:")],
			["1.0.0", lineOf("[1.0.0]:")],
			["0.9.0", lineOf("[0.9.0]:")],
		]);
		const [first] = changelog.links;
		expect(ROOT_CHANGELOG.slice(first?.start, first?.end)).toBe(
			"[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v1.1.0...HEAD",
		);
	});

	it("keeps a section's Markdown and its offsets", () => {
		const unreleased = changelog.unreleased;
		expect(unreleased?.markdown.startsWith("### Added\n\n- **Save")).toBe(true);
		expect(
			ROOT_CHANGELOG.slice(0, unreleased?.headingEnd).endsWith(
				"## [Unreleased]",
			),
		).toBe(true);
		expect(ROOT_CHANGELOG.slice(unreleased?.end).startsWith("## [1.1.0]")).toBe(
			true,
		);
	});

	it("reads a changelog with an empty Unreleased and no Unreleased link", () => {
		const mcp = parseChangelog(MCP_CHANGELOG);
		expect(mcp.unreleased?.groups).toEqual([]);
		expect(mcp.releases.map((r) => r.version)).toEqual(["0.1.0"]);
		expect(mcp.links.map((l) => l.label)).toEqual(["0.1.0"]);
	});
});
