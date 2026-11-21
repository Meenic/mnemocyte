// Copies the repository's README.md and LICENSE into the package folder
// before `pnpm pack` and `pnpm publish` (the `prepack` script). Both copies
// are gitignored and rewritten on every pack; the root README.md is the one
// to edit. They are not removed afterwards: `pnpm pack --dry-run` runs
// `prepack` but not `postpack`.
//
// GitHub shows the README from the repository root, where relative links
// such as docs/guide/api.md resolve. npm shows the copy in the tarball, and
// how npmjs.com resolves relative links is not documented, so the copy turns
// every relative link into a GitHub URL on main, like the links in src/.
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(packageDir, "..", "..");
const readme = join(packageDir, "README.md");
const license = join(packageDir, "LICENSE");
const base = "https://github.com/Meenic/mnemocyte/blob/main/";

const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const fence = /^\s*(`{3,}|~{3,})/;

// A relative link from the root README → its GitHub URL.
function absolute(href) {
	if (external.test(href)) return href;
	const path = posix.normalize(href.replace(/^\//, ""));
	if (path.startsWith("..")) {
		throw new Error(`README.md links outside the repository: ${href}`);
	}
	return `${base}${path}`;
}

let open = "";
const lines = readFileSync(join(root, "README.md"), "utf8")
	.split(/\r?\n/)
	.map((line) => {
		const marker = line.match(fence)?.[1];
		if (open !== "") {
			if (marker && marker[0] === open[0] && marker.length >= open.length) {
				open = "";
			}
			return line;
		}
		if (marker) {
			open = marker;
			return line;
		}
		return line
			.replace(/\]\(\s*(<[^>\n]*>|[^)\s]+)/g, (_match, href) =>
				href.startsWith("<")
					? `](<${absolute(href.slice(1, -1))}>`
					: `](${absolute(href)}`,
			)
			.replace(
				/^( {0,3}\[[^\]^][^\]]*\]:\s*)(\S+)/,
				(_match, label, href) => `${label}${absolute(href)}`,
			);
	});

writeFileSync(readme, lines.join("\n"));
copyFileSync(join(root, "LICENSE"), license);
