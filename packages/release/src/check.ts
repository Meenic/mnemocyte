// `pnpm release:check`, run on pull requests and in release.yml's CI run:
// each package's version has its heading and link, and every entry from
// `checkedFrom` up opens with a bold lead-in that ends a sentence, since
// the release text and the site show the lead-ins alone.
import { REPOSITORY_URL, type ReleasePackage } from "./packages.ts";
import {
	findLink,
	findRelease,
	readChangelog,
	readVersion,
	releaseHeading,
} from "./release.ts";
import { compareVersions, isVersion } from "./version.ts";

export interface CheckInput {
	readonly root: string;
	readonly packages: readonly ReleasePackage[];
}

/** One problem, as `file:line: message`. */
export type Problem = string;

const SENTENCE_END = /[.!?]$/;

/** The problems in every package's changelog; empty when all pass. */
export function checkReleases(input: CheckInput): Problem[] {
	return input.packages.flatMap((pkg) => checkPackage(input.root, pkg));
}

function checkPackage(root: string, pkg: ReleasePackage): Problem[] {
	const problems: Problem[] = [];
	const file = pkg.changelog;
	const version = readVersion(root, pkg);
	const changelog = readChangelog(root, pkg);

	if (!findRelease(changelog, version)) {
		problems.push(
			`${file}: ${pkg.name} is at ${version} in ${pkg.directory}/package.json, ` +
				`but there is no "## ${releaseHeading(version, "YYYY-MM-DD")}" heading.`,
		);
	}
	const link = findLink(changelog, version);
	if (!link?.url.startsWith(`${REPOSITORY_URL}/`)) {
		problems.push(
			`${file}: no "[${version}]: ${REPOSITORY_URL}/…" link for ${pkg.name} ${version}.`,
		);
	}

	const sections = [
		...(changelog.unreleased ? [changelog.unreleased] : []),
		...changelog.releases.filter(
			(section) =>
				section.version !== undefined &&
				isVersion(section.version) &&
				compareVersions(section.version, pkg.checkedFrom) >= 0,
		),
	];
	for (const section of sections) {
		for (const group of section.groups) {
			for (const entry of group.entries) {
				if (entry.leadIn === undefined) {
					problems.push(
						`${file}:${entry.line}: the entry has no bold lead-in (**…**).`,
					);
				} else if (!SENTENCE_END.test(entry.leadIn)) {
					problems.push(
						`${file}:${entry.line}: the lead-in does not end with a period: **${entry.leadIn}**`,
					);
				}
			}
		}
	}
	return problems;
}
