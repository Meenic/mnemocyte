// Checks that relative links and #anchors in the repository's Markdown point
// at files and headings that exist. Run through `pnpm test:links`.
//
// Files come from `git ls-files` (tracked, plus untracked files that are not
// ignored), so a link to a gitignored file such as dist/ fails here as it
// would on GitHub, and paths compare case-sensitively on every OS.
//
// Heading anchors follow GitHub's rules through github-slugger: lowercase,
// spaces to hyphens, other punctuation dropped, and "-1", "-2" for repeated
// headings ("## 1.0 → 1.1" is #10--11). `<a id>` and `<a name>` tags add
// custom anchors, which GitHub leaves out of that numbering.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const checked = [
	/^README\.md$/,
	/^CHANGELOG\.md$/,
	/^CONTRIBUTING\.md$/,
	/^SECURITY\.md$/,
	/^AGENTS\.md$/,
	/^examples\/README\.md$/,
	/^docs\/.+\.md$/,
];

const files = new Set(
	execFileSync(
		"git",
		["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		{ cwd: root, encoding: "utf8" },
	)
		.split("\0")
		.filter((file) => file !== "" && existsSync(join(root, file))),
);
const dirs = new Set();
for (const file of files) {
	for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) {
		dirs.add(dir);
	}
}

const fence = /^\s*(`{3,}|~{3,})/;
const codeSpan = /(`+)(.+?)\1/g;

// Yields each line outside fenced code blocks with its 1-based number.
function* proseLines(text) {
	let open = "";
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		const marker = line.match(fence)?.[1];
		if (open === "") {
			if (marker) open = marker;
			else yield [index + 1, line];
		} else if (
			marker &&
			marker[0] === open[0] &&
			marker.length >= open.length &&
			line.trim() === marker
		) {
			open = "";
		}
	}
}

// The text GitHub slugs for a heading: markup removed, code spans kept.
function headingText(raw) {
	const parts = raw.replace(/\s+#+\s*$/, "").split(codeSpan);
	let text = "";
	// split() with one capture group gives [prose, ticks, code, prose, …].
	for (let i = 0; i < parts.length; i += 3) {
		text += parts[i]
			.replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])?/g, "$1")
			.replace(/<[^>]+>/g, "")
			.replace(/(^|[^\p{L}\p{N}])[*_]+(?=\S)/gu, "$1")
			.replace(/(?<=\S)[*_]+(?=[^\p{L}\p{N}]|$)/gu, "")
			.replace(/\\(\p{P})/gu, "$1");
		if (i + 2 < parts.length) text += parts[i + 2].trim();
	}
	return text.trim();
}

const anchorCache = new Map();

function anchorsOf(file) {
	let anchors = anchorCache.get(file);
	if (anchors) return anchors;
	anchors = new Set();
	const slugger = new GithubSlugger();
	const lines = [...proseLines(readFileSync(join(root, file), "utf8"))];
	for (const [index, [, line]] of lines.entries()) {
		const atx = line.match(/^ {0,3}#{1,6}(?:\s+(.*))?$/);
		const setext =
			!atx &&
			line.trim() !== "" &&
			/^ {0,3}(=+|-+)\s*$/.test(lines[index + 1]?.[1] ?? "");
		if (atx) anchors.add(slugger.slug(headingText(atx[1] ?? "")));
		else if (setext) anchors.add(slugger.slug(headingText(line)));
		for (const custom of line.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) {
			anchors.add(custom[1]);
		}
	}
	anchorCache.set(file, anchors);
	return anchors;
}

const inlineLink = /\]\(\s*(?:<([^>]*)>|([^)\s]+))/g;
const definition = /^ {0,3}\[[^\]^][^\]]*\]:\s*(?:<([^>]*)>|(\S+))/;

function check(file, href) {
	if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) return null;
	const hash = href.indexOf("#");
	const path = (hash === -1 ? href : href.slice(0, hash)).replace(/\?.*$/, "");
	const fragment = hash === -1 ? "" : href.slice(hash + 1);
	let target = file;
	if (path !== "") {
		const decoded = decodeURIComponent(path);
		target = decoded.startsWith("/")
			? posix.normalize(decoded.slice(1))
			: posix.join(posix.dirname(file), decoded);
		target = target.replace(/\/$/, "");
		if (target === "" || target === ".") return null;
		if (!files.has(target) && !dirs.has(target)) {
			return `${href}: ${target} does not exist or is gitignored`;
		}
	}
	if (fragment === "" || !files.has(target) || !target.endsWith(".md")) {
		return null;
	}
	if (!anchorsOf(target).has(decodeURIComponent(fragment))) {
		return `${href}: ${target} has no heading or anchor #${fragment}`;
	}
	return null;
}

const markdown = [...files]
	.filter((file) => checked.some((pattern) => pattern.test(file)))
	.sort();
let links = 0;
let broken = 0;

for (const file of markdown) {
	const text = readFileSync(join(root, file), "utf8");
	for (const [line, content] of proseLines(text)) {
		const prose = content.replace(codeSpan, (span) => " ".repeat(span.length));
		const hrefs = [...prose.matchAll(inlineLink)].map((m) => m[1] ?? m[2]);
		const def = prose.match(definition);
		if (def) hrefs.push(def[1] ?? def[2]);
		for (const href of hrefs) {
			if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
			links += 1;
			const problem = check(file, href);
			if (problem) {
				broken += 1;
				console.error(`${file}:${line}: ${problem}`);
			}
		}
	}
}

if (markdown.length === 0) {
	console.error("No Markdown files found to check.");
	process.exitCode = 1;
} else if (broken > 0) {
	console.error(`${broken} of ${links} relative links are broken.`);
	process.exitCode = 1;
} else {
	console.log(
		`${markdown.length} Markdown files: ${links} relative links resolve.`,
	);
}
