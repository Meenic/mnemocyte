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
//
// Links are read per paragraph, so a code span or link may wrap. GitHub's
// docs say the text of a relative link must stay on one line, so a wrapped
// one fails.
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
const wrappedCodeSpan = /(`+)([\s\S]+?)\1/g;
// A list item, table row or heading starts a new block, so a code span
// cannot run into it.
const blockStart = /^\s*(?:[-*+]\s|\d+[.)]\s|\||#{1,6}(?:\s|$))/;

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

// Yields [first line number, text] for each run of adjacent non-blank
// prose lines, joined with "\n".
function* blocks(text) {
	let start = 0;
	let lines = [];
	for (const [number, line] of proseLines(text)) {
		const blank = line.trim() === "";
		if (
			lines.length > 0 &&
			(blank || number !== start + lines.length || blockStart.test(line))
		) {
			yield [start, lines.join("\n")];
			lines = [];
		}
		if (!blank) {
			if (lines.length === 0) start = number;
			lines.push(line);
		}
	}
	if (lines.length > 0) yield [start, lines.join("\n")];
}

// The index of the "[" that opens the link text ending at `end`, or -1.
function textStart(block, end) {
	let depth = 0;
	for (let i = end - 1; i >= 0; i -= 1) {
		if (block[i] === "]") depth += 1;
		else if (block[i] === "[") {
			if (depth === 0) return i;
			depth -= 1;
		}
	}
	return -1;
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
	for (const [index, [number, line]] of lines.entries()) {
		const atx = line.match(/^ {0,3}#{1,6}(?:\s+(.*))?$/);
		const next = lines[index + 1];
		const setext =
			!atx &&
			line.trim() !== "" &&
			next?.[0] === number + 1 &&
			/^ {0,3}(=+|-+)\s*$/.test(next[1]);
		if (atx) anchors.add(slugger.slug(headingText(atx[1] ?? "")));
		else if (setext) anchors.add(slugger.slug(headingText(line)));
		for (const custom of line.matchAll(/<a\s[^>]*\b(?:id|name)="([^"]+)"/g)) {
			anchors.add(custom[1]);
		}
	}
	anchorCache.set(file, anchors);
	return anchors;
}

const inlineLink = /\]\(\s*(?:<([^>\n]*)>|([^)\s]+))/g;
const definition = /^ {0,3}\[[^\]^][^\]]*\]:\s*(?:<([^>]*)>|(\S+))/;
const external = /^[a-z][a-z0-9+.-]*:|^\/\//i;

function decode(text) {
	try {
		return decodeURIComponent(text);
	} catch {
		return null;
	}
}

function check(file, href) {
	const hash = href.indexOf("#");
	const path = (hash === -1 ? href : href.slice(0, hash)).replace(/\?.*$/, "");
	const fragment = hash === -1 ? "" : decode(href.slice(hash + 1));
	if (fragment === null) return `${href}: invalid percent-encoding`;
	let target = file;
	if (path !== "") {
		const decoded = decode(path);
		if (decoded === null) return `${href}: invalid percent-encoding`;
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
	if (!anchorsOf(target).has(fragment)) {
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
	for (const [start, block] of blocks(text)) {
		// Blank code spans but keep their line breaks, so offsets and line
		// numbers stay put.
		const prose = block.replace(wrappedCodeSpan, (span) =>
			span.replace(/[^\n]/g, " "),
		);
		const found = [];
		for (const match of prose.matchAll(inlineLink)) {
			const open = textStart(prose, match.index);
			found.push({
				href: match[1] ?? match[2],
				index: match.index,
				wrapped: open !== -1 && prose.slice(open, match.index).includes("\n"),
			});
		}
		let offset = 0;
		for (const line of prose.split("\n")) {
			const def = line.match(definition);
			if (def) found.push({ href: def[1] ?? def[2], index: offset });
			offset += line.length + 1;
		}
		for (const { href, index, wrapped } of found) {
			if (external.test(href)) continue;
			links += 1;
			const problem = wrapped
				? `${href}: the link text spans lines; GitHub needs it on one line`
				: check(file, href);
			if (problem) {
				broken += 1;
				const line = start + prose.slice(0, index).split("\n").length - 1;
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
