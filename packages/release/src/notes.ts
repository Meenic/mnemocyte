// `pnpm release:notes`: a version's GitHub release text (decision 99): the
// intro, how to install a prerelease, each entry's bold lead-in under its
// heading, a link to the full section and a compare link when there is an
// earlier tag.
import { REPOSITORY_URL, type ReleasePackage, tagName } from "./packages.ts";
import {
	absoluteLinks,
	assertInlineLinks,
	findRelease,
	previousTag,
	ReleaseError,
	readChangelog,
	readVersion,
	sectionUrl,
} from "./release.ts";

export interface NotesInput {
	readonly root: string;
	readonly pkg: ReleasePackage;
	/** The version; the one in the package's package.json when omitted. */
	readonly version?: string | undefined;
}

/** The release text as Markdown, ending with a newline. */
export function releaseNotes(input: NotesInput): string {
	const { root, pkg } = input;
	const version = input.version ?? readVersion(root, pkg);
	const changelog = readChangelog(root, pkg);
	const section = findRelease(changelog, version);
	if (!section) {
		throw new ReleaseError(
			`${pkg.changelog} has no "## [${version}] - YYYY-MM-DD" heading.`,
		);
	}
	if (section.intro === undefined) {
		throw new ReleaseError(
			`${pkg.changelog}:${section.line}: ${version} has no intro paragraph.`,
		);
	}

	assertInlineLinks(
		section.intro,
		changelog,
		`${pkg.changelog}:${section.line}`,
	);
	const blocks: string[] = [absoluteLinks(section.intro, pkg)];
	// release.yml publishes a prerelease under the next dist-tag.
	if (version.includes("-")) {
		blocks.push(
			`This is a prerelease: install it with \`npm install ${pkg.name}@next\`.`,
		);
	}
	for (const group of section.groups) {
		if (group.entries.length === 0) continue;
		const lines = group.entries.map((entry) => {
			const where = `${pkg.changelog}:${entry.line}`;
			if (entry.leadIn === undefined) {
				throw new ReleaseError(`${where}: the entry has no bold lead-in.`);
			}
			assertInlineLinks(entry.leadIn, changelog, where);
			return `- ${absoluteLinks(entry.leadIn, pkg)}`;
		});
		blocks.push(
			group.heading === ""
				? lines.join("\n")
				: `### ${group.heading}\n\n${lines.join("\n")}`,
		);
	}

	const file = pkg.changelog.split("/").at(-1) ?? pkg.changelog;
	blocks.push(`Every change in full: [${file}](${sectionUrl(pkg, section)})`);
	const previous = previousTag(changelog, pkg, version);
	if (previous) {
		blocks.push(
			`**Full Changelog**: ${REPOSITORY_URL}/compare/${previous}...${tagName(pkg, version)}`,
		);
	}
	return `${blocks.join("\n\n")}\n`;
}
