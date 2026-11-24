// Reads a Keep a Changelog file into its sections, subsections and entries.
// The release scripts and the site's changelog page share it, so the
// release text and the page read lead-ins the same way. It imports no file
// of its own: the site type-checks it with the site's settings.
import type { Heading, ListItem, RootContent, Strong } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";

/** A parsed changelog. Positions are offsets into `source`. */
export interface Changelog {
	readonly source: string;
	/** The `## [Unreleased]` section, when there is one. */
	readonly unreleased: ChangelogSection | undefined;
	/** Every other `##` section, in file order (newest first). */
	readonly releases: readonly ChangelogSection[];
	/** The link reference definitions: `[1.4.0]: https://…`. */
	readonly links: readonly ChangelogLink[];
}

/** A `##` section and everything up to the next `#` or `##` heading. */
export interface ChangelogSection {
	/** The heading text without `## `, such as `[1.4.0] - 2026-11-24`. */
	readonly heading: string;
	/** The 1-based line of the heading. */
	readonly line: number;
	/** The version at the start of the heading, if any (`1.0.0-rc.2`). */
	readonly version: string | undefined;
	/** The first body node when it is a paragraph, as Markdown on one line. */
	readonly intro: string | undefined;
	/** The entries, grouped by `###` heading. */
	readonly groups: readonly ChangelogGroup[];
	/** The Markdown between the heading and the next section, trimmed. */
	readonly markdown: string;
	/** Where the heading ends (offset). */
	readonly headingEnd: number;
	/** Where the next section starts, or the end of the file (offset). */
	readonly end: number;
}

/** The entries under one `###` heading, or before any (`heading` ""). */
export interface ChangelogGroup {
	readonly heading: string;
	readonly entries: readonly ChangelogEntry[];
}

/** One top-level list item. */
export interface ChangelogEntry {
	/** The bold text it opens with, as Markdown on one line, without `**`. */
	readonly leadIn: string | undefined;
	/** The 1-based line it starts on. */
	readonly line: number;
}

/** A link reference definition. */
export interface ChangelogLink {
	/** The label as written: `1.4.0`, `Unreleased`. */
	readonly label: string;
	readonly url: string;
	/** The 1-based line. */
	readonly line: number;
	/** Where the definition starts and ends (offsets). */
	readonly start: number;
	readonly end: number;
}

const UNRELEASED = /^\[?unreleased\]?$/i;
const VERSION = /^\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/;

/** Parses a changelog. It never throws on an odd section. */
export function parseChangelog(source: string): Changelog {
	const nodes = fromMarkdown(source).children;
	let unreleased: ChangelogSection | undefined;
	const releases: ChangelogSection[] = [];
	const links: ChangelogLink[] = [];

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		if (node?.type === "definition") {
			links.push({
				label: node.label ?? node.identifier,
				url: node.url,
				line: node.position?.start.line ?? 0,
				start: node.position?.start.offset ?? 0,
				end: node.position?.end.offset ?? 0,
			});
			continue;
		}
		if (node?.type !== "heading" || node.depth !== 2) continue;

		let end = i + 1;
		while (end < nodes.length && !isSectionBreak(nodes[end])) end++;
		const section = readSection(
			source,
			node,
			nodes.slice(i + 1, end),
			nodes[end],
		);
		if (UNRELEASED.test(section.heading)) unreleased ??= section;
		else releases.push(section);
	}

	return { source, unreleased, releases, links };
}

function readSection(
	source: string,
	heading: Heading,
	body: RootContent[],
	next: RootContent | undefined,
): ChangelogSection {
	const text = collapse(sliceInner(source, heading));
	const first = body[0];
	const groups: { heading: string; entries: ChangelogEntry[] }[] = [];
	let group: { heading: string; entries: ChangelogEntry[] } | undefined;

	for (const node of body) {
		if (node.type === "heading" && node.depth === 3) {
			group = { heading: collapse(sliceInner(source, node)), entries: [] };
			groups.push(group);
			continue;
		}
		if (node.type !== "list") continue;
		if (!group) {
			group = { heading: "", entries: [] };
			groups.push(group);
		}
		for (const item of node.children) {
			group.entries.push({
				leadIn: readLeadIn(source, item),
				line: item.position?.start.line ?? 0,
			});
		}
	}

	const headingEnd = heading.position?.end.offset ?? 0;
	const end = next?.position?.start.offset ?? source.length;
	return {
		heading: text,
		line: heading.position?.start.line ?? 0,
		version: VERSION.exec(text)?.[1],
		intro:
			first?.type === "paragraph" ? collapse(slice(source, first)) : undefined,
		groups,
		markdown: source.slice(headingEnd, end).trim(),
		headingEnd,
		end,
	};
}

/** The bold text an entry opens with, or undefined when it has none. */
function readLeadIn(source: string, item: ListItem): string | undefined {
	const paragraph = item.children[0];
	if (paragraph?.type !== "paragraph") return undefined;
	const strong = paragraph.children[0];
	if (strong?.type !== "strong" || strong.children.length === 0) {
		return undefined;
	}
	const text = collapse(sliceInner(source, strong));
	return text === "" ? undefined : text;
}

/** A new `#` or `##` heading ends a section. */
function isSectionBreak(node: RootContent | undefined): boolean {
	return node?.type === "heading" && node.depth <= 2;
}

/** The source text of a node. */
function slice(source: string, node: RootContent): string {
	return source.slice(node.position?.start.offset, node.position?.end.offset);
}

/** The source text of a node's children, without its own markers. */
function sliceInner(source: string, node: Heading | Strong): string {
	const first = node.children[0];
	const last = node.children.at(-1);
	if (!first || !last) return "";
	return source.slice(first.position?.start.offset, last.position?.end.offset);
}

/** Joins wrapped lines into one: "a\n  b" becomes "a b". */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
