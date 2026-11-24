import { describe, expect, it } from "vitest";
import { releaseNotes } from "../src/notes.ts";
import { PACKAGES } from "../src/packages.ts";
import { findPackage } from "../src/release.ts";
import { MCP_CHANGELOG, makeRepo, ROOT_CHANGELOG } from "./repo.ts";

const mnemocyte = findPackage(PACKAGES, "mnemocyte");
const mcp = findPackage(PACKAGES, "@mnemocyte/mcp");
const BLOB = "https://github.com/Meenic/mnemocyte/blob/main";

describe("releaseNotes", () => {
	it("prints the intro, lead-ins by heading, the section and the comparison", () => {
		expect(releaseNotes({ root: makeRepo(), pkg: mnemocyte })).toBe(
			[
				`The first minor, for teams on Drizzle; see [upgrading](${BLOB}/docs/guide/upgrading.md#10--11).`,
				"",
				"### Added",
				"",
				"- Pick the keyword search language.",
				`- \`mnemocyte check\` reads the [installation](${BLOB}/docs/guide/cli.md#check).`,
				"",
				"### Changed",
				"",
				"- Errors name the option.",
				"",
				`Every change in full: [CHANGELOG.md](${BLOB}/CHANGELOG.md#110---2026-11-16)`,
				"",
				"**Full Changelog**: https://github.com/Meenic/mnemocyte/compare/v1.0.0...v1.1.0",
				"",
			].join("\n"),
		);
	});

	it("prints an older version when named", () => {
		const notes = releaseNotes({
			root: makeRepo(),
			pkg: mnemocyte,
			version: "1.0.0",
		});
		expect(notes).toContain(
			"### Documentation\n\n- README rewritten for a first-time user.",
		);
		expect(notes).toContain("compare/v0.9.0...v1.0.0");
	});

	it("resolves links from the changelog's folder and skips the comparison without an earlier tag", () => {
		const changelog = MCP_CHANGELOG.replace(
			"- **The MCP server.**",
			"- **The MCP server, [in the guide](../../docs/guide/mcp.md#tools).**",
		);
		const root = makeRepo({ mcpChangelog: changelog });
		expect(releaseNotes({ root, pkg: mcp })).toBe(
			[
				"The first release: an MCP server for Mnemocyte memory.",
				"",
				"### Added",
				"",
				`- The MCP server, [in the guide](${BLOB}/docs/guide/mcp.md#tools).`,
				"",
				`Every change in full: [CHANGELOG.md](${BLOB}/packages/mcp/CHANGELOG.md#010---2026-11-23)`,
				"",
			].join("\n"),
		);
	});

	it("points an anchor at the changelog itself", () => {
		const root = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"**Errors name the option.**",
				"**Errors name the [option](#100---2026-11-15).**",
			),
		});
		expect(releaseNotes({ root, pkg: mnemocyte })).toContain(
			`- Errors name the [option](${BLOB}/CHANGELOG.md#100---2026-11-15).`,
		);
	});

	it("fails on a missing version, an entry without a lead-in or a link out of the repository", () => {
		expect(() =>
			releaseNotes({ root: makeRepo(), pkg: mnemocyte, version: "1.3.0" }),
		).toThrow('CHANGELOG.md has no "## [1.3.0] - YYYY-MM-DD" heading.');

		const noLeadIn = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"- **Errors name the option.**",
				"- Errors name the option.",
			),
		});
		expect(() => releaseNotes({ root: noLeadIn, pkg: mnemocyte })).toThrow(
			/^CHANGELOG\.md:\d+: the entry has no bold lead-in\.$/,
		);

		const outside = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"(docs/guide/upgrading.md",
				"(../docs/guide/upgrading.md",
			),
		});
		expect(() => releaseNotes({ root: outside, pkg: mnemocyte })).toThrow(
			"links outside the repository",
		);
	});

	it("fails on a reference-style link, which the release text cannot resolve", () => {
		const forms = [
			["**Errors name the option.**", "**Errors name the [option][opt].**"],
			["**Errors name the option.**", "**Errors name the [option][].**"],
			[
				"**Errors name the option.**",
				"**Errors name the option, as [1.0.0].**",
			],
			["see\n[upgrading](", "see [1.0.0] and\n[upgrading]("],
		];
		for (const [from, to] of forms) {
			const root = makeRepo({
				rootChangelog: ROOT_CHANGELOG.replace(from ?? "", to ?? ""),
			});
			expect(() => releaseNotes({ root, pkg: mnemocyte })).toThrow(
				/^CHANGELOG\.md:\d+: write the link inline/,
			);
		}
	});
});
