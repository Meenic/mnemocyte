import { describe, expect, it } from "vitest";
import { markdownToHast, repoLink } from "./markdown";

describe("repoLink", () => {
  it("points relative links at the file on GitHub", () => {
    expect(repoLink("docs/guide/upgrading.md#11--12")).toBe(
      "https://github.com/Meenic/mnemocyte/blob/main/docs/guide/upgrading.md#11--12",
    );
    expect(repoLink("./README.md")).toBe(
      "https://github.com/Meenic/mnemocyte/blob/main/README.md",
    );
  });

  it("keeps absolute links and anchors", () => {
    expect(repoLink("https://semver.org/")).toBe("https://semver.org/");
    expect(repoLink("#stability")).toBe("#stability");
  });
});

describe("markdownToHast", () => {
  it("unwraps a single paragraph when inline", () => {
    const tree = markdownToHast({ markdown: "Use `migrate`.", inline: true });
    expect(tree.children.map((c) => c.type)).toEqual([
      "text",
      "element",
      "text",
    ]);
  });

  it("keeps blocks and rewrites links", () => {
    const tree = markdownToHast({ markdown: "See [api](docs/guide/api.md)." });
    const [paragraph] = tree.children;
    expect(paragraph).toMatchObject({ type: "element", tagName: "p" });
    expect(paragraph.type === "element" && paragraph.children[1]).toMatchObject(
      {
        tagName: "a",
        properties: {
          href: "https://github.com/Meenic/mnemocyte/blob/main/docs/guide/api.md",
        },
      },
    );
  });
});
