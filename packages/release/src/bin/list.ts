// node packages/release/src/bin/list.ts
// Prints the published packages at their package.json versions as JSON,
// for release.yml's plan job. It runs before `pnpm install`, so it imports
// only packages.ts (which imports nothing) and Node's own modules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGES, releaseTitle, tagName } from "../packages.ts";

const root = join(import.meta.dirname, "..", "..", "..", "..");

const list = PACKAGES.map((pkg) => {
	const file = join(root, pkg.directory, "package.json");
	const { version } = JSON.parse(readFileSync(file, "utf8")) as {
		version: string;
	};
	return {
		name: pkg.name,
		directory: pkg.directory,
		version,
		tag: tagName(pkg, version),
		title: releaseTitle(pkg, version),
		// A prerelease is never the repository's latest release.
		latest: pkg.latest && !version.includes("-"),
	};
});

process.stdout.write(`${JSON.stringify(list)}\n`);
