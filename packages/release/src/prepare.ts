// `pnpm release:prepare`: bumps the packages given and moves each
// `[Unreleased]` section under the new version's heading, with its link.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Changelog } from "./changelog.ts";
import { REPOSITORY_URL, type ReleasePackage, tagName } from "./packages.ts";
import {
	findLink,
	findPackage,
	findRelease,
	ReleaseError,
	readChangelog,
	readVersion,
	releaseHeading,
	versionUrl,
} from "./release.ts";
import {
	type Bump,
	bumpVersion,
	compareVersions,
	isVersion,
} from "./version.ts";

/** One package to release: `mnemocyte`, `@mnemocyte/mcp@minor`. */
export interface ReleaseRequest {
	readonly name: string;
	/** A version or a bump that overrides the proposed one. */
	readonly spec: string | undefined;
}

/** A release worked out from the changelog, before anything is written. */
export interface PlannedRelease {
	readonly pkg: ReleasePackage;
	readonly from: string;
	readonly to: string;
	/** Why this version: `minor: Added`, `given`. */
	readonly reason: string;
	/** The changelog with `[Unreleased]` moved under the new version. */
	readonly changelog: string;
}

export interface PrepareInput {
	/** The repository root. */
	readonly root: string;
	readonly packages: readonly ReleasePackage[];
	readonly requests: readonly ReleaseRequest[];
	/** The release date, `YYYY-MM-DD`. */
	readonly date: string;
}

export interface ApplyInput {
	readonly root: string;
	readonly releases: readonly PlannedRelease[];
	/** Sets a package's version; `pnpm version` unless a test replaces it. */
	readonly setVersion?: (input: {
		readonly directory: string;
		readonly version: string;
	}) => void;
}

/** `name` or `name@spec`; a scoped name keeps its leading `@`. */
export function parseRequest(arg: string): ReleaseRequest {
	const at = arg.lastIndexOf("@");
	if (at <= 0) return { name: arg, spec: undefined };
	const spec = arg.slice(at + 1);
	if (spec === "") {
		throw new ReleaseError(`"${arg}" names no version after the @.`);
	}
	return { name: arg.slice(0, at), spec };
}

const BUMPS: readonly Bump[] = ["patch", "minor", "major"];

function isBump(spec: string): spec is Bump {
	return (BUMPS as readonly string[]).includes(spec);
}

/**
 * Works out each release and its new changelog, and throws before anything
 * is written when one of them cannot go out.
 */
export function planReleases(input: PrepareInput): PlannedRelease[] {
	if (input.requests.length === 0) {
		throw new ReleaseError("Name at least one package to release.");
	}
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
		throw new ReleaseError(`The date must be YYYY-MM-DD: ${input.date}`);
	}
	const seen = new Set<string>();
	return input.requests.map((request) => {
		const pkg = findPackage(input.packages, request.name);
		if (seen.has(pkg.name)) {
			throw new ReleaseError(`${pkg.name} is named twice.`);
		}
		seen.add(pkg.name);
		return planRelease(input, pkg, request.spec);
	});
}

function planRelease(
	input: PrepareInput,
	pkg: ReleasePackage,
	spec: string | undefined,
): PlannedRelease {
	const from = readVersion(input.root, pkg);
	const changelog = readChangelog(input.root, pkg);
	const unreleased = changelog.unreleased;
	if (!unreleased) {
		throw new ReleaseError(`${pkg.changelog} has no "## [Unreleased]".`);
	}
	const entries = unreleased.groups.flatMap((group) => group.entries);
	if (entries.length === 0) {
		throw new ReleaseError(
			`${pkg.changelog} has no entries under [Unreleased] for ${pkg.name}.`,
		);
	}

	let to: string;
	let reason: string;
	if (spec === undefined) {
		const breaking =
			unreleased.groups.some((group) => /breaking/i.test(group.heading)) ||
			entries.some((entry) => /^breaking\b/i.test(entry.leadIn ?? ""));
		if (breaking) {
			throw new ReleaseError(
				`${pkg.changelog} has a **Breaking** entry under [Unreleased]. ` +
					`Name the version yourself: ${pkg.name}@<version>.`,
			);
		}
		const headings = unreleased.groups.map((group) => group.heading);
		const minor = headings.find((h) => /^(added|deprecated)$/i.test(h));
		const bump: Bump = minor ? "minor" : "patch";
		to = bumpVersion(from, bump);
		reason = minor ? `minor: ${minor}` : "patch: no Added or Deprecated";
	} else if (isBump(spec)) {
		to = bumpVersion(from, spec);
		reason = `given: ${spec}`;
	} else if (isVersion(spec)) {
		to = spec;
		reason = "given";
	} else {
		throw new ReleaseError(
			`"${spec}" is not a version or one of ${BUMPS.join(", ")}.`,
		);
	}

	if (compareVersions(to, from) <= 0) {
		throw new ReleaseError(`${pkg.name} ${to} is not after ${from}.`);
	}
	if (findRelease(changelog, to)) {
		throw new ReleaseError(`${pkg.changelog} already has ${to}.`);
	}

	return {
		pkg,
		from,
		to,
		reason,
		changelog: moveUnreleased(changelog, pkg, to, input.date),
	};
}

/** The changelog with `[Unreleased]`'s entries under `## [to] - date`. */
function moveUnreleased(
	changelog: Changelog,
	pkg: ReleasePackage,
	to: string,
	date: string,
): string {
	const { source } = changelog;
	const unreleased = changelog.unreleased;
	if (!unreleased) throw new ReleaseError(`${pkg.changelog}: no Unreleased.`);

	// Edits from the end of the file backwards, so earlier offsets hold.
	const edits: { at: number; remove: number; text: string }[] = [];
	const definition = `[${to}]: ${versionUrl(changelog, pkg, to)}`;
	const unreleasedLink = findLink(changelog, "Unreleased");
	if (unreleasedLink) {
		const label = source.slice(
			unreleasedLink.start,
			source.indexOf("]", unreleasedLink.start) + 1,
		);
		edits.push({
			at: unreleasedLink.start,
			remove: unreleasedLink.end - unreleasedLink.start,
			text: `${label}: ${REPOSITORY_URL}/compare/${tagName(pkg, to)}...HEAD\n${definition}`,
		});
	} else {
		const first = changelog.links.find((link) => isVersion(link.label));
		if (first) {
			edits.push({ at: first.start, remove: 0, text: `${definition}\n` });
		} else {
			const ending = source.endsWith("\n") ? "" : "\n";
			edits.push({
				at: source.length,
				remove: 0,
				text: `${ending}\n${definition}\n`,
			});
		}
	}
	edits.push({
		at: unreleased.headingEnd,
		remove: 0,
		text: `\n\n## ${releaseHeading(to, date)}`,
	});

	let result = source;
	for (const edit of edits.sort((a, b) => b.at - a.at)) {
		result =
			result.slice(0, edit.at) +
			edit.text +
			result.slice(edit.at + edit.remove);
	}
	return result;
}

/** Writes each changelog, then sets each package's version. */
export function applyReleases(input: ApplyInput): void {
	const setVersion = input.setVersion ?? pnpmVersion;
	for (const release of input.releases) {
		writeFileSync(join(input.root, release.pkg.changelog), release.changelog);
	}
	for (const release of input.releases) {
		setVersion({
			directory: join(input.root, release.pkg.directory),
			version: release.to,
		});
	}
}

/**
 * `pnpm version <x.y.z>` in the package folder. `--no-git-tag-version`
 * stops it committing and tagging; `--no-git-checks` lets it run on the
 * tree the changelog edits (and an earlier bump) leave unclean.
 */
function pnpmVersion(input: {
	readonly directory: string;
	readonly version: string;
}): void {
	if (!isVersion(input.version)) {
		throw new ReleaseError(`Not a version: ${input.version}`);
	}
	// One command line through the shell, since Windows starts pnpm.cmd only
	// that way. The version was checked above, so nothing needs quoting.
	execSync(
		`pnpm version ${input.version} --no-git-tag-version --no-git-checks`,
		{ cwd: input.directory, stdio: ["ignore", "ignore", "inherit"] },
	);
}
