// pnpm release:notes <package> [<version>]
import { releaseNotes } from "../notes.ts";
import { PACKAGES } from "../packages.ts";
import { findPackage } from "../release.ts";
import { ROOT, run, usageError } from "./run.ts";

const USAGE = `Usage: pnpm release:notes <package> [<version>]

Prints the GitHub release text for a version, the package.json one by
default. Packages: ${PACKAGES.map((p) => p.name).join(", ")}.`;

run(USAGE, (positionals) => {
	const [name, version, ...rest] = positionals;
	if (name === undefined || rest.length > 0) return usageError(USAGE);
	const pkg = findPackage(PACKAGES, name);
	process.stdout.write(releaseNotes({ root: ROOT, pkg, version }));
	return 0;
});
