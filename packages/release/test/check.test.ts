import { describe, expect, it } from "vitest";
import { checkReleases } from "../src/check.ts";
import { PACKAGES } from "../src/packages.ts";
import { lineOf, makeRepo, ROOT_CHANGELOG } from "./repo.ts";

// The fixtures' @mnemocyte/mcp is at 0.1.0, which links to npm; most tests
// check mnemocyte alone.
const MNEMOCYTE = PACKAGES.filter((p) => p.name === "mnemocyte");

function check(root: string): string[] {
	return checkReleases({ root, packages: MNEMOCYTE });
}

describe("checkReleases", () => {
	it("passes the fixtures", () => {
		expect(check(makeRepo())).toEqual([]);
	});

	it("checks every package, reading each one's own changelog", () => {
		const problems = checkReleases({ root: makeRepo(), packages: PACKAGES });
		expect(problems).toEqual([
			'packages/mcp/CHANGELOG.md: no "[0.1.0]: https://github.com/Meenic/mnemocyte/…" link for @mnemocyte/mcp 0.1.0.',
		]);
	});

	it("fails when the package.json version has no heading or link", () => {
		expect(check(makeRepo({ mnemocyteVersion: "1.2.0" }))).toEqual([
			'CHANGELOG.md: mnemocyte is at 1.2.0 in packages/mnemocyte/package.json, but there is no "## [1.2.0] - YYYY-MM-DD" heading.',
			'CHANGELOG.md: no "[1.2.0]: https://github.com/Meenic/mnemocyte/…" link for mnemocyte 1.2.0.',
		]);
	});

	it("fails when the package.json version has no intro paragraph", () => {
		const root = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"The first minor, for teams on Drizzle; see\n[upgrading](docs/guide/upgrading.md#10--11).\n\n",
				"",
			),
		});
		expect(check(root)).toEqual([
			`CHANGELOG.md:${lineOf("## [1.1.0]")}: 1.1.0 has no intro paragraph under its heading.`,
		]);
	});

	it("fails on a heading with a dash instead of a hyphen", () => {
		const root = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"## [1.1.0] - 2026",
				"## [1.1.0] — 2026",
			),
		});
		expect(check(root)).toEqual([
			'CHANGELOG.md: mnemocyte is at 1.1.0 in packages/mnemocyte/package.json, but there is no "## [1.1.0] - YYYY-MM-DD" heading.',
		]);
	});

	it("fails on a version whose link is not in the repository", () => {
		const root = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"[1.1.0]: https://github.com/Meenic/mnemocyte/compare/v1.0.0...v1.1.0",
				"[1.1.0]: https://www.npmjs.com/package/mnemocyte/v/1.1.0",
			),
		});
		expect(check(root)).toEqual([
			'CHANGELOG.md: no "[1.1.0]: https://github.com/Meenic/mnemocyte/…" link for mnemocyte 1.1.0.',
		]);
	});

	it("fails on a lead-in without a final period, in Unreleased and in releases", () => {
		const root = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"**Recall no longer drops the last result.**",
				"**Recall no longer drops the last result**",
			).replace("**Errors name the option.**", "**Errors name the option,**"),
		});
		expect(check(root)).toEqual([
			`CHANGELOG.md:${lineOf("**Recall")}: the lead-in does not end with a period: **Recall no longer drops the last result**`,
			`CHANGELOG.md:${lineOf("**Errors")}: the lead-in does not end with a period: **Errors name the option,**`,
		]);
	});

	it("fails on an entry without a lead-in, from checkedFrom up", () => {
		const root = makeRepo({
			rootChangelog: ROOT_CHANGELOG.replace(
				"- **README rewritten for a first-time user.** Shorter.",
				"- README rewritten for a first-time user.",
			),
		});
		// 0.9.0's entry has no lead-in either; mnemocyte is checked from 1.0.0.
		expect(check(root)).toEqual([
			`CHANGELOG.md:${lineOf("README rewritten")}: the entry has no bold lead-in (**…**).`,
		]);
	});
});
