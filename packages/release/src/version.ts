// Semantic versions, as far as the release scripts need them: parse,
// compare, and bump by patch, minor or major.

export type Bump = "patch" | "minor" | "major";

interface Parsed {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	/** The prerelease identifiers (`rc.1` → ["rc", "1"]), empty for none. */
	readonly prerelease: readonly string[];
}

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** Whether `version` is a semantic version without build metadata. */
export function isVersion(version: string): boolean {
	return SEMVER.test(version);
}

function parse(version: string): Parsed {
	const match = SEMVER.exec(version);
	if (!match) throw new Error(`Not a semantic version: ${version}`);
	return {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease: match[4] === undefined ? [] : match[4].split("."),
	};
}

/** Negative when a < b, 0 when equal, positive when a > b (semver order). */
export function compareVersions(a: string, b: string): number {
	const x = parse(a);
	const y = parse(b);
	const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch || 0;
	if (core !== 0) return core;
	// A prerelease sorts before its release: 1.0.0-rc.2 < 1.0.0.
	if (x.prerelease.length === 0 || y.prerelease.length === 0) {
		return y.prerelease.length - x.prerelease.length;
	}
	for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
		const p = x.prerelease[i];
		const q = y.prerelease[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		const pn = /^\d+$/.test(p);
		const qn = /^\d+$/.test(q);
		if (pn && qn) return Number(p) - Number(q);
		if (pn) return -1;
		if (qn) return 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

/**
 * The next version, as `pnpm version <bump>` computes it: a prerelease
 * moves to its own release when that is the bump (`1.5.0-rc.1` with minor
 * is `1.5.0`).
 */
export function bumpVersion(version: string, bump: Bump): string {
	const { major, minor, patch, prerelease } = parse(version);
	const pre = prerelease.length > 0;
	switch (bump) {
		case "major":
			return pre && minor === 0 && patch === 0
				? `${major}.0.0`
				: `${major + 1}.0.0`;
		case "minor":
			return pre && patch === 0
				? `${major}.${minor}.0`
				: `${major}.${minor + 1}.0`;
		case "patch":
			return pre
				? `${major}.${minor}.${patch}`
				: `${major}.${minor}.${patch + 1}`;
	}
}
