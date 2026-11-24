// pnpm release:prepare <package>[@<version|patch|minor|major>] ...
import { PACKAGES, tagName } from "../packages.ts";
import { applyReleases, parseRequest, planReleases } from "../prepare.ts";
import { ROOT, run, today, usageError } from "./run.ts";

const USAGE = `Usage: pnpm release:prepare <package>[@<version|patch|minor|major>] ...

Bumps each package and moves its [Unreleased] entries under the new
version. Without @, the version is minor for an Added or Deprecated
section, else patch; a **Breaking** entry needs the version named.
Packages: ${PACKAGES.map((p) => p.name).join(", ")}.`;

run(USAGE, (positionals) => {
	if (positionals.length === 0) return usageError(USAGE);
	const releases = planReleases({
		root: ROOT,
		packages: PACKAGES,
		requests: positionals.map(parseRequest),
		date: today(),
	});
	applyReleases({ root: ROOT, releases });
	for (const r of releases) {
		console.log(`${r.pkg.name} ${r.from} -> ${r.to} (${r.reason})`);
	}
	const tags = releases.map((r) => tagName(r.pkg, r.to));
	console.log("");
	console.log(`Branch:   chore/release-${tags[0] ?? ""}`);
	console.log(`PR title: chore(release): ${tags.join(", ")}`);
	return 0;
});
