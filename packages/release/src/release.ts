// What release:prepare, release:notes and release:check share: finding a
// package, reading its version and changelog, and the links between them.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { slug } from "github-slugger";
import {
	type Changelog,
	type ChangelogSection,
	parseChangelog,
} from "./changelog.ts";
import { REPOSITORY_URL, type ReleasePackage, tagName } from "./packages.ts";

/** A failure the scripts report as one line, without a stack trace. */
export class ReleaseError extends Error {
	override name = "ReleaseError";
}

/** The package with this npm name. */
export function findPackage(
	packages: readonly ReleasePackage[],
	name: string,
): ReleasePackage {
	const pkg = packages.find((p) => p.name === name);
	if (pkg) return pkg;
	const names = packages.map((p) => p.name).join(", ");
	throw new ReleaseError(`Unknown package "${name}". Packages: ${names}.`);
}

/** The version in the package's package.json. */
export function readVersion(root: string, pkg: ReleasePackage): string {
	const file = join(root, pkg.directory, "package.json");
	const json: unknown = JSON.parse(readFileSync(file, "utf8"));
	const version =
		typeof json === "object" && json !== null && "version" in json
			? json.version
			: undefined;
	if (typeof version !== "string") {
		throw new ReleaseError(`${pkg.directory}/package.json has no version.`);
	}
	return version;
}

/** The package's changelog, parsed, with its source normalized to LF. */
export function readChangelog(root: string, pkg: ReleasePackage): Changelog {
	const source = readFileSync(join(root, pkg.changelog), "utf8");
	return parseChangelog(source.replace(/\r\n/g, "\n"));
}

/** `## [X.Y.Z] - YYYY-MM-DD`, the heading release.yml checks for. */
export function releaseHeading(version: string, date: string): string {
	return `[${version}] - ${date}`;
}

const HEADING = /^\[([^\]]+)\] - \d{4}-\d{2}-\d{2}$/;

/** The section with a `## [version] - YYYY-MM-DD` heading. */
export function findRelease(
	changelog: Changelog,
	version: string,
): ChangelogSection | undefined {
	return changelog.releases.find(
		(section) => HEADING.exec(section.heading)?.[1] === version,
	);
}

/** The link definition for a label, matched as Markdown does (any case). */
export function findLink(
	changelog: Changelog,
	label: string,
): Changelog["links"][number] | undefined {
	const wanted = label.toLowerCase();
	return changelog.links.find((link) => link.label.toLowerCase() === wanted);
}

const TAGGED = new RegExp(
	`^${escapeRegExp(REPOSITORY_URL)}/(?:compare/[^/]+\\.\\.\\.|releases/tag/)`,
);

/**
 * The tag of the newest release older than `version` that has one: its
 * link is a compare or tag URL in this repository. A release published
 * without a tag, as `@mnemocyte/mcp` 0.1.0 was, links to npm instead.
 */
export function previousTag(
	changelog: Changelog,
	pkg: ReleasePackage,
	version: string,
): string | undefined {
	const index = changelog.releases.findIndex(
		(section) => section.version === version,
	);
	const older =
		index === -1 ? changelog.releases : changelog.releases.slice(index + 1);
	for (const section of older) {
		if (section.version === undefined) continue;
		const link = findLink(changelog, section.version);
		if (link && TAGGED.test(link.url)) return tagName(pkg, section.version);
	}
	return undefined;
}

/** The URL of a version's link: a compare from the last tag, or the tag. */
export function versionUrl(
	changelog: Changelog,
	pkg: ReleasePackage,
	version: string,
): string {
	const tag = tagName(pkg, version);
	const previous = previousTag(changelog, pkg, version);
	return previous
		? `${REPOSITORY_URL}/compare/${previous}...${tag}`
		: `${REPOSITORY_URL}/releases/tag/${tag}`;
}

/** A file in the repository on GitHub, on main, as decision 74 links. */
export function blobUrl(path: string): string {
	return `${REPOSITORY_URL}/blob/main/${path}`;
}

/** The GitHub URL of a section's heading in the package's changelog. */
export function sectionUrl(
	pkg: ReleasePackage,
	section: ChangelogSection,
): string {
	return `${blobUrl(pkg.changelog)}#${slug(section.heading.replace(/[[\]]/g, ""))}`;
}

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * Turns the relative links in a changelog's Markdown into GitHub URLs on
 * main: `docs/…` from the root changelog, `../../docs/…` from the MCP one,
 * and `#anchor` into the changelog's own heading.
 */
export function absoluteLinks(markdown: string, pkg: ReleasePackage): string {
	const folder = posix.dirname(pkg.changelog);
	const absolute = (href: string): string => {
		if (EXTERNAL.test(href)) return href;
		if (href.startsWith("#")) return `${blobUrl(pkg.changelog)}${href}`;
		const path = posix.normalize(
			href.startsWith("/") ? href.slice(1) : posix.join(folder, href),
		);
		if (path.startsWith("..")) {
			throw new ReleaseError(
				`${pkg.changelog} links outside the repository: ${href}`,
			);
		}
		return blobUrl(path);
	};
	return markdown.replace(
		/\]\(\s*(<[^>\n]*>|[^)\s]+)/g,
		(_match, href: string) =>
			href.startsWith("<")
				? `](<${absolute(href.slice(1, -1))}>`
				: `](${absolute(href)}`,
	);
}

/**
 * Throws on a reference-style link (`[text][label]`, `[text][]`, or
 * `[label]` alone when the changelog defines it): the release text does
 * not carry the definitions, so it would show the brackets as written.
 */
export function assertInlineLinks(
	markdown: string,
	changelog: Changelog,
	where: string,
): void {
	const labels = changelog.links.map((link) => escapeRegExp(link.label));
	const shortcut =
		labels.length > 0
			? new RegExp(`\\[(?:${labels.join("|")})\\](?![(:])`, "i")
			: undefined;
	if (/\]\[/.test(markdown) || shortcut?.test(markdown)) {
		throw new ReleaseError(
			`${where}: write the link inline, [text](url); the release text has no link definitions.`,
		);
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
