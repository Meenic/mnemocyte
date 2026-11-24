// pnpm release:check
import { checkReleases } from "../check.ts";
import { PACKAGES } from "../packages.ts";
import { ROOT, run, usageError } from "./run.ts";

const USAGE = `Usage: pnpm release:check

Checks each package's changelog: the package.json version has its heading
and link, and every entry opens with a bold lead-in that ends with a period.`;

run(USAGE, (positionals) => {
	if (positionals.length > 0) return usageError(USAGE);
	const problems = checkReleases({ root: ROOT, packages: PACKAGES });
	for (const problem of problems) console.error(problem);
	if (problems.length > 0) return 1;
	console.log(`Changelogs ok: ${PACKAGES.map((p) => p.name).join(", ")}`);
	return 0;
});
