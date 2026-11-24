// The packages this repository publishes, read by the release scripts
// (and, from `chore/release-on-main`, by release.yml). This file imports
// nothing, so a workflow job can read it with Node before installing.

/** The GitHub repository every link and tag belongs to. */
export const REPOSITORY_URL = "https://github.com/Meenic/mnemocyte";

/** A published package and how it is released. */
export interface ReleasePackage {
	/** The npm name, which is also how the scripts name the package. */
	readonly name: string;
	/** The package folder, from the repository root. */
	readonly directory: string;
	/** The package's changelog, from the repository root. */
	readonly changelog: string;
	/** What goes before the version in its git tag: `v`, `mcp-v`. */
	readonly tagPrefix: string;
	/** What goes before ` vX.Y.Z` in its GitHub release title. */
	readonly title: string;
	/** Whether its GitHub releases are marked as the repository's latest. */
	readonly latest: boolean;
	/**
	 * The oldest release whose entries `release:check` reads. Older sections
	 * predate the lead-in format.
	 */
	readonly checkedFrom: string;
}

export const PACKAGES: readonly ReleasePackage[] = [
	{
		name: "mnemocyte",
		directory: "packages/mnemocyte",
		changelog: "CHANGELOG.md",
		tagPrefix: "v",
		title: "mnemocyte",
		latest: true,
		checkedFrom: "1.0.0",
	},
	{
		name: "@mnemocyte/mcp",
		directory: "packages/mcp",
		changelog: "packages/mcp/CHANGELOG.md",
		tagPrefix: "mcp-v",
		title: "@mnemocyte/mcp",
		latest: false,
		checkedFrom: "0.1.0",
	},
];

/** The package's git tag for a version: `v1.4.0`, `mcp-v0.2.0`. */
export function tagName(pkg: ReleasePackage, version: string): string {
	return `${pkg.tagPrefix}${version}`;
}

/** The GitHub release title for a version: `@mnemocyte/mcp v0.2.0`. */
export function releaseTitle(pkg: ReleasePackage, version: string): string {
	return `${pkg.title} v${version}`;
}
