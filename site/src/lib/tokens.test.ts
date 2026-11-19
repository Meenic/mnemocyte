import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseColorTokens } from "./tokens";

describe("parseColorTokens", () => {
  it("reads hex tokens and keeps the first definition", () => {
    const css =
      ":root { --ink: #111311; --gap: 8px; }\n@media (x) { :root { --ink: #000; } }";
    expect(parseColorTokens(css)).toEqual({ ink: "#111311" });
  });

  it("finds the colors the Open Graph image needs in globals.css", () => {
    const css = readFileSync(
      new URL("../app/globals.css", import.meta.url),
      "utf8",
    );
    const tokens = parseColorTokens(css);
    for (const name of ["bg", "ink", "primary", "cell-grain", "cell-link"]) {
      expect(tokens[name]).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
