import { describe, expect, it } from "vitest";
import { PACKAGES } from "../src/packages.ts";
import {
	applyReleases,
	type PlannedRelease,
	parseRequest,
	planReleases,
} from "../src/prepare.ts";
import { MCP_CHANGELOG, makeRepo, ROOT_CHANGELOG, read } from "./repo.ts";

function plan(root: string, ...args: string[]): PlannedRelease[] {
	return planReleases({
		root,
		packages: PACKAGES,
		requests: args.map(parseRequest),
		date: "2026-11-25",
	});
}

const MCP_WITH_FIX = MCP_CHANGELOG.replace(
	"## [Unreleased]\n",
	"## [Unreleased]\n\n### Fixed\n\n- **A fix.** Details.\n",
);

describe("parseRequest", () => {
	it("splits a name from its version, keeping a scope's @", () => {
		expect(parseRequest("mnemocyte")).toEqual({
			name: "mnemocyte",
			spec: undefined,
		});
		expect(parseRequest("mnemocyte@1.5.0-rc.1")).toEqual({
			name: "mnemocyte",
			spec: "1.5.0-rc.1",
		});
		expect(parseRequest("@mnemocyte/mcp")).toEqual({
			name: "@mnemocyte/mcp",
			spec: undefined,
		});
		expect(parseRequest("@mnemocyte/mcp@minor")).toEqual({
			name: "@mnemocyte/mcp",
			spec: "minor",
		});
		expect(() => parseRequest("mnemocyte@")).toThrow("names no version");
	});
});

describe("planReleases", () => {
	it("proposes minor for an Added section", () => {
		const [release] = plan(makeRepo(), "mnemocyte");
		expect([release?.from, release?.to, release?.reason]).toEqual([
			"1.1.0",
			"1.2.0",
			"minor: Added",
		]);
	});

	it("proposes minor for a Deprecated section", () => {
		const root = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"### Added\n\n- **Save",
				"### Deprecated\n\n- **Save",
			),
		});
		expect(plan(root, "mnemocyte")[0]?.reason).toBe("minor: Deprecated");
	});

	it("proposes patch otherwise", () => {
		const root = makeRepo({ mcpChangelog: MCP_WITH_FIX });
		const [release] = plan(root, "@mnemocyte/mcp");
		expect([release?.to, release?.reason]).toEqual([
			"0.1.1",
			"patch: no Added or Deprecated",
		]);
	});

	it("stops on a **Breaking** entry or section unless the version is named", () => {
		const entry = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"**Recall no",
				"**Breaking: recall no",
			),
		});
		expect(() => plan(entry, "mnemocyte")).toThrow("**Breaking**");
		expect(plan(entry, "mnemocyte@2.0.0")[0]?.to).toBe("2.0.0");
		expect(plan(entry, "mnemocyte@major")[0]?.reason).toBe("given: major");

		const section = makeRepo({
			mcpChangelog: MCP_WITH_FIX.replace("### Fixed", "### Breaking Changes"),
		});
		expect(() => plan(section, "@mnemocyte/mcp")).toThrow(
			"@mnemocyte/mcp@<version>",
		);
		expect(plan(section, "@mnemocyte/mcp@minor")[0]?.to).toBe("0.2.0");
	});

	it("takes a prerelease version as given", () => {
		const [release] = plan(makeRepo(), "mnemocyte@1.2.0-rc.1");
		expect([release?.to, release?.reason]).toEqual(["1.2.0-rc.1", "given"]);
	});

	it("refuses a version that is not after the current one", () => {
		expect(() => plan(makeRepo(), "mnemocyte@1.1.0")).toThrow(
			"1.1.0 is not after 1.1.0",
		);
		expect(() => plan(makeRepo(), "mnemocyte@1.0.5")).toThrow("is not after");
		expect(() => plan(makeRepo(), "mnemocyte@next")).toThrow(
			'"next" is not a version',
		);
	});

	it("refuses an empty Unreleased, an unknown or repeated package, and none", () => {
		expect(() => plan(makeRepo(), "@mnemocyte/mcp")).toThrow(
			"no entries under [Unreleased]",
		);
		expect(() => plan(makeRepo(), "mcp")).toThrow(
			'Unknown package "mcp". Packages: mnemocyte, @mnemocyte/mcp.',
		);
		expect(() => plan(makeRepo(), "mnemocyte", "mnemocyte@minor")).toThrow(
			"named twice",
		);
		expect(() => plan(makeRepo())).toThrow("at least one package");
	});

	it("refuses a version the changelog already has", () => {
		const root = makeRepo({ mnemocyteVersion: "1.0.0" });
		expect(() => plan(root, "mnemocyte@1.1.0")).toThrow("already has 1.1.0");
	});

	it("moves Unreleased under the new heading and updates the links", () => {
		const text = plan(makeRepo(), "mnemocyte")[0]?.changelog ?? "";
		expect(text).toContain(
			"## [Unreleased]\n\n## [1.2.0] - 2026-11-25\n\n### Added\n\n- **Save memories",
		);
		const links = [
			"[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v1.2.0...HEAD",
			"[1.2.0]: https://github.com/Meenic/mnemocyte/compare/v1.1.0...v1.2.0",
			"[1.1.0]: https://github.com/Meenic/mnemocyte/compare/v1.0.0...v1.1.0",
		];
		expect(text).toContain(links.join("\n"));
		// Nothing else changes.
		const undone = text
			.replace("\n\n## [1.2.0] - 2026-11-25", "")
			.replace(
				`${links[0]}\n${links[1]}`,
				"[Unreleased]: https://github.com/Meenic/mnemocyte/compare/v1.1.0...HEAD",
			);
		expect(undone).toBe(ROOT_CHANGELOG);
	});

	it("links a first tagged version to its tag, above an npm-only one", () => {
		const root = makeRepo({ mcpChangelog: MCP_WITH_FIX });
		expect(plan(root, "@mnemocyte/mcp")[0]?.changelog).toContain(
			[
				"[0.1.1]: https://github.com/Meenic/mnemocyte/releases/tag/mcp-v0.1.1",
				"[0.1.0]: https://www.npmjs.com/package/@mnemocyte/mcp/v/0.1.0",
			].join("\n"),
		);
	});

	it("compares with the last tagged version", () => {
		const tagged = MCP_WITH_FIX.replace(
			"## [0.1.0]",
			"## [0.2.0] - 2026-11-24\n\nSecond.\n\n### Added\n\n- **More.** Yes.\n\n## [0.1.0]",
		).replace(
			"[0.1.0]: https",
			"[0.2.0]: https://github.com/Meenic/mnemocyte/releases/tag/mcp-v0.2.0\n[0.1.0]: https",
		);
		const root = makeRepo({ mcpChangelog: tagged, mcpVersion: "0.2.0" });
		expect(plan(root, "@mnemocyte/mcp")[0]?.changelog).toContain(
			"[0.2.1]: https://github.com/Meenic/mnemocyte/compare/mcp-v0.2.0...mcp-v0.2.1\n[0.2.0]:",
		);
	});

	it("adds the first link at the end of a changelog with none", () => {
		const root = makeRepo({
			mcpChangelog:
				"# Changelog\n\n## [Unreleased]\n\n### Added\n\n- **First.** Yes.\n",
			mcpVersion: "0.0.0",
		});
		expect(plan(root, "@mnemocyte/mcp")[0]?.changelog).toBe(
			"# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-25\n\n### Added\n\n- **First.** Yes.\n\n" +
				"[0.1.0]: https://github.com/Meenic/mnemocyte/releases/tag/mcp-v0.1.0\n",
		);
	});

	it("refuses a date that is not YYYY-MM-DD", () => {
		expect(() =>
			planReleases({
				root: makeRepo(),
				packages: PACKAGES,
				requests: [parseRequest("mnemocyte")],
				date: "25.11.2026",
			}),
		).toThrow("YYYY-MM-DD");
	});
});

describe("applyReleases", () => {
	it("writes each changelog, then sets each version", () => {
		const root = makeRepo({ mcpChangelog: MCP_WITH_FIX });
		const releases = plan(root, "mnemocyte", "@mnemocyte/mcp");
		const calls: [string, string][] = [];
		applyReleases({
			root,
			releases,
			setVersion: ({ directory, version }) => {
				const folder = directory.replace(/\\/g, "/").split("/").slice(-2);
				calls.push([folder.join("/"), version]);
			},
		});

		expect(read(root, "CHANGELOG.md")).toBe(releases[0]?.changelog);
		expect(read(root, "packages/mcp/CHANGELOG.md")).toContain(
			"## [0.1.1] - 2026-11-25",
		);
		expect(calls).toEqual([
			["packages/mnemocyte", "1.2.0"],
			["packages/mcp", "0.1.1"],
		]);
	});

	it("writes nothing when one of the packages cannot go out", () => {
		const root = makeRepo();
		expect(() => plan(root, "mnemocyte", "@mnemocyte/mcp")).toThrow(
			"no entries",
		);
		expect(read(root, "CHANGELOG.md")).toBe(ROOT_CHANGELOG);
	});
});
