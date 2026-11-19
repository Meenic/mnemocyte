import type { Element, ElementContent, Root } from "hast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toHast } from "mdast-util-to-hast";
import { REPO_URL } from "./site";

/**
 * Turns Markdown from the repository into a hast tree. Relative links
 * (`docs/guide/api.md#stability`) point at the file on GitHub. With
 * `inline`, a single paragraph is unwrapped so the result fits inside a
 * heading or a list item.
 */
export function markdownToHast({
  markdown,
  inline = false,
}: {
  markdown: string;
  inline?: boolean;
}): Root {
  const tree = toHast(fromMarkdown(markdown));
  const root: Root =
    tree.type === "root" ? tree : { type: "root", children: [tree] };
  for (const child of root.children) rewriteLinks(child);

  const only = root.children.filter(
    (child) => !(child.type === "text" && child.value.trim() === ""),
  );
  if (inline && only.length === 1) {
    const [paragraph] = only;
    if (paragraph.type === "element" && paragraph.tagName === "p") {
      return { type: "root", children: paragraph.children };
    }
  }
  return root;
}

/** A link in the repository's Markdown, as a URL that works on the site. */
export function repoLink(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const path = href.replace(/^\.?\//, "");
  return `${REPO_URL}/blob/main/${path}`;
}

function rewriteLinks(node: Root["children"][number] | ElementContent): void {
  if (node.type !== "element") return;
  if (isLink(node)) {
    node.properties.href = repoLink(node.properties.href);
  }
  for (const child of node.children) rewriteLinks(child);
}

function isLink(
  node: Element,
): node is Element & { properties: { href: string } } {
  return node.tagName === "a" && typeof node.properties.href === "string";
}
